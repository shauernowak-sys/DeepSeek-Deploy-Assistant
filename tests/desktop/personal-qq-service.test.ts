import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BridgeHttpDeps, DetectionDeps } from '@dda/core';

import type { Container } from '../../apps/desktop/src/main/services/container';
import type { HarnessService } from '../../apps/desktop/src/main/services/harness-service';
import { PersonalQqService } from '../../apps/desktop/src/main/services/personal-qq-service';

const MANIFESTS = resolve(process.cwd(), 'apps', 'desktop', 'resources', 'manifests');
const QQ_PATH = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';

async function makeRoot(settings?: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dda-personal-'));
  await mkdir(join(root, 'state'), { recursive: true });
  if (settings) await writeFile(join(root, 'state', 'personal-qq.json'), JSON.stringify(settings), 'utf8');
  return root;
}

function container(root: string): Container {
  return {
    paths: { root },
    manifestsDir: MANIFESTS,
    registry: 'https://registry.npmmirror.com',
    logger: { info: async () => undefined, warn: async () => undefined, error: async () => undefined },
  } as unknown as Container;
}

interface HarnessStubOptions {
  running?: boolean;
  adapterInstalled?: boolean;
  adapterVersion?: string;
}

function harnessStub(options: HarnessStubOptions = {}): HarnessService {
  return {
    running: options.running ?? true,
    auth: () => ({ baseUrl: 'http://127.0.0.1:18733', token: 'harness-token' }),
    listPlugins: async () =>
      options.adapterInstalled === false
        ? []
        : [{ name: 'dsh-qq-link', version: options.adapterVersion ?? '1.5.1', installed: true }],
    installPlugin: async () => undefined,
    removePlugin: async () => undefined,
    restart: async () => ({ running: true }),
  } as unknown as HarnessService;
}

interface DetectionOptions {
  installed?: boolean;
  qqRunning?: boolean;
  snowlumaRunning?: boolean;
  onebotOk?: boolean;
}

function detectionDeps(installDir: string, options: DetectionOptions = {}): DetectionDeps {
  const installed = options.installed ?? true;
  return {
    exists: async (path) =>
      (installed && path.startsWith(installDir)) || path === QQ_PATH,
    readJson: async (path) => {
      if (path.endsWith('release.json')) return { version: '2.4.0' };
      if (path.includes('onebot')) {
        return { networks: { httpServers: [{ name: 'http-default', port: 3000, accessToken: 'onebot-token-value' }] } };
      }
      return {};
    },
    readdir: async () => ['onebot_123456.json'],
    listProcesses: async () => [
      ...(options.qqRunning === false ? [] : [{ pid: 100, exePath: QQ_PATH }]),
      ...(options.snowlumaRunning === false ? [] : [{ pid: 200, exePath: join(installDir, 'node.exe') }]),
    ],
    connect: async () => true,
    getJson: async () =>
      options.onebotOk === false
        ? { status: 401, body: 'unauthorized' }
        : { status: 200, body: { status: 'ok', data: { user_id: 123456, nickname: '测试号' } } },
  };
}

function bridgeDeps(stateBody: unknown): BridgeHttpDeps {
  return {
    async get(url) {
      if (url.includes('/?token=')) return { status: 200, body: '', setCookie: ['dsh-auth-x=abc; Path=/'] };
      return { status: 200, body: stateBody };
    },
    async post(url) {
      if (url.endsWith('/dsh-qq-bridge/save')) return { status: 200, body: { ok: true } };
      return { status: 404, body: '' };
    },
  };
}

const LIVE_STATE = {
  ok: true,
  版本: '1.5.1',
  配置: { 总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 令牌: 'do-not-leak-me', 绑定: [] },
  NapCat状态: {},
  活着的会话: [{ id: 'ses_abc' }],
};

describe('PersonalQqService：状态合成', () => {
  it('未安装 SnowLuma → snowluma-not-installed，且自动化被许可闸门挡住', async () => {
    const installDir = join(await makeRoot(), 'snowluma');
    const root = await makeRoot({ route: 'personal', componentId: 'snowluma', installDir, onebotHttpPort: 3000 });
    const service = new PersonalQqService(container(root), harnessStub({ adapterInstalled: false }), {
      detection: detectionDeps(installDir, { installed: false }),
      bridge: bridgeDeps(LIVE_STATE),
      manifestsDir: MANIFESTS,
      env: { LOCALAPPDATA: 'C:\\x', ProgramFiles: 'C:\\Program Files' },
    });

    const status = await service.status();
    expect(status.phase).toBe('snowluma-not-installed');
    expect(status.automation.allowed).toBe(false);
    expect(status.automation.reason).toContain('书面授权');
  });

  it('全链路就绪 → harness-linked，并带上会话 id（不泄漏令牌）', async () => {
    const installDir = join(await makeRoot(), 'snowluma');
    const root = await makeRoot({ route: 'personal', componentId: 'snowluma', installDir, onebotHttpPort: 3000 });
    const service = new PersonalQqService(container(root), harnessStub(), {
      detection: detectionDeps(installDir),
      bridge: bridgeDeps(LIVE_STATE),
      manifestsDir: MANIFESTS,
      env: { LOCALAPPDATA: 'C:\\x', ProgramFiles: 'C:\\Program Files' },
    });

    const status = await service.status();
    expect(status.phase).toBe('harness-linked');
    expect(status.service.loginUin).toBe('123456');
    expect(status.adapter.installed).toBe(true);
    expect(status.bridge?.sessionIds).toEqual(['ses_abc']);
    expect(JSON.stringify(status)).not.toContain('do-not-leak-me');
    expect(JSON.stringify(status)).not.toContain('onebot-token-value');
  });

  it('OneBot 不可用 → 停在 snowluma-running，不冒充已联通', async () => {
    const installDir = join(await makeRoot(), 'snowluma');
    const root = await makeRoot({ route: 'personal', componentId: 'snowluma', installDir, onebotHttpPort: 3000 });
    const service = new PersonalQqService(container(root), harnessStub(), {
      detection: detectionDeps(installDir, { onebotOk: false }),
      bridge: bridgeDeps(LIVE_STATE),
      manifestsDir: MANIFESTS,
      env: {},
    });

    const status = await service.status();
    expect(status.phase).toBe('snowluma-running');
    expect(status.message).toContain('服务还没有响应');
    expect(status.phase).not.toBe('harness-linked');
  });

  it('QQ 没运行 → qq-not-running（即使 SnowLuma 已装好）', async () => {
    const installDir = join(await makeRoot(), 'snowluma');
    const root = await makeRoot({ route: 'personal', componentId: 'snowluma', installDir, onebotHttpPort: 3000 });
    const service = new PersonalQqService(container(root), harnessStub(), {
      detection: detectionDeps(installDir, { qqRunning: false }),
      bridge: bridgeDeps(LIVE_STATE),
      manifestsDir: MANIFESTS,
      env: {},
    });

    const status = await service.status();
    expect(status.phase).toBe('qq-not-running');
  });
});

describe('PersonalQqService：配置与动作', () => {
  it('写入 OneBot 配置时会拒绝"没有读到令牌"的情况，并给出可执行下一步', async () => {
    const installDir = join(await makeRoot(), 'snowluma');
    const root = await makeRoot({ route: 'personal', componentId: 'snowluma', installDir, onebotHttpPort: 3000 });
    const deps = detectionDeps(installDir);
    const service = new PersonalQqService(container(root), harnessStub(), {
      detection: { ...deps, readdir: async () => [] as string[] },
      bridge: bridgeDeps(LIVE_STATE),
      manifestsDir: MANIFESTS,
      env: {},
    });

    const result = await service.pushBridgeConfig();
    expect(result.ok).toBe(false);
    expect(result.nextStep).toContain('OneBot');
  });

  it('绑定私聊会保留已有绑定（不整份覆盖）', async () => {
    const installDir = join(await makeRoot(), 'snowluma');
    const root = await makeRoot({ route: 'personal', componentId: 'snowluma', installDir, onebotHttpPort: 3000 });
    const existing = {
      ...LIVE_STATE,
      配置: { ...LIVE_STATE.配置, 绑定: [{ 类型: '群', 号码: '888888', 会话: 'ses_group' }] },
    };
    let posted: unknown;
    const bridge: BridgeHttpDeps = {
      async get(url) {
        if (url.includes('/?token=')) return { status: 200, body: '', setCookie: ['dsh-auth-x=abc'] };
        return { status: 200, body: existing };
      },
      async post(_url, init) {
        posted = init?.body;
        return { status: 200, body: { ok: true } };
      },
    };

    const service = new PersonalQqService(container(root), harnessStub(), {
      detection: detectionDeps(installDir),
      bridge,
      manifestsDir: MANIFESTS,
      env: {},
    });

    const result = await service.bindPrivateSession({ sessionId: 'ses_dm', uin: '123456' });
    expect(result.ok).toBe(true);
    const rows = (posted as { 绑定: { 号码: string }[] }).绑定;
    expect(rows.map((row) => row.号码)).toEqual(['888888', '123456']);
  });

  it('"已验证"只写我们自己的 state 文件，不碰 SnowLuma 目录', async () => {
    const root = await makeRoot({ route: 'personal', componentId: 'snowluma', installDir: 'D:\\SnowLuma', onebotHttpPort: 3000 });
    const service = new PersonalQqService(container(root), harnessStub(), {
      detection: detectionDeps('D:\\SnowLuma', { installed: false }),
      bridge: bridgeDeps(LIVE_STATE),
      manifestsDir: MANIFESTS,
      env: {},
      now: () => new Date('2026-11-03T12:00:00.000Z'),
    });

    const saved = await service.markMessageVerified(true);
    expect(saved.messageVerifiedAt).toBe('2026-11-03T12:00:00.000Z');

    const reloaded = await service.settings();
    expect(reloaded.messageVerifiedAt).toBe('2026-11-03T12:00:00.000Z');
  });
});
