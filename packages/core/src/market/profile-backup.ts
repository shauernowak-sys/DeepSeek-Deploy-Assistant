import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { DdaError, ERROR_CODES } from '@dda/spec';

/**
 * D08：profile 文件级备份与恢复。
 *
 * 只备份**声明文件**，不碰 `node_modules`（可由 pnpm 重建）：
 * - `package.json`：插件依赖与 bundles 列表
 * - `pnpm-workspace.yaml`：allowBuilds 等 pnpm 设置
 * - `cordis.patch.yml`：我方与插件写入的补丁层（含 QQ 配置）
 * - `pnpm-lock.yaml`：有则备份
 *
 * 硬规则：
 * - **禁止** `--from-default-profile`（会把 bundles 列表重置成模板）；
 * - 恢复是**文件级还原**，不是目录级覆盖（避免删掉备份之后用户新增的东西）；
 * - 写入前先把备份与当前文件都读进内存，任一步失败就还原，不留半成品；
 * - `desktop` profile 属于官方桌面端，绝不备份/恢复。
 */

export const PROFILE_BACKUP_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
] as const;

export type ProfileBackupFile = (typeof PROFILE_BACKUP_FILES)[number];

/** 默认保留份数，与 API 配置备份一致（保留最近 3 份）。 */
export const PROFILE_BACKUP_RETENTION = 3;

export interface ProfileBackup {
  dir: string;
  createdAt: string;
  /** 实际复制到的文件。 */
  files: ProfileBackupFile[];
  /** 备份时不存在、因此没有备份的文件。 */
  missing: ProfileBackupFile[];
}

export interface CreateProfileBackupOptions {
  profileDir: string;
  backupsRoot: string;
  now?: Date;
  keep?: number;
}

function assertNotDesktop(profileDir: string): void {
  if (basename(profileDir).toLowerCase() === 'desktop') {
    throw new DdaError(
      ERROR_CODES.E_PROFILE_OWNED_BY_DESKTOP,
      'desktop profile 由官方桌面端独占，本软件不备份也不恢复它',
      '请在官方桌面端内操作',
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export async function createProfileBackup(options: CreateProfileBackupOptions): Promise<ProfileBackup> {
  assertNotDesktop(options.profileDir);

  if (!(await exists(join(options.profileDir, 'package.json')))) {
    throw new DdaError(
      ERROR_CODES.E_MANIFEST_INVALID,
      'profile 尚未初始化（缺少 package.json），无法备份',
      '先完成一次 Harness profile 准备再操作',
    );
  }

  const created = options.now ?? new Date();
  const dir = join(options.backupsRoot, `plugin-${stamp(created)}`);
  await mkdir(dir, { recursive: true });

  const files: ProfileBackupFile[] = [];
  const missing: ProfileBackupFile[] = [];
  for (const file of PROFILE_BACKUP_FILES) {
    const source = join(options.profileDir, file);
    if (await exists(source)) {
      await copyFile(source, join(dir, file));
      files.push(file);
    } else {
      missing.push(file);
    }
  }

  await pruneProfileBackups(options.backupsRoot, options.keep ?? PROFILE_BACKUP_RETENTION);
  return { dir, createdAt: created.toISOString(), files, missing };
}

export async function listProfileBackups(backupsRoot: string): Promise<ProfileBackup[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(backupsRoot);
  } catch {
    return [];
  }

  const backups: ProfileBackup[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('plugin-')) continue;
    const dir = join(backupsRoot, entry);
    const files: ProfileBackupFile[] = [];
    const missing: ProfileBackupFile[] = [];
    for (const file of PROFILE_BACKUP_FILES) {
      (await exists(join(dir, file))) ? files.push(file) : missing.push(file);
    }
    backups.push({
      dir,
      createdAt: entry.slice('plugin-'.length),
      files,
      missing,
    });
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function pruneProfileBackups(backupsRoot: string, keep: number): Promise<number> {
  const backups = await listProfileBackups(backupsRoot);
  let removed = 0;
  for (const backup of backups.slice(Math.max(keep, 1))) {
    await rm(backup.dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * 恢复文件之后必须重建依赖。实测（2026-11-04）：仅仅把文件放回去再跑
 * `pnpm install` 会被判为 "Already up to date"，`node_modules` 里仍然没有插件；
 * 必须加 `--force` 才会按还原后的 lockfile 重新链接。
 */
export const PROFILE_REBUILD_ARGS = ['install', '--offline', '--frozen-lockfile', '--force'] as const;

export interface RestoreOptions {
  /** 测试注入：写入/改名的真实实现，默认用 node:fs/promises。 */
  writeFileImpl?: (path: string, data: Buffer) => Promise<void>;
  renameImpl?: (from: string, to: string) => Promise<void>;
}

/**
 * 文件级恢复。先把备份内容与当前内容都读进内存，再逐个写入；
 * 任一写入失败都回滚到"调用前"的内容，因此不会留下半成品 profile。
 */
export async function restoreProfileBackup(
  backupDir: string,
  profileDir: string,
  options: RestoreOptions = {},
): Promise<{ restored: ProfileBackupFile[]; rebuildArgs: readonly string[] }> {
  assertNotDesktop(profileDir);

  if (!(await exists(join(backupDir, 'package.json')))) {
    throw new DdaError(
      ERROR_CODES.E_MANIFEST_INVALID,
      `备份不完整（缺少 package.json）：${backupDir}`,
      '重新生成备份后再恢复；本次没有改动 profile',
    );
  }

  // 先把备份读全：任何文件不可读都在写入之前失败，profile 保持原样。
  const fromBackup = new Map<ProfileBackupFile, Buffer>();
  for (const file of PROFILE_BACKUP_FILES) {
    const path = join(backupDir, file);
    if (!(await exists(path))) continue;
    fromBackup.set(file, await readFile(path));
  }

  const before = new Map<ProfileBackupFile, Buffer | undefined>();
  for (const file of PROFILE_BACKUP_FILES) {
    const path = join(profileDir, file);
    if (!(await exists(path))) {
      before.set(file, undefined);
      continue;
    }
    try {
      before.set(file, await readFile(path));
    } catch {
      throw new DdaError(
        ERROR_CODES.E_MANIFEST_INVALID,
        `profile 中的 ${file} 不是可读文件，拒绝恢复`,
        '先处理该路径（例如删除同名目录）再重试；本次没有改动 profile',
      );
    }
  }

  const write = options.writeFileImpl ?? writeFile;
  const move = options.renameImpl ?? rename;

  const written: ProfileBackupFile[] = [];
  try {
    for (const [file, content] of fromBackup) {
      const target = join(profileDir, file);
      const temp = `${target}.restore-tmp`;
      await write(temp, content);
      await move(temp, target);
      written.push(file);
    }
  } catch (error) {
    // 还原到调用前的内容（写回原 Buffer，或删除我们新建的文件）。
    for (const file of written) {
      const original = before.get(file);
      const target = join(profileDir, file);
      try {
        if (original === undefined) await rm(target, { force: true });
        else await writeFile(target, original);
      } catch {
        // 尽力而为；下面仍抛出原始错误
      }
    }
    throw new DdaError(
      ERROR_CODES.E_ROLLBACK_FAILED,
      `恢复 profile 失败，已尝试还原：${error instanceof Error ? error.message : String(error)}`,
      '确认 Harness 已关闭后重试；备份文件仍保留',
    );
  }

  return { restored: written, rebuildArgs: PROFILE_REBUILD_ARGS };
}
