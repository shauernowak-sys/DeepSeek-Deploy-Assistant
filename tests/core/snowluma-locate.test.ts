import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverInstallDirs, verifyInstallDir, type LocateFsDeps } from '@dda/core';

import { FIXTURE_VERSION, writeFixturePackageDir } from '../helpers/snowluma-fixtures';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-locate-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const deps: LocateFsDeps = {
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path),
};

describe('SnowLuma 安装位置定位（M3.3.1 第三步）', () => {
  it('校验通过时给出实际版本与逐项检查', async () => {
    const root = await tempDir();
    const installDir = await writeFixturePackageDir(join(root, 'SnowLuma'));

    const result = await verifyInstallDir(deps, { installDir, expectedVersion: FIXTURE_VERSION });
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.version).toBe(FIXTURE_VERSION);
    expect(result.versionMatches).toBe(true);
    expect(result.resolvedFromChild).toBe(false);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.hasConfig).toBe(false);
  });

  it('用户选到上一级目录时自动下钻到含 release.json 的子目录', async () => {
    const root = await tempDir();
    const parent = join(root, 'Downloads');
    await writeFixturePackageDir(join(parent, `SnowLuma-v${FIXTURE_VERSION}-win-x64`));

    const result = await verifyInstallDir(deps, { installDir: parent, expectedVersion: FIXTURE_VERSION });
    expect(result.resolvedFromChild).toBe(true);
    expect(result.installDir).toBe(join(parent, `SnowLuma-v${FIXTURE_VERSION}-win-x64`));
    expect(result.valid).toBe(true);
  });

  it('目录里没有 release.json 时明确说明原因，而不是假装已安装', async () => {
    const root = await tempDir();
    const empty = join(root, 'NotSnowLuma');
    await mkdir(empty, { recursive: true });

    const result = await verifyInstallDir(deps, { installDir: empty, expectedVersion: FIXTURE_VERSION });
    expect(result.exists).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toContain('没有 release.json');
  });

  it('缺少 node.exe（lite 版）时校验不通过并点名缺失项', async () => {
    const root = await tempDir();
    const installDir = await writeFixturePackageDir(join(root, 'SnowLuma'));
    await rm(join(installDir, 'node.exe'));

    const result = await verifyInstallDir(deps, { installDir, expectedVersion: FIXTURE_VERSION });
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toContain('node.exe');
  });

  it('版本不一致时仍然可识别，但标记为"与推荐版本不符"', async () => {
    const root = await tempDir();
    const installDir = await writeFixturePackageDir(join(root, 'SnowLuma'), { version: '2.3.4' });

    const result = await verifyInstallDir(deps, { installDir, expectedVersion: FIXTURE_VERSION });
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.version).toBe('2.3.4');
    expect(result.versionMatches).toBe(false);
    expect(result.problems.join(' ')).toContain('本产品验证过的版本');
  });

  it('常见目录扫描能找到下载目录里解压出来的 SnowLuma', async () => {
    const root = await tempDir();
    const profile = join(root, 'profile');
    const localAppData = join(root, 'LocalAppData');
    await writeFixturePackageDir(join(profile, 'Downloads', `SnowLuma-v${FIXTURE_VERSION}-win-x64`));
    await mkdir(localAppData, { recursive: true });

    const candidates = await discoverInstallDirs(deps, {
      env: { LOCALAPPDATA: localAppData, USERPROFILE: profile, ProgramFiles: join(root, 'PF') },
      expectedVersion: FIXTURE_VERSION,
    });

    const found = candidates.find((item) => item.dir.includes('Downloads'));
    expect(found).toBeTruthy();
    expect(found!.source).toBe('profile-scan');
    expect(found!.verification.valid).toBe(true);
  });

  it('用户已保存的目录排在前面；无效目录也会返回以说明原因，但不会把空目录当成"已安装"', async () => {
    const root = await tempDir();
    const settingsDir = join(root, 'MySnowLuma');
    await writeFixturePackageDir(settingsDir);
    const invalidDir = join(root, 'WrongDir');
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(invalidDir, 'readme.txt'), 'x', 'utf8');

    const candidates = await discoverInstallDirs(deps, {
      env: { USERPROFILE: join(root, 'profile') },
      expectedVersion: FIXTURE_VERSION,
      settingsDir,
      managedDir: invalidDir,
    });
    expect(candidates[0]?.dir).toBe(settingsDir);
    expect(candidates[0]?.source).toBe('settings');
    // 受管目录里没有 release.json 时不应作为"已安装"候选出现。
    expect(candidates.some((item) => item.source === 'managed')).toBe(false);
    // 用户显式保存的无效目录仍会返回（用于解释"为什么这个目录不可用"）。
    const explicitInvalid = await discoverInstallDirs(deps, {
      env: { USERPROFILE: join(root, 'profile') },
      expectedVersion: FIXTURE_VERSION,
      settingsDir: invalidDir,
    });
    expect(explicitInvalid[0]?.verification.exists).toBe(false);
    expect(explicitInvalid[0]?.verification.problems.length).toBeGreaterThan(0);
  });

  it('受管目录装好之后同样会被识别', async () => {
    const root = await tempDir();
    const managed = await writeFixturePackageDir(join(root, 'managed', 'snowluma'));
    const candidates = await discoverInstallDirs(deps, {
      env: { USERPROFILE: join(root, 'profile') },
      expectedVersion: FIXTURE_VERSION,
      managedDir: managed,
    });
    expect(candidates.some((item) => item.source === 'managed' && item.verification.valid)).toBe(true);
  });
});
