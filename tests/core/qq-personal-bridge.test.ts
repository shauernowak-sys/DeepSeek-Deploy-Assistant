import { describe, expect, it } from 'vitest';

import { extractBridgeState, pickSessionCookie, readBridgeState, toBridgeState, type BridgeHttpDeps } from '@dda/core';

/**
 * 这里的 JSON 全部来自本机对 `dsh-qq-link@1.5.1` 的真实抓取
 * （docs/evidence/m32-dual/bx1-dsh-qq-link-on-0.2.0rc2.md，令牌已替换为占位值）。
 * 目的是用**真实结构**驱动解析逻辑，而不是按文档猜字段。
 */
const REAL_STATE = {
  ok: true,
  版本: '1.5.1',
  配置: {
    总开关: false,
    试运行: true,
    私聊会话: '',
    群会话: '',
    NapCat: 'http://127.0.0.1:3000',
    令牌: 'PLACEHOLDER-TOKEN-DO-NOT-LEAK',
    轮询间隔毫秒: 2000,
  },
  配置文件: 'C:\\Users\\x\\AppData\\Local\\DeepSeekDeployAssistant\\dsh-home\\qq-bridge-config.json',
  NapCat状态: { 错: 'fetch failed' },
  活着的会话: [{ id: 'ses_1' }, { id: 'ses_2' }],
};

const STATE_OK = {
  ...REAL_STATE,
  NapCat状态: {},
};

describe('bridge 会话 cookie', () => {
  it('只挑 dsh-auth 前缀的 cookie，并保留 name=value', () => {
    const cookie = pickSessionCookie([
      'other=1; Path=/',
      'dsh-auth-abc123=secretvalue; Path=/; HttpOnly; SameSite=Lax',
    ]);
    expect(cookie).toBe('dsh-auth-abc123=secretvalue');
  });

  it('没有 cookie 时返回 undefined', () => {
    expect(pickSessionCookie(undefined)).toBeUndefined();
    expect(pickSessionCookie(['other=1; Path=/'])).toBeUndefined();
  });
});

describe('bridge 状态解析（真实结构）', () => {
  it('后端不可用时如实给出 backendError，并且不泄漏令牌', () => {
    const state = extractBridgeState(REAL_STATE);
    expect(state.ok).toBe(true);
    expect(state.backendOk).toBe(false);
    expect(state.backendError).toBe('fetch failed');
    expect(state.adapterVersion).toBe('1.5.1');
    expect(state.config?.onebotEndpoint).toBe('http://127.0.0.1:3000');
    expect(state.config?.liveSessions).toBe(2);
    expect(JSON.stringify(state)).not.toContain('PLACEHOLDER-TOKEN-DO-NOT-LEAK');
  });

  it('后端正常时 backendOk=true', () => {
    const state = extractBridgeState(STATE_OK);
    expect(state.backendOk).toBe(true);
    expect(state.backendError).toBeUndefined();
  });

  it('未鉴权响应识别为 needsAuth', () => {
    const state = extractBridgeState({ ok: false, 说: 'authentication_required' });
    expect(state.ok).toBe(false);
    expect(state.needsAuth).toBe(true);
  });

  it('toBridgeState 只输出白名单字段', () => {
    const mapped = toBridgeState({
      reachable: true,
      ok: true,
      adapterVersion: '1.5.1',
      backendOk: true,
    });
    expect(mapped).toEqual({ ok: true, adapterVersion: '1.5.1', backendOk: true, backendError: undefined });
  });
});

function deps(overrides: Partial<BridgeHttpDeps> = {}): BridgeHttpDeps {
  return {
    async get(url) {
      if (url.includes('/?token=')) return { status: 200, body: '<html>', setCookie: ['dsh-auth-x=abc; Path=/'] };
      if (url.endsWith('/dsh-qq-bridge/state')) return { status: 200, body: STATE_OK };
      return { status: 404, body: '' };
    },
    ...overrides,
  };
}

describe('readBridgeState', () => {
  it('先取 cookie 再查状态；成功后不返回令牌', async () => {
    const seen: string[] = [];
    const result = await readBridgeState(
      deps({
        async get(url, init) {
          seen.push(url);
          if (url.includes('/?token=')) return { status: 200, body: '', setCookie: ['dsh-auth-x=abc; Path=/'] };
          expect(init?.headers?.Cookie).toBe('dsh-auth-x=abc');
          return { status: 200, body: STATE_OK };
        },
      }),
      { baseUrl: 'http://127.0.0.1:18733/', token: 'harness-token-should-not-appear' },
    );

    expect(result.ok).toBe(true);
    expect(result.backendOk).toBe(true);
    expect(seen[0]).toContain('/?token=');
    expect(seeable(result)).not.toContain('harness-token-should-not-appear');
    expect(seeable(result)).not.toContain('PLACEHOLDER-TOKEN-DO-NOT-LEAK');
  });

  it('后端 fetch failed → backend-unreachable，并给出可执行下一步', async () => {
    const result = await readBridgeState(
      deps({
        async get(url) {
          if (url.includes('/?token=')) return { status: 200, body: '', setCookie: ['dsh-auth-x=abc; Path=/'] };
          return { status: 200, body: REAL_STATE };
        },
      }),
      { baseUrl: 'http://127.0.0.1:18733', token: 't' },
    );
    expect(result.ok).toBe(true);
    expect(result.backendOk).toBe(false);
    expect(result.errorCode).toBe('backend-unreachable');
    expect(result.nextStep).toContain('SnowLuma');
  });

  it('404 → 插件未加载', async () => {
    const result = await readBridgeState(
      deps({
        async get(url) {
          if (url.includes('/?token=')) return { status: 200, body: '', setCookie: ['dsh-auth-x=abc; Path=/'] };
          return { status: 404, body: 'not found' };
        },
      }),
      { baseUrl: 'http://127.0.0.1:18733', token: 't' },
    );
    expect(result.reachable).toBe(false);
    expect(result.errorCode).toBe('bridge-route-missing');
    expect(result.nextStep).toContain('安装 / 修复适配插件');
  });

  it('authentication_required → 明确是 cookie/鉴权问题', async () => {
    const result = await readBridgeState(
      deps({
        async get(url) {
          if (url.includes('/?token=')) return { status: 200, body: '', setCookie: [] };
          return { status: 200, body: { ok: false, 说: 'authentication_required' } };
        },
      }),
      { baseUrl: 'http://127.0.0.1:18733', token: 't' },
    );
    expect(result.errorCode).toBe('bridge-auth-required');
    expect(result.errorMessage).toContain('cookie');
  });

  it('Harness 前端都连不上 → harness-not-running', async () => {
    const result = await readBridgeState(
      deps({
        async get() {
          throw new Error('connect ECONNREFUSED');
        },
      }),
      { baseUrl: 'http://127.0.0.1:18733', token: 't' },
    );
    expect(result.errorCode).toBe('harness-not-running');
    expect(result.nextStep).toContain('启动 Harness');
  });
});

function seeable(value: unknown): string {
  return JSON.stringify(value);
}
