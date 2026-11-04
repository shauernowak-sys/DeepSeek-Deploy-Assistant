import { join } from 'node:path';

import { createProfileBackup, listProfileBackups, PROFILE_REBUILD_ARGS } from '@dda/core';
import { BASELINE } from '@dda/spec';
import type {
  PluginState,
  ProfileBackupSummary,
  ProfileRecoveryPreview,
  ProfileRecoveryResult,
} from '@dda/spec';

import type { Container } from './container';

/**
 * §21.10 / R5：「回到上一可用」的入口。
 *
 * D08 已经提供文件级备份与原子恢复（`profile-backup.ts`），但那只是能力；
 * 本服务把它接成用户可操作的入口，并把三条硬规则落在这里：
 *
 * 1. **先预览再确认**：恢复会覆盖 profile 的 4 个声明文件并重建依赖，属于高风险动作；
 * 2. **恢复前先打保险备份**：让"恢复"本身也可反悔，而不是单向覆盖；
 * 3. **不伪造结果**：pnpm 不可用时如实说明"文件已还原，但依赖未重建"，不报成功。
 */

export interface ProfileRecoveryDeps {
  container: Container;
  /** 生产用 `HarnessService.restoreProfile`（还原 + 按 lockfile 重建 + 重新 list）。 */
  restore: (backupDir: string) => Promise<{ restored: string[]; plugins: PluginState[] }>;
  listPlugins: () => Promise<PluginState[]>;
  /** Harness 进程是否还在跑（profile 里的文件会被占用）。 */
  isHarnessRunning: () => boolean;
  /** pnpm CLI 是否可用；不可用时恢复只还原文件。 */
  hasPnpm: () => Promise<boolean>;
  now?: () => Date;
}

export interface RestoreProfileInput {
  id?: string;
  confirmed: boolean;
}

function profileDirOf(container: Container): string {
  return join(container.paths.dshHome, 'profiles', BASELINE.dsh.profile);
}

function toSummary(backups: Awaited<ReturnType<typeof listProfileBackups>>): ProfileBackupSummary[] {
  return backups.map((backup, index) => ({
    id: backup.createdAt,
    createdAt: backup.createdAt,
    files: [...backup.files],
    missing: [...backup.missing],
    isLatest: index === 0,
  }));
}

function toPlugins(plugins: readonly PluginState[]): Array<{ name: string; version?: string }> {
  return plugins.map((plugin) => ({
    name: plugin.name,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
  }));
}

export class ProfileRecoveryService {
  constructor(private readonly deps: ProfileRecoveryDeps) {}

  private async backups(): Promise<ProfileBackupSummary[]> {
    return toSummary(await listProfileBackups(this.deps.container.paths.stateBackups));
  }

  async preview(): Promise<ProfileRecoveryPreview> {
    const { container } = this.deps;
    const backups = await this.backups();
    const plugins = await this.deps.listPlugins().catch(() => []);
    const hasPnpm = await this.deps.hasPnpm();

    const warnings: string[] = [];
    if (backups.length === 0) {
      warnings.push(
        '还没有 profile 备份：完成一次插件安装（或版本切换）后才会留下备份；在此之前没有可回退的状态。',
      );
    } else {
      warnings.push(
        '恢复会用备份里的 4 个声明文件覆盖当前 profile，并按备份的 lockfile 重建依赖；请先停止 Harness。',
      );
    }
    if (!hasPnpm) {
      warnings.push('本机没有可用的 pnpm：恢复只能还原文件，依赖需要你手工重建。');
    }
    if (this.deps.isHarnessRunning()) {
      warnings.push('Harness 正在运行，profile 文件可能被占用；建议先在「Harness」页停止它。');
    }
    const latest = backups[0];
    if (latest !== undefined && latest.missing.length > 0) {
      warnings.push(
        `最近备份里没有 ${latest.missing.join('、')}（备份时即不存在），恢复后这些文件保持现状。`,
      );
    }
    warnings.push('官方 Desktop 的 desktop profile 永不备份、永不恢复。');

    return {
      available: backups.length > 0,
      backups,
      ...(latest === undefined ? {} : { latestId: latest.id }),
      currentPlugins: toPlugins(plugins),
      rebuild: { willRun: hasPnpm, command: `pnpm ${PROFILE_REBUILD_ARGS.join(' ')}` },
      warnings,
      dataDir: container.paths.root,
    };
  }

  async restore(input: RestoreProfileInput): Promise<ProfileRecoveryResult> {
    const { container } = this.deps;
    const current = async (): Promise<Array<{ name: string; version?: string }>> =>
      toPlugins(await this.deps.listPlugins().catch(() => []));

    if (!input.confirmed) {
      return {
        ok: false,
        message: '恢复 profile 需要二次确认，本次没有改动任何文件',
        restored: [],
        plugins: await current(),
      };
    }

    const backups = await listProfileBackups(container.paths.stateBackups);
    if (backups.length === 0) {
      return {
        ok: false,
        message: '没有可用的 profile 备份，未做任何改动',
        restored: [],
        plugins: await current(),
      };
    }

    // `id` 省略表示"最近一份"；显式 id 找不到时**不**静默退回最近一份。
    const target =
      input.id === undefined ? backups[0] : backups.find((backup) => backup.createdAt === input.id);
    if (target === undefined) {
      return {
        ok: false,
        message: `找不到备份 ${input.id ?? ''}；可能已被保留策略清理，请刷新后重试`,
        restored: [],
        plugins: await current(),
      };
    }
    if (!target.files.includes('package.json')) {
      return {
        ok: false,
        message: `备份 ${target.createdAt} 不完整（缺少 package.json），拒绝恢复；未做任何改动`,
        restored: [],
        plugins: await current(),
      };
    }

    let safetyBackup: string | undefined;
    try {
      // 关键：`keep` 取"现有份数 + 1"，否则新建的保险备份会把**即将使用的旧备份**挤出保留窗口。
      const safety = await createProfileBackup({
        profileDir: profileDirOf(container),
        backupsRoot: container.paths.stateBackups,
        keep: backups.length + 1,
        ...(this.deps.now === undefined ? {} : { now: this.deps.now() }),
      });
      safetyBackup = safety.dir;
      await container.logger.info(
        'plugin',
        `恢复到备份 ${target.createdAt}；恢复前状态已备份到 ${safety.dir}`,
      );
    } catch (error) {
      return {
        ok: false,
        message: `恢复前的保险备份失败，已中止（profile 未改动）：${error instanceof Error ? error.message : String(error)}`,
        restored: [],
        plugins: await current(),
      };
    }

    try {
      const result = await this.deps.restore(target.dir);
      await container.logger.info(
        'plugin',
        `profile 已恢复（${result.restored.join(', ')}），插件 ${result.plugins.length} 个`,
      );
      return {
        ok: true,
        message: `已回到备份 ${target.createdAt} 的状态；恢复前状态保留在 ${safetyBackup}`,
        restored: result.restored,
        safetyBackup,
        plugins: toPlugins(result.plugins),
      };
    } catch (error) {
      return {
        ok: false,
        message: `恢复失败：${error instanceof Error ? error.message : String(error)}；恢复前状态保留在 ${safetyBackup}`,
        restored: [],
        safetyBackup,
        plugins: await current(),
      };
    }
  }
}
