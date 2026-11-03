import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createNodeConfigDeps,
  ensureOneBotHttpConfig,
  inspectConfig,
  readActiveEndpoint,
  restoreConfig,
  type ConfigDeps,
} from '@dda/core';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-cfg-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{ deps: ConfigDeps; installDir: string; backupRoot: string }> {
  const root = await tempDir();
  const installDir = join(root, 'SnowLuma');
  await mkdir(join(installDir, 'config'), { recursive: true });
  return { deps: createNodeConfigDeps(), installDir, backupRoot: join(root, 'state', 'config-backups') };
}

describe('SnowLuma 配置服务', () => {
  it('没有 onebot.json 时按上游默认结构创建，并可读出端点', async () => {
    const ctx = await setup();
    const result = await ensureOneBotHttpConfig(ctx.deps, {
      installDir: ctx.installDir,
      port: 3000,
      backupRoot: ctx.backupRoot,
    });
    expect(result.created).toBe(true);
    expect(result.accessTokenPresent).toBe(true);
    expect(result.evidence.join('\n')).toContain('按上游默认结构创建');
    // 令牌不得出现在证据里。
    expect(result.evidence.join('\n')).not.toMatch(/[a-f0-9]{32}/);

    const raw = JSON.parse(await readFile(join(ctx.installDir, 'config', 'onebot.json'), 'utf8'));
    const server = raw.networks.httpServers[0];
    expect(server.name).toBe('http-default');
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBe(3000);
    expect(server.messageFormat).toBe('array');
    expect(typeof server.accessToken).toBe('string');
    expect(raw.statusCommand.trigger).toBe('#sl');

    const endpoint = await readActiveEndpoint(ctx.deps, { installDir: ctx.installDir });
    expect(endpoint?.baseUrl).toBe('http://127.0.0.1:3000');
    expect(endpoint?.accessToken).toBe(server.accessToken);
  });

  it('只改端口，保留令牌、其它服务与未知字段，并先备份', async () => {
    const ctx = await setup();
    const original = {
      networks: {
        httpServers: [
          { name: 'http-default', host: '127.0.0.1', port: 3001, path: '/', accessToken: 'KEEP-ME', messageFormat: 'array' },
          { name: 'http-extra', host: '127.0.0.1', port: 3999, path: '/', accessToken: 'OTHER' },
        ],
        httpClients: [],
        wsServers: [],
        wsClients: [],
      },
      statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger: '#sl' },
      customField: { keep: true },
    };
    await writeFile(join(ctx.installDir, 'config', 'onebot.json'), JSON.stringify(original), 'utf8');

    const result = await ensureOneBotHttpConfig(ctx.deps, {
      installDir: ctx.installDir,
      port: 3000,
      backupRoot: ctx.backupRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.backupDir).toBeTruthy();

    const updated = JSON.parse(await readFile(join(ctx.installDir, 'config', 'onebot.json'), 'utf8'));
    expect(updated.networks.httpServers[0].port).toBe(3000);
    expect(updated.networks.httpServers[0].accessToken).toBe('KEEP-ME');
    expect(updated.networks.httpServers[1].name).toBe('http-extra');
    expect(updated.customField).toEqual({ keep: true });

    const backups = await readdir(ctx.backupRoot);
    expect(backups.length).toBe(1);
    const backedUp = JSON.parse(await readFile(join(ctx.backupRoot, backups[0]!, 'onebot.json'), 'utf8'));
    expect(backedUp.networks.httpServers[0].port).toBe(3001);
  });

  it('端口已一致时不做无意义写入', async () => {
    const ctx = await setup();
    await ensureOneBotHttpConfig(ctx.deps, { installDir: ctx.installDir, port: 3000, backupRoot: ctx.backupRoot });
    const again = await ensureOneBotHttpConfig(ctx.deps, {
      installDir: ctx.installDir,
      port: 3000,
      backupRoot: ctx.backupRoot,
    });
    expect(again.changed).toBe(false);
    expect(again.evidence.join('\n')).toContain('无需改动');
  });

  it('存在账号级快照时完全不修改配置', async () => {
    const ctx = await setup();
    const snapshot = {
      mode: 'snapshot',
      networks: {
        httpServers: [{ name: 'http-default', host: '127.0.0.1', port: 3100, accessToken: 'SNAP', messageFormat: 'array' }],
        httpClients: [],
        wsServers: [],
        wsClients: [],
      },
    };
    await writeFile(join(ctx.installDir, 'config', 'onebot_10001.json'), JSON.stringify(snapshot), 'utf8');

    const result = await ensureOneBotHttpConfig(ctx.deps, {
      installDir: ctx.installDir,
      port: 3000,
      backupRoot: ctx.backupRoot,
    });
    expect(result.changed).toBe(false);
    expect(result.evidence.join('\n')).toContain('账号级快照');

    const files = await readdir(join(ctx.installDir, 'config'));
    expect(files).toEqual(['onebot_10001.json']);
    const endpoint = await readActiveEndpoint(ctx.deps, { installDir: ctx.installDir });
    expect(endpoint?.baseUrl).toBe('http://127.0.0.1:3100');
    expect(endpoint?.sourceFile).toBe('onebot_10001.json');
  });

  it('配置损坏时拒绝写入，并保留可恢复的备份', async () => {
    const ctx = await setup();
    await writeFile(join(ctx.installDir, 'config', 'onebot.json'), '{ not json', 'utf8');
    await expect(
      ensureOneBotHttpConfig(ctx.deps, { installDir: ctx.installDir, port: 3000, backupRoot: ctx.backupRoot }),
    ).rejects.toThrow(/无法解析/);
    const backups = await readdir(ctx.backupRoot);
    expect(backups.length).toBe(1);
    expect(await readFile(join(ctx.backupRoot, backups[0]!, 'onebot.json'), 'utf8')).toBe('{ not json');
  });

  it('可以从备份恢复 config/', async () => {
    const ctx = await setup();
    await writeFile(join(ctx.installDir, 'config', 'onebot.json'), '{"networks":{"httpServers":[]}}', 'utf8');
    const ensured = await ensureOneBotHttpConfig(ctx.deps, {
      installDir: ctx.installDir,
      port: 3000,
      backupRoot: ctx.backupRoot,
    });
    expect(ensured.backupDir).toBeTruthy();

    const restored = await restoreConfig(ctx.deps, {
      configDir: join(ctx.installDir, 'config'),
      backupDir: ensured.backupDir!,
    });
    expect(restored.restored).toBe(true);
    expect(await readFile(join(ctx.installDir, 'config', 'onebot.json'), 'utf8')).toBe(
      '{"networks":{"httpServers":[]}}',
    );
  });

  it('配置目录不存在时给出可读的现状说明', async () => {
    const ctx = await setup();
    const inspection = await inspectConfig(ctx.deps, { installDir: join(ctx.installDir, 'nope') });
    expect(inspection.exists).toBe(false);
    expect(inspection.problem).toContain('首次运行');
  });
});
