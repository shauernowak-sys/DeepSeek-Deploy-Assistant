import type { HealthLevel, HealthReport } from '@dda/spec';

export interface ProbeInput {
  baseUrl: string;
  /** Token printed by `dsh web` (query string). Optional: without it we can only prove liveness. */
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Three levels, deliberately separated:
 *  - `alive`      : TCP/HTTP answered (401 counts — the server requires auth but is up)
 *  - `authorized` : the token is accepted (303 redirect or 200 on the tokenised URL)
 *  - `usable`     : after the auth hand-off we actually receive the app shell (business check)
 *
 * Treating 401 as "healthy" alone would overstate readiness, which the architecture forbids.
 */
export function classifyStatus(status: number): HealthLevel {
  if (status === 0) return 'down';
  if (status === 401 || status === 403) return 'alive';
  if (status === 200 || status === 204 || status === 302 || status === 303) return 'authorized';
  if (status >= 500) return 'down';
  return 'alive';
}

export async function probeHarness(input: ProbeInput): Promise<HealthReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 3_000;
  const base = input.baseUrl.replace(/\/$/, '');
  const checkedAt = new Date().toISOString();

  const call = async (url: string, headers: Record<string, string> = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  // 1) liveness (no credentials expected to succeed)
  let status: number;
  let body = '';
  try {
    const anonymous = await call(`${base}/`);
    status = anonymous.status;
    body = await safeText(anonymous);
  } catch (error) {
    return {
      level: 'down',
      url: base,
      port: portOf(base),
      httpStatus: 0,
      detail: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  }

  let level = classifyStatus(status);
  let detail = level === 'alive' ? `服务在线（HTTP ${status} 需要鉴权）` : `HTTP ${status}`;

  if (input.token && level !== 'down') {
    try {
      const authorized = await call(`${base}/?token=${encodeURIComponent(input.token)}`);
      const cookie = authorized.headers.get('set-cookie') ?? '';
      const cookiePair = cookie.split(';')[0] ?? '';
      let authorizedLevel = classifyStatus(authorized.status);
      let authorizedBody = await safeText(authorized);

      // Follow the auth hand-off once, carrying the cookie, to prove the app shell is served.
      if (authorized.status === 303 || authorized.status === 302) {
        const location = authorized.headers.get('location') ?? '/';
        const target = location.startsWith('http') ? location : `${base}${location.startsWith('/') ? '' : '/'}${location}`;
        const shell = await call(target, cookiePair ? { cookie: cookiePair } : {});
        authorizedBody = await safeText(shell);
        if (shell.status === 200 && looksLikeAppShell(authorizedBody)) {
          authorizedLevel = 'usable';
        } else if (shell.status === 200) {
          authorizedLevel = 'authorized';
        }
      } else if (authorizedLevel === 'authorized' && looksLikeAppShell(authorizedBody)) {
        authorizedLevel = 'usable';
      }

      if (authorizedLevel === 'authorized' && (authorizedBody === '' || looksLikeJson(authorizedBody))) {
        // Keep "authorized" but flag that business readiness was not proven.
        detail = `鉴权通过（HTTP ${authorized.status}），业务可用性未证实`;
      } else if (authorizedLevel === 'usable') {
        detail = '鉴权通过，已返回应用外壳';
      } else {
        detail = `鉴权未通过（HTTP ${authorized.status}）`;
      }
      level = authorizedLevel === 'authorized' ? 'authorized' : authorizedLevel;
      body = authorizedBody;
    } catch (error) {
      detail = `鉴权探测失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    level,
    url: base,
    port: portOf(base),
    httpStatus: status,
    detail: detail || `HTTP ${status} ${body.slice(0, 60)}`,
    checkedAt,
  };
}

export function looksLikeAppShell(body: string): boolean {
  const lowered = body.toLowerCase();
  return lowered.includes('<div id="root"') || lowered.includes('<div id=root') || lowered.includes('dsh-app://');
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export function portOf(url: string): number {
  try {
    const parsed = new URL(url);
    return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  } catch {
    return 0;
  }
}
