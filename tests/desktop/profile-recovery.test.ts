import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths } from '@dda/adapters';
import { createProfileBackup, listProfileBackups, Logger } from '@dda/core';
import type { PluginState } from '@dda/spec';

import type { Container } from '../../apps/desktop/src/main/services/container';
import {
  ProfileRecoveryService,
  type ProfileRecoveryDeps,
} from '../../apps/desktop/src/main/services/profile-recovery-service';

/**
 * §21.10「回到上一可用」的接线测试。
 *
 * 重点不是"能恢复"，而是三条硬规则：
 * 1. 没确认就绝不动文件；2. 恢复前一定先打保险备份；3. 失败/找不到备份都如实报错，不静默兜底。
 */

const PROFILE_FILES = {
  'package.json': '{"name":"web-profile","v":1}',
  'pnpm-workspace.yaml': 'packages: []\n',
  'cordis.patch.yml': 'patches: []\n',
};

interface Fixture {
  service: ProfileRecoveryService;
  root: string;
  profileDir: string;
  backupsRoot: string;
  restoreCalls: string[];
  setHarnessRunning: (running: boolean) => void;
  setPnpm: (available: boolean) => void;
  setRestoreFailure: (message: string | undefined) => void;
  plugins: PluginState[];
}

async function fixture(): Promise<Fixture> {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-recovery-'));
  const paths = appPaths(localAppData);
  await mkdir(paths.logs, { recursive: true });
  const logger = await Logger.create(paths.logs, 'test.log');
  const container = { paths, logger } as unknown as Container;

  const profileDir = join(paths.dshHome, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  for (const [name, content] of Object.entries(PROFILE_FILES)) {
    await writeFile(join(profileDir, name), content);
  }

  let harnessRunning = false;
  let pnpm = true;
  let restoreFailure: string | undefined;
  const restoreCalls: string[] = [];
  const plugins: PluginState[] = [{ name: '@tencent-connect/dsh-qqbot', version: '0.5.5' } as PluginState];

  const deps: ProfileRecoveryDeps = {
    container,
    restore: async (backupDir) => {
      restoreCalls.push(backupDir);
      if (restoreFailure !== undefined) throw new Error(restoreFailure);
      // 模拟 HarnessService.restoreProfile：文件级还原 + 重建 + 重新 list。
      for (const name of Object.keys(PROFILE_FILES)) {
        await writeFile(join(profileDir, name), await readFile(join(backupDir, name), 'utf8'));
      }
      return { restored: Object.keys(PROFILE_FILES), plugins };
    },
    listPlugins: async () => plugins,
    isHarnessRunning: () => harnessRunning,
    hasPnpm: async () => pnpm,
  };

  return {
    service: new ProfileRecoveryService(deps),
    root: paths.root,
    profileDir,
    backupsRoot: paths.stateBackups,
    restoreCalls,
    setHarnessRunning: (running) => {
      harnessRunning = running;
    },
    setPnpm: (available) => {
      pnpm = available;
    },
    setRestoreFailure: (message) => {
      restoreFailure = message;
    },
    plugins,
  };
}

/** 打一份备份并返回**列表口径**的 id（目录名后缀，冒号被替换成短横）。 */
async function seedBackup(f: Fixture, at: string): Promise<string> {
  const backup = await createProfileBackup({
    profileDir: f.profileDir,
    backupsRoot: f.backupsRoot,
    now: new Date(at),
    keep: 10,
  });
  const listed = await listProfileBackups(f.backupsRoot);
  const match = listed.find((entry) => entry.dir === backup.dir);
  if (match === undefined) throw new Error(`备份未出现在列表里：${backup.dir}`);
  return match.createdAt;
}

describe('§21.10 回到上一可用：预览与恢复', () => {
  it('没有备份时明确不可用，且恢复请求被拒绝（不改任何文件）', async () => {
    const f = await fixture();
    const preview = await f.service.preview();
    expect(preview.available).toBe(false);
    expect(preview.backups).toEqual([]);
    expect(preview.warnings.join('\n')).toContain('还没有 profile 备份');

    const result = await f.service.restore({ confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('没有可用的 profile 备份');
    expect(result.restored).toEqual([]);
    expect(f.restoreCalls).toEqual([]);
    expect(await readFile(join(f.profileDir, 'package.json'), 'utf8')).toBe(PROFILE_FILES['package.json']);
  });

  it('没有 confirmed=true 时一律不恢复', async () => {
    const f = await fixture();
    await seedBackup(f, '2026-11-04T10:00:00.000Z');

    const result = await f.service.restore({ confirmed: false });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('二次确认');
    expect(f.restoreCalls).toEqual([]);
  });

  it('恢复前自动打保险备份，内容是恢复前的状态（恢复本身可反悔）', async () => {
    const f = await fixture();
    const backupId = await seedBackup(f, '2026-11-04T10:00:00.000Z');
    // 备份之后用户又改了 profile：这就是"当前状态"
    await writeFile(join(f.profileDir, 'package.json'), '{"name":"web-profile","v":2}');

    const result = await f.service.restore({ confirmed: true, id: backupId });
    expect(result.ok).toBe(true);
    expect(result.restored).toContain('package.json');
    expect(result.safetyBackup).toBeDefined();

    // 目标恢复生效
    expect(await readFile(join(f.profileDir, 'package.json'), 'utf8')).toBe(PROFILE_FILES['package.json']);
    // 保险备份保存的是恢复前（v2）的内容
    expect(await readFile(join(result.safetyBackup!, 'package.json'), 'utf8')).toContain('"v":2');
    expect(result.message).toContain('恢复前状态保留');
  });

  it('保险备份不会把即将用于恢复的旧备份挤出保留窗口', async () => {
    const f = await fixture();
    const oldest = await seedBackup(f, '2026-11-04T10:00:00.000Z');
    await writeFile(join(f.profileDir, 'package.json'), '{"name":"web-profile","v":2}');
    await seedBackup(f, '2026-11-04T11:00:00.000Z');
    await writeFile(join(f.profileDir, 'package.json'), '{"name":"web-profile","v":3}');
    await seedBackup(f, '2026-11-04T12:00:00.000Z');

    expect((await listProfileBackups(f.backupsRoot)).length).toBe(3);

    const result = await f.service.restore({ confirmed: true, id: oldest });
    expect(result.ok).toBe(true);
    // 恢复的是最早那份，说明保险备份没有把它挤掉
    expect(result.safetyBackup).toBeDefined();
    expect(await readFile(join(f.profileDir, 'package.json'), 'utf8')).toBe(PROFILE_FILES['package.json']);
  });

  it('显式 id 找不到时直接报错，不静默退回最近一份', async () => {
    const f = await fixture();
    await seedBackup(f, '2026-11-04T10:00:00.000Z');

    const result = await f.service.restore({ confirmed: true, id: 'plugin-不存在' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('找不到备份');
    expect(f.restoreCalls).toEqual([]);
  });

  it('恢复失败时如实报错，并指明保险备份位置', async () => {
    const f = await fixture();
    await seedBackup(f, '2026-11-04T10:00:00.000Z');
    f.setRestoreFailure('pnpm install 失败');

    const result = await f.service.restore({ confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('恢复失败');
    expect(result.message).toContain('恢复前状态保留在');
    expect(result.restored).toEqual([]);
    expect(result.safetyBackup).toBeDefined();
  });

  it('备份不完整（缺 package.json）时拒绝恢复', async () => {
    const f = await fixture();
    const id = await seedBackup(f, '2026-11-04T10:00:00.000Z');
    await rm(join(f.backupsRoot, `plugin-${id}`, 'package.json'));

    const result = await f.service.restore({ confirmed: true, id });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('不完整');
    expect(f.restoreCalls).toEqual([]);
  });

  it('预览包含影响面：备份列表、当前插件、重建命令与如实警告', async () => {
    const f = await fixture();
    const id = await seedBackup(f, '2026-11-04T10:00:00.000Z');
    f.setHarnessRunning(true);
    f.setPnpm(false);

    const preview = await f.service.preview();
    expect(preview.available).toBe(true);
    expect(preview.latestId).toBe(id);
    expect(preview.backups[0]?.isLatest).toBe(true);
    expect(preview.backups[0]?.files).toContain('package.json');
    expect(preview.currentPlugins).toEqual([{ name: '@tencent-connect/dsh-qqbot', version: '0.5.5' }]);
    expect(preview.rebuild.willRun).toBe(false);
    expect(preview.rebuild.command).toContain('--force');
    const warnings = preview.warnings.join('\n');
    expect(warnings).toContain('请先停止 Harness');
    expect(warnings).toContain('没有可用的 pnpm');
    expect(warnings).toContain('desktop profile');
    expect(preview.dataDir).toBe(f.root);
  });

  it('读取插件列表失败不影响预览（如实显示为空，而不是抛错）', async () => {
    const f = await fixture();
    await seedBackup(f, '2026-11-04T10:00:00.000Z');

    const otherRoot = await mkdtemp(join(tmpdir(), 'dda-recovery-b-'));
    const service = new ProfileRecoveryService({
      container: { paths: appPaths(otherRoot) } as unknown as Container,
      restore: async () => ({ restored: [], plugins: [] }),
      listPlugins: async () => {
        throw new Error('dsh plugin list 失败');
      },
      isHarnessRunning: () => false,
      hasPnpm: async () => true,
    });

    const preview = await service.preview();
    expect(preview.currentPlugins).toEqual([]);
    // 新目录没有备份，因此不可用：这是"如实"而不是"看起来可用"
    expect(preview.available).toBe(false);
  });
});
