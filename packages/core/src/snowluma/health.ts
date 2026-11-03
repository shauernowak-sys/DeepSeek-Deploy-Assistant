import { probeOneBot, sanitizeSecrets, type HttpJsonResult } from '../qq/personal/detect/onebot';

/**
 * SnowLuma 运行健康检查（M3.3-05）。
 *
 * 判据分层，禁止"端口能连 = 已就绪"：
 *  1. TCP 能连（WebUI / OneBot HTTP）；
 *  2. OneBot `get_login_info` 返回**真实 QQ 号** → 才算"接口活着且已登录"；
 *  3. 只有 1 没有 2 时，明确区分"没起服务"、"没登录"、"令牌错"。
 */

export interface HealthDeps {
  connect(host: string, port: number, timeoutMs: number): Promise<boolean>;
  getJson(
    url: string,
    init: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<HttpJsonResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

interface WaitResult {
  ok: boolean;
  attempts: number;
  elapsedMs: number;
  error?: string;
}

export async function waitForTcp(
  deps: HealthDeps,
  options: { host: string; port: number; timeoutMs: number; intervalMs?: number; label?: string },
): Promise<WaitResult> {
  const started = deps.now();
  const interval = options.intervalMs ?? 500;
  let attempts = 0;
  let lastError: string | undefined;
  while (deps.now() - started < options.timeoutMs) {
    attempts += 1;
    try {
      if (await deps.connect(options.host, options.port, 1200)) {
        return { ok: true, attempts, elapsedMs: deps.now() - started };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await deps.sleep(interval);
  }
  return {
    ok: false,
    attempts,
    elapsedMs: deps.now() - started,
    error: `${options.label ?? '端口'} ${options.host}:${options.port} 在 ${Math.round(options.timeoutMs / 1000)} 秒内没有响应${
      lastError ? `（${lastError}）` : ''
    }`,
  };
}

interface OneBotHealth {
  reachable: boolean;
  responsive: boolean;
  uin?: string;
  nickname?: string;
  error?: string;
}

export async function checkOneBot(
  deps: Pick<HealthDeps, 'getJson'>,
  options: { baseUrl: string; accessToken?: string; timeoutMs?: number },
): Promise<OneBotHealth> {
  const result = await probeOneBot(
    { getJson: (url, init) => deps.getJson(url, init) },
    { baseUrl: options.baseUrl, accessToken: options.accessToken, timeoutMs: options.timeoutMs ?? 2000 },
  );
  return {
    reachable: result.reachable,
    responsive: result.responsive,
    uin: result.uin,
    nickname: result.nickname,
    error: result.error ? sanitizeSecrets(result.error, [options.accessToken]) : undefined,
  };
}
