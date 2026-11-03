import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNodeConfigDeps, createNodeInstallDeps } from '@dda/core';
import type { SnowLumaDeploySnapshot } from '@dda/spec';

import { SnowLumaDeploymentService } from '../../apps/desktop/src/main/services/snowluma-deployment-service';
import type { Container } from '../../apps/desktop/src/main/services/container';
import type { HarnessService } from '../../apps/desktop/src/main/services/harness-service';
import type { PersonalQqService } from '../../apps/desktop/src/main/services/personal-qq-service';
import { FIXTURE_SHA, FIXTURE_VERSION, fixtureManifest, writeFixturePackageDir } from '../helpers/snowluma-fixtures';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-svc-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FILE = `SnowLuma-v${FIXTURE_VERSION}-win-x64.zip`;

async function setup(): Promise<{
  service: SnowLumaDeploymentService;
  root: string;
  settings: { installDir?: string; onebotHttpPort: number };
}> {
  const root = await tempDir();
  const settings: { installDir?: string; onebotHttpPort: number } = { onebotHttpPort: 3000 };
  const container = {
    paths: {
      root,
      downloads: join(root, 'cache', 'downloads'),
      logs: join(root, 'logs'),
    },
    manifestsDir: join(root, 'manifests'),
    registry: 'https://registry.npmmirror.com',
    logger: { info: async () => undefined, warn: async () => undefined, error: async () => undefined },
  } as unknown as Container;

  const harness = {
    running: true,
    auth: () => ({ baseUrl: 'http://127.0.0.1:1234', token: 'harness-token' }),
    listPlugins: async () => [{ name: 'dsh-qq-link', version: '1.5.1', installed: true }],
    installPlugin: async () => undefined,
    removePlugin: async () => undefined,
    restart: async () => ({ running: true }),
  } as unknown as HarnessService;

  const personal = {
    settings: async () => settings,
    saveSettings: async (next: typeof settings) => {
      Object.assign(settings, next);
      return next;
    },
    discoverInstallDir: async () => undefined,
    manifest: async () => fixtureManifest(),
    installAdapter: async () => ({ ok: true, message: 'ok' }),
    applyBridgeEndpoint: async () => ({ ok: true, message: 'ok' }),
  } as unknown as PersonalQqService;

  const installBase = createNodeInstallDeps();
  const service = new SnowLumaDeploymentService(container, harness, personal, {
    detection: {
      exists: async () => true,
      readJson: async () => ({}),
      readdir: async () => [],
      listProcesses: async () => [],
      connect: async () => true,
      getJson: async () => ({ status: 200, body: {} }),
    },
    releaseHttp: {
      getJson: async (url) =>
        url.endsWith('/releases/latest')
          ? { status: 200, body: { tag_name: `v${FIXTURE_VERSION}` } }
          : {
              status: 200,
              body: { tag_name: `v${FIXTURE_VERSION}`, assets: [{ name: FILE, size: 1234, digest: `sha256:${FIXTURE_SHA}` }] },
            },
    },
    package: {
      stat: async () => ({ size: 1234 }),
      sha256File: async () => FIXTURE_SHA,
      remove: async () => undefined,
      download: async (req) => ({ path: req.destPath, bytes: 1234, resumedFrom: 0, sha256: FIXTURE_SHA }),
      now: () => Date.now(),
    },
    install: {
      ...installBase,
      freeBytes: async () => 10 * 1024 * 1024 * 1024,
      uncompressedSize: async () => 1024,
      extract: async ({ destDir }) => {
        await writeFixturePackageDir(destDir);
        return { files: 10, bytes: 1024 };
      },
    },
    config: createNodeConfigDeps(),
    health: {
      connect: async () => true,
      getJson: async () => ({ status: 200, body: { data: { user_id: 10001 } } }),
      sleep: async () => undefined,
      now: () => Date.now(),
    },
    now: () => new Date('2026-11-03T12:00:00Z'),
    env: { LOCALAPPDATA: join(root, 'LocalAppData'), USERPROFILE: join(root, 'profile') },
  });

  return { service, root, settings };
}

async function waitFor(service: SnowLumaDeploymentService, predicate: (snapshot: SnowLumaDeploySnapshot) => boolean): Promise<SnowLumaDeploySnapshot> {
  for (let i = 0; i < 60; i += 1) {
    const snapshot = await service.snapshot();
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return service.snapshot();
}

describe('SnowLuma 部署服务（主进程接线）', () => {
  it('默认快照包含 8 个步骤，并按清单给出授权结论', async () => {
    const { service } = await setup();
    const snapshot = await service.snapshot();
    expect(snapshot.steps).toHaveLength(8);
    expect(snapshot.authorization.allowed).toBe(false);
    expect(snapshot.authorization.mode).toBe('guided');
    expect(snapshot.authorization.reason).toContain('书面授权');
  });

  it('未授权时启动部署：受限步骤 blocked，且会把安装目录写入设置', async () => {
    const { service, settings } = await setup();
    const started = await service.start({ repair: false });
    expect(started.status).toBe('running');

    const finished = await waitFor(service, (snapshot) => snapshot.status !== 'running');
    expect(finished.status).toBe('blocked');
    expect(finished.steps.find((step) => step.id === 'download')!.status).toBe('blocked');
    expect(settings.installDir).toBeTruthy();

    // 快照被持久化，应用重启后仍能看到结论。
    const persisted = JSON.parse(
      await readFile(join(settings.installDir!, '..', '..', 'state', 'snowluma', 'deployment.json'), 'utf8'),
    ) as SnowLumaDeploySnapshot;
    expect(persisted.status).toBe('blocked');
  });

  it('单步重跑环境检查会写入真实结论', async () => {
    const { service } = await setup();
    const snapshot = await service.retryStep('precheck');
    const precheck = snapshot.steps.find((step) => step.id === 'precheck')!;
    expect(precheck.status).toBe('done');
    expect(precheck.evidence.join('\n')).toContain('QQ 客户端');
  });

  it('M3.3.1：校验与采用用户手动安装的目录', async () => {
    const { service, root, settings } = await setup();
    const installDir = await writeFixturePackageDir(join(root, 'ManualSnowLuma'));

    const verification = await service.verifyInstall(installDir);
    expect(verification.valid).toBe(true);
    expect(verification.version).toBe(FIXTURE_VERSION);

    const used = await service.useInstallDir(installDir);
    expect(used.ok).toBe(true);
    expect(settings.installDir).toBe(installDir);
    expect((await service.snapshot()).installDir).toBe(installDir);
  });

  it('M3.3.1：选错目录时拒绝保存，并给出可读原因', async () => {
    const { service, root, settings } = await setup();
    const wrong = join(root, 'NotSnowLuma');
    await mkdir(wrong, { recursive: true });

    const used = await service.useInstallDir(wrong);
    expect(used.ok).toBe(false);
    expect(used.message).toContain('release.json');
    expect(settings.installDir).toBeUndefined();
  });

  it('M3.3.1：常见目录自动发现会返回候选与推荐项', async () => {
    const { service, root } = await setup();
    const downloads = join(root, 'profile', 'Downloads', `SnowLuma-v${FIXTURE_VERSION}-win-x64`);
    await writeFixturePackageDir(downloads);

    const discovery = await service.discoverInstall();
    expect(discovery.expectedVersion).toBe(FIXTURE_VERSION);
    expect(discovery.candidates.some((item) => item.dir === downloads)).toBe(true);
    expect(discovery.selected?.valid).toBe(true);
  });
});
