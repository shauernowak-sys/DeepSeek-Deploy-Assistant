import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNodeInstallDeps, installPackage, validatePackageRoot, type InstallFsDeps } from '@dda/core';
import { writeZip } from '@dda/core';

import { FIXTURE_VERSION, buildFixtureZip } from '../helpers/snowluma-fixtures';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-inst-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{
  deps: InstallFsDeps;
  installDir: string;
  zipPath: string;
  sha256: string;
  sizeBytes: number;
  stagingDir: string;
  backupDir: string;
  recordPath: string;
  counts: { extract: number };
}> {
  const root = await tempDir();
  const zip = await buildFixtureZip(join(root, 'pkg.zip'));
  const counts = { extract: 0 };
  const base = createNodeInstallDeps();
  const deps: InstallFsDeps = {
    ...base,
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    extract: async (options) => {
      counts.extract += 1;
      return base.extract(options);
    },
  };
  return {
    deps,
    installDir: join(root, 'SnowLuma'),
    zipPath: zip.zipPath,
    sha256: zip.sha256,
    sizeBytes: zip.sizeBytes,
    stagingDir: join(root, 'state', 'staging'),
    backupDir: join(root, 'state', 'backup'),
    recordPath: join(root, 'state', 'install.json'),
    counts,
  };
}

describe('SnowLuma 解压与安装', () => {
  it('全新安装：解压、结构校验、写安装记录', async () => {
    const ctx = await setup();
    const result = await installPackage(ctx.deps, {
      zipPath: ctx.zipPath,
      installDir: ctx.installDir,
      expectedVersion: FIXTURE_VERSION,
      sha256: ctx.sha256,
      sizeBytes: ctx.sizeBytes,
      sourceUrl: `https://github.com/SnowLuma/SnowLuma/releases/download/v${FIXTURE_VERSION}/SnowLuma-v${FIXTURE_VERSION}-win-x64.zip`,
      fileName: `SnowLuma-v${FIXTURE_VERSION}-win-x64.zip`,
      stagingDir: ctx.stagingDir,
      backupDir: ctx.backupDir,
      recordPath: ctx.recordPath,
    });

    expect(result.changed).toBe(true);
    expect(result.upgraded).toBe(false);
    expect(JSON.parse(await readFile(join(ctx.installDir, 'release.json'), 'utf8')).version).toBe(FIXTURE_VERSION);
    expect(await readFile(join(ctx.installDir, 'node.exe'), 'utf8')).toContain('MZ');
    const record = JSON.parse(await readFile(ctx.recordPath, 'utf8'));
    expect(record.version).toBe(FIXTURE_VERSION);
    expect(result.evidence.join('\n')).toContain('release.json 校验通过');
  });

  it('升级时保留用户 config/ 与 data/', async () => {
    const ctx = await setup();
    await mkdir(join(ctx.installDir, 'config'), { recursive: true });
    await mkdir(join(ctx.installDir, 'data', '10001'), { recursive: true });
    await writeFile(join(ctx.installDir, 'config', 'onebot.json'), '{"mine":true}', 'utf8');
    await writeFile(join(ctx.installDir, 'data', '10001', 'messages.db'), 'db', 'utf8');

    await installPackage(ctx.deps, {
      zipPath: ctx.zipPath,
      installDir: ctx.installDir,
      expectedVersion: FIXTURE_VERSION,
      sha256: ctx.sha256,
      sizeBytes: ctx.sizeBytes,
      sourceUrl: 'https://github.com/SnowLuma/SnowLuma/releases/download/v9.9.9/x.zip',
      fileName: 'x.zip',
      stagingDir: ctx.stagingDir,
      backupDir: ctx.backupDir,
      recordPath: ctx.recordPath,
    });

    expect(await readFile(join(ctx.installDir, 'config', 'onebot.json'), 'utf8')).toBe('{"mine":true}');
    expect(await readFile(join(ctx.installDir, 'data', '10001', 'messages.db'), 'utf8')).toBe('db');
  });

  it('同版本且结构完整时不重复解压；repair 才强制覆盖', async () => {
    const ctx = await setup();
    const run = (repair?: boolean) =>
      installPackage(ctx.deps, {
        zipPath: ctx.zipPath,
        installDir: ctx.installDir,
        expectedVersion: FIXTURE_VERSION,
        sha256: ctx.sha256,
        sizeBytes: ctx.sizeBytes,
        sourceUrl: 'https://github.com/SnowLuma/SnowLuma/releases/download/v9.9.9/x.zip',
        fileName: 'x.zip',
        stagingDir: ctx.stagingDir,
        backupDir: ctx.backupDir,
        recordPath: ctx.recordPath,
        repair,
      });

    await run();
    const second = await run();
    expect(second.changed).toBe(false);
    expect(ctx.counts.extract).toBe(1);

    const third = await run(true);
    expect(third.changed).toBe(true);
    expect(ctx.counts.extract).toBe(2);
  });

  it('中途失败会回滚到安装前状态', async () => {
    const ctx = await setup();
    // 先装一次旧内容，制造"已存在"的场景。
    await mkdir(ctx.installDir, { recursive: true });
    await writeFile(join(ctx.installDir, 'index.mjs'), 'OLD', 'utf8');

    const failing: InstallFsDeps = {
      ...ctx.deps,
      rename: async (from, to) => {
        if (to.includes('index.mjs')) throw new Error('模拟文件被占用');
        return ctx.deps.rename(from, to);
      },
    };

    await expect(
      installPackage(failing, {
        zipPath: ctx.zipPath,
        installDir: ctx.installDir,
        expectedVersion: FIXTURE_VERSION,
        sha256: ctx.sha256,
        sizeBytes: ctx.sizeBytes,
        sourceUrl: 'https://github.com/SnowLuma/SnowLuma/releases/download/v9.9.9/x.zip',
        fileName: 'x.zip',
        stagingDir: ctx.stagingDir,
        backupDir: ctx.backupDir,
        recordPath: ctx.recordPath,
      }),
    ).rejects.toThrow(/模拟文件被占用/);

    // 旧文件必须还在原处（回滚生效），且没有留下 release.json 半成品。
    expect(await readFile(join(ctx.installDir, 'index.mjs'), 'utf8')).toBe('OLD');
    expect(await ctx.deps.exists(join(ctx.installDir, 'release.json'))).toBe(false);
  });

  it('release.json 里的越界条目被整份拒绝，且不写入任何文件', async () => {
    const ctx = await setup();
    const badZip = join(await tempDir(), 'bad.zip');
    await writeZip(badZip, [
      {
        name: 'release.json',
        content: JSON.stringify({ version: FIXTURE_VERSION, target: 'win32-x64', entries: ['..\\evil', 'config'] }),
      },
      { name: 'package.json', content: '{}' },
      { name: 'index.mjs', content: 'x' },
      { name: 'node.exe', content: 'MZ' },
      { name: 'launcher.bat', content: 'x' },
      { name: 'check-node-version.cjs', content: 'x' },
      { name: 'EULA.md', content: 'x' },
      { name: 'PRIVACY.md', content: 'x' },
      { name: 'client/index.html', content: 'x' },
      { name: 'native/snowluma-win32-x64.node', content: 'x' },
    ]);

    await expect(
      installPackage(ctx.deps, {
        zipPath: badZip,
        installDir: ctx.installDir,
        expectedVersion: FIXTURE_VERSION,
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
        sourceUrl: 'https://github.com/SnowLuma/SnowLuma/releases/download/v9.9.9/x.zip',
        fileName: 'x.zip',
        stagingDir: ctx.stagingDir,
        backupDir: ctx.backupDir,
        recordPath: ctx.recordPath,
      }),
    ).rejects.toThrow(/结构校验失败/);

    expect(await ctx.deps.exists(join(ctx.installDir, 'release.json'))).toBe(false);
    expect(await ctx.deps.exists(ctx.stagingDir)).toBe(false);
  });

  it('磁盘空间不足时提前失败，不解压', async () => {
    const ctx = await setup();
    const tight: InstallFsDeps = { ...ctx.deps, freeBytes: async () => 1024 };
    await expect(
      installPackage(tight, {
        zipPath: ctx.zipPath,
        installDir: ctx.installDir,
        expectedVersion: FIXTURE_VERSION,
        sha256: ctx.sha256,
        sizeBytes: ctx.sizeBytes,
        sourceUrl: 'https://github.com/SnowLuma/SnowLuma/releases/download/v9.9.9/x.zip',
        fileName: 'x.zip',
        stagingDir: ctx.stagingDir,
        backupDir: ctx.backupDir,
        recordPath: ctx.recordPath,
      }),
    ).rejects.toThrow(/磁盘可用空间不足/);
    expect(ctx.counts.extract).toBe(0);
  });

  it('结构校验会指出缺失文件', async () => {
    const ctx = await setup();
    const empty = await tempDir();
    const validation = await validatePackageRoot(ctx.deps, empty, FIXTURE_VERSION);
    expect(validation.ok).toBe(false);
    expect(validation.problems.join(' ')).toContain('缺少文件 release.json');
  });
});
