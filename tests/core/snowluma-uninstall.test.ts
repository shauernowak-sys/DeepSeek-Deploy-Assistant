import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNodeConfigDeps, uninstallSnowLuma, type UninstallDeps } from '@dda/core';

import { writeFixturePackageDir } from '../helpers/snowluma-fixtures';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-uninst-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{
  deps: UninstallDeps;
  installDir: string;
  ourStateDir: string;
  backupRoot: string;
}> {
  const root = await tempDir();
  const installDir = join(root, 'SnowLuma');
  await writeFixturePackageDir(installDir);
  await mkdir(join(installDir, 'config'), { recursive: true });
  await writeFile(join(installDir, 'config', 'onebot.json'), '{"networks":{}}', 'utf8');
  await mkdir(join(installDir, 'data', '10001'), { recursive: true });
  await writeFile(join(installDir, 'data', '10001', 'messages.db'), 'db', 'utf8');
  await mkdir(join(installDir, 'logs'), { recursive: true });
  await writeFile(join(installDir, 'logs', 'app.log'), 'log', 'utf8');
  await writeFile(join(installDir, 'my-notes.txt'), 'user data', 'utf8');
  const ourStateDir = join(root, 'state', 'snowluma');
  await mkdir(ourStateDir, { recursive: true });
  await writeFile(join(ourStateDir, 'install.json'), '{}', 'utf8');
  return { deps: createNodeConfigDeps(), installDir, ourStateDir, backupRoot: join(root, 'state', 'backups') };
}

const base = { removeOurState: true, removeComponent: false, removeConfig: false, removeUserData: false, confirm: true };

describe('SnowLuma 卸载', () => {
  it('默认只删除我们自己的状态，不动程序与用户数据', async () => {
    const ctx = await setup();
    const result = await uninstallSnowLuma(ctx.deps, {
      installDir: ctx.installDir,
      ourStateDir: ctx.ourStateDir,
      backupRoot: ctx.backupRoot,
      input: base,
    });
    expect(result.ok).toBe(true);
    expect(await ctx.deps.exists(ctx.ourStateDir)).toBe(false);
    expect(await ctx.deps.exists(join(ctx.installDir, 'index.mjs'))).toBe(true);
    expect(await ctx.deps.exists(join(ctx.installDir, 'config', 'onebot.json'))).toBe(true);
    expect(await ctx.deps.exists(join(ctx.installDir, 'data', '10001', 'messages.db'))).toBe(true);
    expect(await ctx.deps.exists(join(ctx.installDir, 'my-notes.txt'))).toBe(true);
  });

  it('删除组件只删包内条目，保留 config/data/logs 与用户自建文件', async () => {
    const ctx = await setup();
    const result = await uninstallSnowLuma(ctx.deps, {
      installDir: ctx.installDir,
      ourStateDir: ctx.ourStateDir,
      backupRoot: ctx.backupRoot,
      input: { ...base, removeComponent: true },
    });
    expect(result.ok).toBe(true);
    expect(await ctx.deps.exists(join(ctx.installDir, 'release.json'))).toBe(false);
    expect(await ctx.deps.exists(join(ctx.installDir, 'index.mjs'))).toBe(false);
    expect(await ctx.deps.exists(join(ctx.installDir, 'config', 'onebot.json'))).toBe(true);
    expect(await ctx.deps.exists(join(ctx.installDir, 'data', '10001', 'messages.db'))).toBe(true);
    expect(await ctx.deps.exists(join(ctx.installDir, 'my-notes.txt'))).toBe(true);
  });

  it('删除配置前先备份，可人工恢复', async () => {
    const ctx = await setup();
    const result = await uninstallSnowLuma(ctx.deps, {
      installDir: ctx.installDir,
      ourStateDir: ctx.ourStateDir,
      backupRoot: ctx.backupRoot,
      input: { ...base, removeConfig: true },
    });
    expect(result.ok).toBe(true);
    expect(await ctx.deps.exists(join(ctx.installDir, 'config'))).toBe(false);
    const actions = result.actions.join('\n');
    expect(actions).toContain('已备份');
    const backupRoot = /已备份到 (.+)$/m.exec(actions)?.[1]?.trim();
    expect(backupRoot).toBeTruthy();
    expect(await readFile(join(backupRoot!, 'config', 'onebot.json'), 'utf8')).toBe('{"networks":{}}');
  });

  it('删除 QQ 登录数据需要单独勾选', async () => {
    const ctx = await setup();
    const result = await uninstallSnowLuma(ctx.deps, {
      installDir: ctx.installDir,
      ourStateDir: ctx.ourStateDir,
      backupRoot: ctx.backupRoot,
      input: { ...base, removeUserData: true },
    });
    expect(result.ok).toBe(true);
    expect(await ctx.deps.exists(join(ctx.installDir, 'data'))).toBe(false);
    expect(await ctx.deps.exists(join(ctx.installDir, 'logs'))).toBe(false);
    expect(await ctx.deps.exists(join(ctx.installDir, 'my-notes.txt'))).toBe(true);
    expect(result.actions.join('\n')).toContain('无法恢复');
  });

  it('未确认时拒绝执行', async () => {
    const ctx = await setup();
    const result = await uninstallSnowLuma(ctx.deps, {
      installDir: ctx.installDir,
      ourStateDir: ctx.ourStateDir,
      backupRoot: ctx.backupRoot,
      input: { ...base, confirm: false },
    });
    expect(result.ok).toBe(false);
    expect(result.refusedReason).toContain('明确确认');
    expect(await ctx.deps.exists(join(ctx.installDir, 'release.json'))).toBe(true);
  });
});
