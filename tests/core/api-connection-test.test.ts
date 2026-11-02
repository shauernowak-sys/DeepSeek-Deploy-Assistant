import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { testConnection, type ApiProviderConfig } from '@dda/core';

const KEY = 'sk-unit-test-secret-value-123456';

const anthropic: ApiProviderConfig = {
  template: 'deepseek',
  label: 'DeepSeek 官方',
  protocol: 'anthropic-messages',
  baseUrl: 'http://127.0.0.1:1',
  model: 'deepseek-flash',
  credentialRef: 'DEEPSEEK_API_KEY',
};

const openai: ApiProviderConfig = {
  template: 'openai-compatible',
  label: 'Gateway',
  protocol: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1',
  model: 'gw-model',
  credentialRef: 'DDA_GATEWAY_KEY',
};

interface Stub {
  server: Server;
  baseUrl: string;
  requests: { url: string; headers: Record<string, unknown>; body: string }[];
}

const stubs: Stub[] = [];

async function startStub(
  handler: (req: { url: string; headers: Record<string, unknown>; body: string }, res: import('node:http').ServerResponse, delayMs?: number) => void,
  delayMs = 0,
): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const hit = { url: req.url ?? '', headers: req.headers as Record<string, unknown>, body };
      requests.push(hit);
      const send = () => handler(hit, res);
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const stub: Stub = { server, baseUrl: `http://127.0.0.1:${port}`, requests };
  stubs.push(stub);
  return stub;
}

afterEach(async () => {
  await Promise.all(
    stubs.splice(0).map((stub) => new Promise<void>((resolve) => stub.server.close(() => resolve()))),
  );
});

function json(res: import('node:http').ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('连接测试：成功路径（本地真实 HTTP 服务，非真实模型）', () => {
  it('Anthropic Messages 协议：请求 /v1/messages 并解析回复', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { model: 'deepseek-flash', content: [{ type: 'text', text: 'pong' }] }),
    );
    const result = await testConnection({ ...anthropic, baseUrl: stub.baseUrl }, KEY);
    expect(result.verdict).toBe('ok');
    expect(result.model).toBe('deepseek-flash');
    expect(result.message).toContain('连接成功');
    expect(stub.requests[0]!.url).toBe('/v1/messages');
    expect(stub.requests[0]!.headers['x-api-key']).toBe(KEY);
    expect(String(stub.requests[0]!.headers['anthropic-version'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('OpenAI 兼容协议：请求 /v1/chat/completions 并解析 choices', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { model: 'gw-model', choices: [{ message: { role: 'assistant', content: 'pong' } }] }),
    );
    const result = await testConnection({ ...openai, baseUrl: `${stub.baseUrl}/v1` }, KEY);
    expect(result.verdict).toBe('ok');
    expect(stub.requests[0]!.url).toBe('/v1/chat/completions');
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('Base URL 已含 /v1 时不会重复拼接', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { model: 'gw-model', choices: [{ message: { content: 'pong' } }] }),
    );
    await testConnection({ ...openai, baseUrl: `${stub.baseUrl}/v1` }, KEY);
    expect(stub.requests[0]!.url).toBe('/v1/chat/completions');
  });
});

describe('连接测试：错误分类（不得只看 HTTP 200）', () => {
  const cases: { status: number; verdict: string; label: string }[] = [
    { status: 401, verdict: 'auth', label: '鉴权失败' },
    { status: 403, verdict: 'auth', label: '无权限' },
    { status: 404, verdict: 'model-not-found', label: '模型/路径不存在' },
    { status: 429, verdict: 'quota', label: '配额/限流' },
    { status: 500, verdict: 'server', label: '服务端错误' },
    { status: 503, verdict: 'server', label: '服务端不可用' },
  ];
  for (const testCase of cases) {
    it(`${testCase.label}（HTTP ${testCase.status}）`, async () => {
      const stub = await startStub((_req, res) => json(res, testCase.status, { error: { message: 'nope' } }));
      const result = await testConnection({ ...anthropic, baseUrl: stub.baseUrl }, KEY);
      expect(result.verdict).toBe(testCase.verdict);
      expect(result.httpStatus).toBe(testCase.status);
      expect(result.nextStep.length).toBeGreaterThan(0);
    });
  }

  it('HTTP 200 但响应不是 JSON → bad-response', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login page</html>');
    });
    const result = await testConnection({ ...openai, baseUrl: stub.baseUrl }, KEY);
    expect(result.verdict).toBe('bad-response');
  });

  it('HTTP 200 且是 JSON 但没有模型回复 → bad-response', async () => {
    const stub = await startStub((_req, res) => json(res, 200, { ok: true }));
    const result = await testConnection({ ...openai, baseUrl: stub.baseUrl }, KEY);
    expect(result.verdict).toBe('bad-response');
  });

  /**
   * 真实 DeepSeek（deepseek-flash）在 max_tokens 很小时会把预算全花在 thinking 块上、完全不返回
   * text 块；这是正常可用的连接。旧实现按"必须找到 text"判定，把这种响应误报成 bad-response。
   */
  it('Anthropic 响应只有 thinking 块、没有 text → 仍判 ok', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [{ type: 'thinking', thinking: 'The user just said "ping".' }],
        stop_reason: 'max_tokens',
      }),
    );
    const result = await testConnection({ ...anthropic, baseUrl: stub.baseUrl }, KEY);
    expect(result.verdict).toBe('ok');
    expect(result.message).toContain('连接成功');
    expect(result.steps?.find((s) => s.stage === 'response')?.detail).toContain('内容块');
  });

  it('Anthropic 响应 content 为空数组 → 仍判 bad-response', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { type: 'message', role: 'assistant', content: [] }),
    );
    const result = await testConnection({ ...anthropic, baseUrl: stub.baseUrl }, KEY);
    expect(result.verdict).toBe('bad-response');
  });

  it('OpenAI 兼容响应只给 reasoning_content、content 为空 → 仍判 ok', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'thinking…' } }] }),
    );
    const result = await testConnection({ ...openai, baseUrl: stub.baseUrl }, KEY);
    expect(result.verdict).toBe('ok');
    expect(result.steps?.find((s) => s.stage === 'response')?.detail).toContain('reasoning_content');
  });

  it('超时 → timeout', async () => {
    const stub = await startStub((_req, res) => json(res, 200, { choices: [{ message: { content: 'late' } }] }), 800);
    const result = await testConnection({ ...openai, baseUrl: stub.baseUrl }, KEY, { timeoutMs: 150 });
    expect(result.verdict).toBe('timeout');
  });

  it('域名解析失败 → dns', async () => {
    const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const result = await testConnection({ ...openai, baseUrl: 'https://service.invalid' }, KEY, {
      timeoutMs: 2000,
      resolveHost: async () => {
        throw enotfound;
      },
    });
    expect(result.verdict).toBe('dns');
    expect(result.nextStep).toMatch(/网络|代理/);
  });

  it('端口关闭 → network', async () => {
    const result = await testConnection({ ...openai, baseUrl: 'http://127.0.0.1:9' }, KEY, { timeoutMs: 2000 });
    expect(result.verdict).toBe('network');
  });

  it('没有密钥时直接给出 config，不发起请求', async () => {
    const stub = await startStub((_req, res) => json(res, 200, { choices: [{ message: { content: 'x' } }] }));
    const result = await testConnection({ ...openai, baseUrl: stub.baseUrl }, '');
    expect(result.verdict).toBe('config');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('连接测试：不泄露密钥', () => {
  it('结果对象里任何字段都不含密钥', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 401, { error: { message: `invalid key ${KEY}` } }),
    );
    const result = await testConnection({ ...openai, baseUrl: stub.baseUrl }, KEY);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KEY);
    expect(serialized).toContain('[redacted]');
  });
});
