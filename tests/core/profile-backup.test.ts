import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROFILE_BACKUP_FILES,
  createProfileBackup,
  listProfileBackups,
  restoreProfileBackup,
} from '@dda/core';
import { DdaError } from '@dda/spec';

async function makeProfile(root: string, contents = 'v1'): Promise<string> {
  const dir = join(root, 'profiles', 'web');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), `{"name":"profile","version":"${contents}"}`, 'utf8');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8');
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: im-qqbot\n  config: {}\n', 'utf8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', 'big.bin'), 'should never be copied', 'utf8');
  return dir;
}

describe('D08 profile 备份', () => {
  it('只备份声明文件，不碰 node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-backup-'));
    const profile = await makeProfile(root);
    const backupsRoot = join(root, 'state', 'backups');

    const backup = await createProfileBackup({ profileDir: profile, backupsRoot });

    expect(backup.files).toEqual(['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']);
    expect(backup.missing).toEqual(['pnpm-lock.yaml']);
    expect((await readdir(backup.dir)).sort()).toEqual(['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']);
    expect(await readdir(backup.dir)).not.toContain('node_modules');
  });

  it('按保留份数清理旧备份（默认与 API 配置一致：最近 3 份）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-backup-'));
    const profile = await makeProfile(root);
    const backupsRoot = join(root, 'state', 'backups');

    for (const minute of [1, 2, 3, 4]) {
      await createProfileBackup({
        profileDir: profile,
        backupsRoot,
        now: new Date(Date.UTC(2026, 10, 4, 10, minute)),
      });
    }

    const backups = await listProfileBackups(backupsRoot);
    expect(backups).toHaveLength(3);
    // 最新的在前
    expect(backups[0]?.createdAt).toContain('10-04');
  });

  it('profile 未初始化 → 拒绝（不会生成空备份）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-backup-'));
    const empty = join(root, 'profiles', 'web');
    await mkdir(empty, { recursive: true });

    await expect(
      createProfileBackup({ profileDir: empty, backupsRoot: join(root, 'state', 'backups') }),
    ).rejects.toThrowError(/尚未初始化/);
  });

  it('拒绝备份 desktop profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-backup-'));
    const desktop = join(root, 'profiles', 'desktop');
    await mkdir(desktop, { recursive: true });
    await writeFile(join(desktop, 'package.json'), '{}', 'utf8');

    await expect(
      createProfileBackup({ profileDir: desktop, backupsRoot: join(root, 'state', 'backups') }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_OWNED_BY_DESKTOP' });
  });
});

describe('D08 profile 恢复', () => {
  it('文件级还原：恢复后与备份时内容一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-restore-'));
    const profile = await makeProfile(root, 'before');
    const backupsRoot = join(root, 'state', 'backups');
    const backup = await createProfileBackup({ profileDir: profile, backupsRoot });

    // 模拟安装把他改坏
    await writeFile(join(profile, 'package.json'), '{"version":"broken"}', 'utf8');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: im-qqbot\n  config: { changed: true }\n', 'utf8');

    const result = await restoreProfileBackup(backup.dir, profile);

    expect(result.restored).toContain('package.json');
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toContain('before');
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('config: {}');
  });

  it('备份不完整（缺 package.json）→ 拒绝，且 profile 原样不动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-restore-'));
    const profile = await makeProfile(root, 'keep-me');
    const backupsRoot = join(root, 'state', 'backups');
    const backup = await createProfileBackup({ profileDir: profile, backupsRoot });
    await rm(join(backup.dir, 'package.json'));

    await expect(restoreProfileBackup(backup.dir, profile)).rejects.toThrowError(/备份不完整/);
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toContain('keep-me');
  });

  it('写入失败 → 回滚到调用前内容，不留半成品', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-restore-'));
    const profile = await makeProfile(root, 'original');
    const backupsRoot = join(root, 'state', 'backups');
    const backup = await createProfileBackup({ profileDir: profile, backupsRoot });

    // 模拟"写到第二个文件时失败"
    const error = await restoreProfileBackup(backup.dir, profile, {
      renameImpl: async (from, to) => {
        if (to.endsWith('cordis.patch.yml')) throw new Error('EPERM: 文件被占用');
        await rename(from, to);
      },
    }).catch((e: unknown) => e as DdaError);

    expect(error).toBeInstanceOf(DdaError);
    expect((error as DdaError).code).toBe('E_ROLLBACK_FAILED');
    // 先写的 package.json 已回滚到调用前的内容
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toContain('original');
  });

  it('profile 中同名路径是目录 → 拒绝恢复，且不改任何文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-restore-'));
    const profile = await makeProfile(root, 'untouched');
    const backupsRoot = join(root, 'state', 'backups');
    const backup = await createProfileBackup({ profileDir: profile, backupsRoot });

    await rm(join(profile, 'cordis.patch.yml'));
    await mkdir(join(profile, 'cordis.patch.yml'), { recursive: true });

    await expect(restoreProfileBackup(backup.dir, profile)).rejects.toMatchObject({
      code: 'E_MANIFEST_INVALID',
    });
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toContain('untouched');
  });

  it('拒绝恢复 desktop profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-restore-'));
    const profile = await makeProfile(root);
    const backupsRoot = join(root, 'state', 'backups');
    const backup = await createProfileBackup({ profileDir: profile, backupsRoot });

    await expect(
      restoreProfileBackup(backup.dir, join(root, 'profiles', 'desktop')),
    ).rejects.toMatchObject({ code: 'E_PROFILE_OWNED_BY_DESKTOP' });
  });

  it('恢复时给出重建参数（普通 install 会被判 up to date，必须 --force）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-restore-'));
    const profile = await makeProfile(root);
    const backup = await createProfileBackup({ profileDir: profile, backupsRoot: join(root, 'state', 'backups') });

    const result = await restoreProfileBackup(backup.dir, profile);
    expect(result.rebuildArgs).toEqual(['install', '--offline', '--frozen-lockfile', '--force']);
  });

  it('备份文件清单与实际文件一致（防止漏备份导致恢复缺文件）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-restore-'));
    const profile = await makeProfile(root);
    await writeFile(join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
    const backupsRoot = join(root, 'state', 'backups');
    const backup = await createProfileBackup({ profileDir: profile, backupsRoot });

    expect(backup.files).toEqual([...PROFILE_BACKUP_FILES]);
    expect(backup.missing).toEqual([]);
  });
});
