import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SnowLumaDeployRunner,
  createNodeConfigDeps,
  createNodeInstallDeps,
  type InstallFsDeps,
  type SnowLumaDeployDeps,
  type SnowLumaProcessService,
} from '@dda/core';
import type { SnowLumaDeployAuthorization } from '@dda/spec';

import { FIXTURE_SHA, FIXTURE_VERSION, fixtureManifest, writeFixturePackageDir } from '../helpers/snowluma-fixtures';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-deploy-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FILE = `SnowLuma-v${FIXTURE_VERSION}-win-x64.zip`;

function fakeProcess(onStart: () => void): SnowLumaProcessService {
  let running = false;
  return {
    get status() {
      return { running, pid: running ? 4242 : undefined };
    },
    get outputTail() {
      return ['boot ok'];
    },
    async start() {
      running = true;
      onStart();
      return { pid: 4242, alreadyRunning: false };
    },
    async stop() {
      running = false;
    },
  } as unknown as SnowLumaProcessService;
}

interface Harness {
  deps: SnowLumaDeployDeps;
  calls: { download: number; adapterInstall: number; configure: { baseUrl: string; accessToken?: string }[]; start: number };
  installDir: string;
  stateDir: string;
  cacheDir: string;
}

async function makeHarness(options: { installFails?: boolean; downloadFails?: boolean } = {}): Promise<Harness> {
  const root = await tempDir();
  const installDir = join(root, 'SnowLuma');
  const calls = { download: 0, adapterInstall: 0, configure: [], start: 0 } as Harness['calls'];
  const written = new Set<string>();
  const installBase = createNodeInstallDeps();
  const install: InstallFsDeps = {
    ...installBase,
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    uncompressedSize: async () => 1024,
    extract: async ({ destDir }) => {
      if (options.installFails) throw new Error('模拟解压失败');
      await writeFixturePackageDir(destDir);
      return { files: 10, bytes: 1024 };
    },
  };

  const deps: SnowLumaDeployDeps = {
    platform: 'win32',
    release: {
      getJson: async (url) =>
        url.endsWith('/releases/latest')
          ? { status: 200, body: { tag_name: `v${FIXTURE_VERSION}` } }
          : {
              status: 200,
              body: { tag_name: `v${FIXTURE_VERSION}`, assets: [{ name: FILE, size: 1234, digest: `sha256:${FIXTURE_SHA}` }] },
            },
    },
    package: {
      stat: async (path) => {
        if (!written.has(path)) throw new Error('missing');
        return { size: 1234 };
      },
      sha256File: async (path) => (written.has(path) ? FIXTURE_SHA : 'missing'),
      remove: async (path) => {
        written.delete(path);
      },
      download: async (req) => {
        calls.download += 1;
        if (options.downloadFails) throw new Error('模拟下载失败');
        written.add(req.destPath);
        req.onProgress?.({ receivedBytes: 600, totalBytes: 1234 });
        req.onProgress?.({ receivedBytes: 1234, totalBytes: 1234 });
        return { path: req.destPath, bytes: 1234, resumedFrom: 0, sha256: FIXTURE_SHA };
      },
      now: () => Date.now(),
    },
    install,
    config: createNodeConfigDeps(),
    process: fakeProcess(() => {
      calls.start += 1;
    }),
    health: {
      connect: async () => true,
      getJson: async () => ({ status: 200, body: { status: 'ok', data: { user_id: 10001, nickname: 'tester' } } }),
      sleep: async () => undefined,
      now: () => Date.now(),
    },
    detectQq: async () => ({ installed: true, running: true, path: 'C:\\Program Files\\QQNT\\QQ.exe' }),
    link: {
      state: async () => ({ installed: true, version: '1.5.1', bridge: { ok: true, backendOk: true } }),
      install: async () => {
        calls.adapterInstall += 1;
      },
      configure: async (input) => {
        calls.configure.push(input);
        return { ok: true };
      },
    },
    now: () => new Date('2026-11-03T12:00:00Z'),
    newId: () => 'run-1',
    log: async () => undefined,
  };

  return { deps, calls, installDir, stateDir: join(root, 'state'), cacheDir: join(root, 'cache') };
}

const GUIDED: SnowLumaDeployAuthorization = {
  allowed: false,
  mode: 'guided',
  reason: '未登记书面授权，按合规要求只提供官方入口与装后检测。',
};

const AUTHORIZED: SnowLumaDeployAuthorization = {
  allowed: true,
  mode: 'auto',
  reason: '已登记著作权人书面授权（DDA-TEST-001），允许自动安装与启动。',
  authorizationRef: 'DDA-TEST-001',
};

describe('个人 QQ 部署编排', () => {
  it('未获授权时受许可限制的步骤一律 blocked，且不触发下载/安装/启动', async () => {
    const h = await makeHarness();
    const runner = new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest(),
      authorization: GUIDED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
    });
    const snapshot = await runner.run();

    expect(snapshot.status).toBe('blocked');
    for (const id of ['release', 'download', 'install', 'configure', 'start'] as const) {
      const step = snapshot.steps.find((item) => item.id === id)!;
      expect(step.status).toBe('blocked');
      expect(step.evidence.join('\n')).toContain('EULA §5.4');
    }
    expect(h.calls.download).toBe(0);
    expect(h.calls.start).toBe(0);
    // 我们自己的适配层仍可配置（不受该限制），但缺少 SnowLuma 端点时必须如实失败。
    expect(snapshot.steps.find((item) => item.id === 'link')!.status).toBe('failed');
  });

  it('已授权且用户确认真实收到回复时，全流程 done', async () => {
    const h = await makeHarness();
    const runner = new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest({ authorizationRef: 'DDA-TEST-001' }),
      authorization: AUTHORIZED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
      messageVerifiedAt: '2026-11-03T12:30:00Z',
    });
    const snapshot = await runner.run();

    expect(snapshot.status).toBe('done');
    for (const step of snapshot.steps) expect(step.status).toBe('done');
    expect(h.calls.download).toBe(1);
    expect(h.calls.start).toBe(1);
    expect(h.calls.configure).toHaveLength(1);
    expect(h.calls.configure[0]!.baseUrl).toBe('http://127.0.0.1:3000');
    // 令牌只进内存，不进入快照。
    expect(JSON.stringify(snapshot)).not.toMatch(/"accessToken"/);
    const verify = snapshot.steps.find((step) => step.id === 'verify')!;
    expect(verify.evidence.join('\n')).toContain('get_login_info');
    expect(verify.evidence.join('\n')).toContain('10001');
  });

  it('自动检查通过但用户未确认时停在 waiting，不虚报成功', async () => {
    const h = await makeHarness();
    const runner = new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest({ authorizationRef: 'DDA-TEST-001' }),
      authorization: AUTHORIZED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
    });
    const snapshot = await runner.run();
    expect(snapshot.status).toBe('waiting');
    const verify = snapshot.steps.find((step) => step.id === 'verify')!;
    expect(verify.status).toBe('waiting');
    expect(verify.detail).toContain('手机 QQ');
  });

  it('解压失败后，后续步骤标记 skipped，整体 failed', async () => {
    const h = await makeHarness({ installFails: true });
    const runner = new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest({ authorizationRef: 'DDA-TEST-001' }),
      authorization: AUTHORIZED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
    });
    const snapshot = await runner.run();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.steps.find((step) => step.id === 'install')!.status).toBe('failed');
    expect(snapshot.steps.find((step) => step.id === 'configure')!.status).toBe('skipped');
    expect(h.calls.start).toBe(0);
    expect(snapshot.message).toContain('解压安装');
  });

  it('下载失败会保留失败原因与可操作建议', async () => {
    const h = await makeHarness({ downloadFails: true });
    const runner = new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest({ authorizationRef: 'DDA-TEST-001' }),
      authorization: AUTHORIZED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
    });
    const snapshot = await runner.run();
    const download = snapshot.steps.find((step) => step.id === 'download')!;
    expect(download.status).toBe('failed');
    expect(download.error).toContain('模拟下载失败');
  });

  it('取消后不再执行任何步骤，且状态为 cancelled', async () => {
    const h = await makeHarness();
    const controller = new AbortController();
    controller.abort();
    const runner = new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest({ authorizationRef: 'DDA-TEST-001' }),
      authorization: AUTHORIZED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
      signal: controller.signal,
    });
    const snapshot = await runner.run();
    expect(snapshot.status).toBe('cancelled');
    expect(h.calls.download).toBe(0);
    expect(h.calls.start).toBe(0);
  });

  it('同一次部署重跑会复用已校验的安装包，不重复下载', async () => {
    const h = await makeHarness();
    const runner = new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest({ authorizationRef: 'DDA-TEST-001' }),
      authorization: AUTHORIZED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
      messageVerifiedAt: '2026-11-03T12:30:00Z',
    });
    const first = await runner.run();
    expect(first.status).toBe('done');

    // 第二次部署：缓存命中（sha256File 固定返回清单哈希，stat 固定返回清单大小）。
    const second = await new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest({ authorizationRef: 'DDA-TEST-001' }),
      authorization: AUTHORIZED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
      messageVerifiedAt: '2026-11-03T12:30:00Z',
    }).run();

    const download = second.steps.find((step) => step.id === 'download')!;
    expect(download.evidence.join('\n')).toContain('复用已校验的安装包');
    expect(h.calls.download).toBe(1);
  });

  it('单步重跑会把失败原因清空并重新执行', async () => {
    const h = await makeHarness({ installFails: true });
    const runner = new SnowLumaDeployRunner(h.deps, {
      manifest: fixtureManifest({ authorizationRef: 'DDA-TEST-001' }),
      authorization: AUTHORIZED,
      installDir: h.installDir,
      stateDir: h.stateDir,
      cacheDir: h.cacheDir,
      messageVerifiedAt: '2026-11-03T12:30:00Z',
    });
    await runner.run();
    expect(runner.state.steps.find((step) => step.id === 'install')!.status).toBe('failed');

    const retried = await runner.runStep('install');
    const install = retried.steps.find((step) => step.id === 'install')!;
    expect(install.status).toBe('failed');
    expect(install.error).toContain('模拟解压失败');
  });
});
