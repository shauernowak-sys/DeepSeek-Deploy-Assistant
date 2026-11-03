import type { PersonalQqBridgeState } from '@dda/spec';

/**
 * 适配层（dsh-qq-link）状态读取。
 *
 * 接口事实来自本机实测（docs/evidence/m32-dual/bx1-dsh-qq-link-on-0.2.0rc2.md）：
 *   1. `GET /?token=<harness token>` 会下发会话 cookie（`dsh-auth-…`）；
 *   2. `GET /dsh-qq-bridge/state` 只有在带上该 cookie 时才返回 `{ ok: true, 版本, 配置, NapCat状态, … }`，
 *      否则返回 `{ ok: false, 说: "authentication_required" }`。
 *
 * 安全：该 JSON 里含 `配置.令牌`（OneBot access token）。本模块**只提取白名单字段**，
 * 绝不把原始 body 或令牌透出给 UI/日志/诊断。
 */

export interface BridgeBinding {
  类型: string;
  号码: string;
  会话: string;
  称呼?: string;
  开?: boolean;
  门槛?: boolean;
}

export interface BridgeHttpDeps {
  get(
    url: string,
    init?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ status: number; body: unknown; setCookie?: string[] }>;
  post?(
    url: string,
    init?: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number },
  ): Promise<{ status: number; body: unknown; setCookie?: string[] }>;
}

export type BridgeErrorCode =
  | 'harness-not-running'
  | 'adapter-not-installed'
  | 'bridge-route-missing'
  | 'bridge-auth-required'
  | 'backend-unreachable'
  | 'backend-error'
  | 'unknown';

export interface BridgeReadResult {
  /** 状态接口是否真的应答（HTTP 2xx 且 JSON 可解析）。 */
  reachable: boolean;
  /** 插件自述 `ok`（含鉴权通过）。 */
  ok: boolean;
  httpStatus?: number;
  adapterVersion?: string;
  /** OneBot 后端是否可用（来自插件自述的 `NapCat状态`，字段名沿用上游，实质是 OneBot 后端）。 */
  backendOk: boolean;
  backendError?: string;
  /** 白名单化的配置摘要（不含令牌）。 */
  config?: { enabled?: boolean; dryRun?: boolean; onebotEndpoint?: string; liveSessions?: number };
  /** 插件自述"活着的会话" id 列表（用于把 QQ 消息绑到某个 Harness 会话）。 */
  sessionIds?: string[];
  /** 现有聊天绑定（非机密；写回时用于保留用户已有配置）。 */
  bindings?: BridgeBinding[];
  errorCode?: BridgeErrorCode;
  errorMessage?: string;
  nextStep?: string;
}

interface RawState {
  ok?: unknown;
  说?: unknown;
  版本?: unknown;
  配置?: Record<string, unknown>;
  NapCat状态?: Record<string, unknown>;
  活着的会话?: unknown[];
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const asBool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

/** 从 `Set-Cookie` 里挑出 Harness 的会话 cookie（只需要 `name=value`）。 */
export function pickSessionCookie(setCookie: string[] | undefined): string | undefined {
  if (!setCookie?.length) return undefined;
  for (const raw of setCookie) {
    const pair = raw.split(';')[0]?.trim();
    if (!pair) continue;
    const [name] = pair.split('=');
    if (name && name.startsWith('dsh-auth')) return pair;
  }
  return undefined;
}

/** 只取白名单字段；任何未知/敏感字段一律丢弃。 */
export function extractBridgeState(body: unknown): Pick<
  BridgeReadResult,
  'ok' | 'adapterVersion' | 'backendOk' | 'backendError' | 'config' | 'sessionIds' | 'bindings'
> & {
  needsAuth: boolean;
  message?: string;
} {
  if (body == null || typeof body !== 'object') {
    return { ok: false, backendOk: false, needsAuth: false, sessionIds: [], bindings: [] };
  }
  const raw = body as RawState;
  const ok = raw.ok === true;
  const message = asString(raw.说);

  if (!ok) {
    return {
      ok: false,
      backendOk: false,
      needsAuth: message === 'authentication_required',
      message,
      sessionIds: [],
      bindings: [],
    };
  }

  const backend = raw.NapCat状态 ?? {};
  const backendError = asString(backend.错) ?? asString(backend.error);
  const config = raw.配置 ?? {};
  const rawSessions = raw.活着的会话;
  const sessionIds = Array.isArray(rawSessions)
    ? rawSessions
        .map((item) => (item != null && typeof item === 'object' ? asString((item as { id?: unknown }).id) : undefined))
        .filter((id): id is string => Boolean(id))
    : [];

  const rawBindings = config.绑定;
  const rows: (BridgeBinding | undefined)[] = Array.isArray(rawBindings)
    ? rawBindings.map((item) => {
        if (item == null || typeof item !== 'object') return undefined;
        const row = item as Record<string, unknown>;
        const type = asString(row.类型);
        const number = asString(row.号码);
        const session = asString(row.会话);
        if (!type || !number || !session) return undefined;
        return {
          类型: type,
          号码: number,
          会话: session,
          称呼: asString(row.称呼),
          开: asBool(row.开),
          门槛: asBool(row.门槛),
        };
      })
    : [];
  const bindings = rows.filter((row): row is BridgeBinding => row !== undefined);

  return {
    ok: true,
    needsAuth: false,
    adapterVersion: asString(raw.版本),
    backendOk: !backendError,
    backendError,
    sessionIds,
    bindings,
    config: {
      enabled: asBool(config.总开关),
      dryRun: asBool(config.试运行),
      onebotEndpoint: asString(config.NapCat),
      liveSessions: sessionIds.length,
    },
  };
}

export interface ReadBridgeInput {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

/**
 * 读取 bridge 状态。分两步：取 cookie → 查状态。
 * 两步都可能失败，错误信息里**只保留路径**，不含 token。
 */
export async function readBridgeState(deps: BridgeHttpDeps, input: ReadBridgeInput): Promise<BridgeReadResult> {
  const base = input.baseUrl.replace(/\/+$/, '');
  const timeoutMs = input.timeoutMs ?? 2500;

  let cookie: string | undefined;
  try {
    const root = await deps.get(`${base}/?token=${encodeURIComponent(input.token)}`, { timeoutMs });
    cookie = pickSessionCookie(root.setCookie);
    if (!cookie) {
      // 没拿到 cookie 也继续尝试一次：某些宿主允许直接访问（此时会返回 authentication_required）。
      cookie = undefined;
    }
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      backendOk: false,
      errorCode: 'harness-not-running',
      errorMessage: `无法访问 Harness 前端（${error instanceof Error ? error.message : String(error)}）`,
      nextStep: '先启动 Harness（第 2 节「启动 Harness」），再回到这里重新检测。',
    };
  }

  let status: number;
  let body: unknown;
  try {
    const response = await deps.get(`${base}/dsh-qq-bridge/state`, {
      headers: cookie ? { Cookie: cookie } : {},
      timeoutMs,
    });
    status = response.status;
    body = response.body;
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      backendOk: false,
      errorCode: 'bridge-route-missing',
      errorMessage: `状态接口不可访问（${error instanceof Error ? error.message : String(error)}）`,
      nextStep: '确认 Harness 正在运行，且适配插件已安装（第 4 步）。',
    };
  }

  if (status === 404) {
    return {
      reachable: false,
      ok: false,
      httpStatus: status,
      backendOk: false,
      errorCode: 'bridge-route-missing',
      errorMessage: 'Harness 里没有 /dsh-qq-bridge/state（适配插件未加载）',
      nextStep: '点「安装 / 修复适配插件」，然后重启 Harness 再检测。',
    };
  }

  const extracted = extractBridgeState(body);
  if (!extracted.ok) {
    return {
      reachable: status >= 200 && status < 300,
      ok: false,
      httpStatus: status,
      backendOk: false,
      errorCode: extracted.needsAuth ? 'bridge-auth-required' : 'unknown',
      errorMessage: extracted.needsAuth
        ? '状态接口要求鉴权：没有拿到 Harness 会话 cookie'
        : `状态接口返回失败${extracted.message ? `（${extracted.message}）` : ''}`,
      nextStep: extracted.needsAuth
        ? '重启 Harness 后重新检测；若仍失败，先用浏览器打开一次 Harness 页面。'
        : '看下方证据；必要时重启 Harness 再检测。',
    };
  }

  if (!extracted.backendOk) {
    return {
      reachable: true,
      ok: true,
      httpStatus: status,
      adapterVersion: extracted.adapterVersion,
      backendOk: false,
      backendError: extracted.backendError ?? '未知错误',
      config: extracted.config,
      sessionIds: extracted.sessionIds,
      bindings: extracted.bindings,
      errorCode: 'backend-unreachable',
      errorMessage: `OneBot 后端不可用：${extracted.backendError ?? '未知错误'}`,
      nextStep:
        '确认 SnowLuma 正在运行、已登录 QQ，且 OneBot HTTP 服务端口与这里一致（默认 3000）。改完后点「重新检测」。',
    };
  }

  return {
    reachable: true,
    ok: true,
    httpStatus: status,
    adapterVersion: extracted.adapterVersion,
    backendOk: true,
    config: extracted.config,
    sessionIds: extracted.sessionIds,
    bindings: extracted.bindings,
  };
}

/** 转成 UI/契约层的结构（不含任何原始 body）。 */
export function toBridgeState(result: BridgeReadResult): PersonalQqBridgeState {
  return {
    ok: result.ok && result.backendOk,
    adapterVersion: result.adapterVersion,
    backendOk: result.backendOk,
    backendError: result.backendError,
  };
}

export interface BridgeSaveInput {
  baseUrl: string;
  token: string;
  /** 只发送我们要改的键；其余配置由插件保留。键名与插件配置一致（中文键）。 */
  patch: Record<string, unknown>;
  timeoutMs?: number;
}

export interface BridgeSaveResult {
  ok: boolean;
  httpStatus?: number;
  /** 已脱敏的失败原因。 */
  error?: string;
}

/**
 * 把 OneBot 端点/令牌等写进适配插件配置。
 *
 * 只写"我们要改的键"，不整份覆盖：插件会自己合并并持久化（README：`存配置（body 里给要改的键）`）。
 * 调用方必须保证 `patch` 里不含日志/诊断会用到的敏感值以外的内容；本函数不回显 body。
 */
export async function postBridgeConfig(deps: BridgeHttpDeps, input: BridgeSaveInput): Promise<BridgeSaveResult> {
  const base = input.baseUrl.replace(/\/+$/, '');
  const timeoutMs = input.timeoutMs ?? 3000;

  if (!deps.post) return { ok: false, error: '当前宿主不支持 POST（内部错误）' };

  let cookie: string | undefined;
  try {
    const root = await deps.get(`${base}/?token=${encodeURIComponent(input.token)}`, { timeoutMs });
    cookie = pickSessionCookie(root.setCookie);
  } catch {
    return { ok: false, error: '无法访问 Harness 前端（Harness 可能未运行）' };
  }

  try {
    const response = await deps.post(`${base}/dsh-qq-bridge/save`, {
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: input.patch,
      timeoutMs,
    });
    const body = response.body as { ok?: unknown } | undefined;
    if (response.status >= 200 && response.status < 300 && body?.ok !== false) {
      return { ok: true, httpStatus: response.status };
    }
    return { ok: false, httpStatus: response.status, error: `保存被拒绝（HTTP ${response.status}）` };
  } catch (error) {
    return {
      ok: false,
      error: `保存失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}