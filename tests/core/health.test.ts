import { describe, expect, it } from 'vitest';

import { classifyStatus, looksLikeAppShell, probeHarness } from '@dda/core';

const shell = '<!doctype html><html><body><div id="root"></div></body></html>';

function stubFetch(handler: (url: string, headers: Record<string, string>) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), (init?.headers ?? {}) as Record<string, string>)) as typeof fetch;
}

describe('classifyStatus', () => {
  it('401/403 只代表存活，不代表可用', () => {
    expect(classifyStatus(401)).toBe('alive');
    expect(classifyStatus(403)).toBe('alive');
  });

  it('200/303 代表鉴权通过，5xx/0 代表不可达', () => {
    expect(classifyStatus(200)).toBe('authorized');
    expect(classifyStatus(303)).toBe('authorized');
    expect(classifyStatus(500)).toBe('down');
    expect(classifyStatus(0)).toBe('down');
  });
});

describe('probeHarness', () => {
  it('无 token 时 401 → alive（不能升级为可用）', async () => {
    const report = await probeHarness({
      baseUrl: 'http://127.0.0.1:1234',
      fetchImpl: stubFetch(() => new Response('auth required', { status: 401 })),
    });
    expect(report.level).toBe('alive');
    expect(report.httpStatus).toBe(401);
  });

  it('token 被接受并返回应用外壳 → usable', async () => {
    const fetchImpl = stubFetch((url, headers) => {
      if (url.includes('/app')) {
        return headers.cookie ? new Response(shell, { status: 200 }) : new Response('denied', { status: 401 });
      }
      if (!url.includes('token=')) return new Response('auth required', { status: 401 });
      if (!headers.cookie) {
        return new Response(null, { status: 303, headers: { location: '/app', 'set-cookie': 'sid=abc; Path=/' } });
      }
      return new Response(shell, { status: 200 });
    });
    const report = await probeHarness({ baseUrl: 'http://127.0.0.1:1234', token: 'tok', fetchImpl });
    expect(report.level).toBe('usable');
  });

  it('token 被接受但只有 JSON → 停在 authorized，不谎报可用', async () => {
    const fetchImpl = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const report = await probeHarness({ baseUrl: 'http://127.0.0.1:1234', token: 'tok', fetchImpl });
    expect(report.level).toBe('authorized');
    expect(report.detail).toContain('业务可用性未证实');
  });

  it('连接失败 → down', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const report = await probeHarness({ baseUrl: 'http://127.0.0.1:1', fetchImpl });
    expect(report.level).toBe('down');
  });

  it('识别应用外壳', () => {
    expect(looksLikeAppShell(shell)).toBe(true);
    expect(looksLikeAppShell('<html><body>hello</body></html>')).toBe(false);
  });
});
