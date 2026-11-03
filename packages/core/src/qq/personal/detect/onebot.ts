/**
 * OneBot v11 HTTP 探测（SnowLuma 侧）。
 *
 * 只用 `get_login_info` 作为"接口真的活着"的证据：它必须返回**真实 QQ 号**，
 * 端口能连、或随便返回 200 都不算（PRD §10.4、§9.4 PQ-8）。
 * 令牌通过 Authorization 头传递，**不进 URL**，避免出现在日志/代理记录里。
 */

export interface HttpJsonResult {
  status: number;
  body: unknown;
}

export interface OneBotDeps {
  getJson(
    url: string,
    init: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<HttpJsonResult>;
}

export interface OneBotProbe {
  reachable: boolean;
  responsive: boolean;
  uin?: string;
  nickname?: string;
  /** 已脱敏的失败原因。 */
  error?: string;
}

/** 把已知机密从任意文本里抹掉（错误信息、证据行都走这里）。 */
export function sanitizeSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join('***');
  }
  return out.replace(/access_token=[^&\s]+/gi, 'access_token=***');
}

interface LoginInfoShape {
  user_id?: unknown;
  uin?: unknown;
  nickname?: unknown;
}

function readShape(body: unknown): { uin?: string; nickname?: string } {
  if (body == null || typeof body !== 'object') return {};
  const root = body as Record<string, unknown>;
  const data = (root.data ?? root) as LoginInfoShape;
  const rawUin = data.user_id ?? data.uin;
  const uin =
    typeof rawUin === 'number' ? String(rawUin) : typeof rawUin === 'string' && rawUin ? rawUin : undefined;
  const nickname = typeof data.nickname === 'string' && data.nickname ? data.nickname : undefined;
  return { uin, nickname };
}

export async function probeOneBot(
  deps: OneBotDeps,
  options: { baseUrl: string; accessToken?: string; timeoutMs?: number },
): Promise<OneBotProbe> {
  const base = options.baseUrl.replace(/\/+$/, '');
  const url = `${base}/get_login_info`;
  const headers: Record<string, string> = {};
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  let result: HttpJsonResult;
  try {
    result = await deps.getJson(url, { headers, timeoutMs: options.timeoutMs ?? 2000 });
  } catch (error) {
    return {
      reachable: false,
      responsive: false,
      error: sanitizeSecrets(error instanceof Error ? error.message : String(error), [options.accessToken]),
    };
  }

  const { uin, nickname } = readShape(result.body);
  if (result.status !== 200) {
    return { reachable: true, responsive: false, error: `OneBot 返回 HTTP ${result.status}` };
  }
  if (!uin) {
    const detail =
      typeof result.body === 'object' && result.body !== null
        ? JSON.stringify(result.body).slice(0, 200)
        : String(result.body).slice(0, 200);
    return {
      reachable: true,
      responsive: false,
      error: sanitizeSecrets(`get_login_info 没有返回 QQ 号：${detail}`, [options.accessToken]),
    };
  }
  return { reachable: true, responsive: true, uin, nickname };
}
