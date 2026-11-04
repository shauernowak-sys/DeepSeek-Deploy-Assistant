import { connect } from 'node:net';

/**
 * P-11 失效代理检测。
 *
 * 现场问题（docs/M4-前置验证报告.md §0.3.1）：VPN 客户端关闭后 `HTTP(S)_PROXY` 仍指向死端口，
 * `npm view` 从 <1 s 退化到 70.6 s；而 `dshEnv()` 会把 `process.env` 原样传给子进程。
 *
 * 规则：
 * - 只探测、只**在本软件的子进程**里剔除不可达的代理变量，绝不改系统设置、不 unset 用户环境；
 * - `NO_PROXY` 原样保留（它本来就是"哪些地址不要走代理"的声明）；
 * - 探测失败按"不可达"处理，宁可少走代理，也不要让安装卡在 70 s 重试上。
 */

export const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const;

export interface ProxySetting {
  name: string;
  url: string;
}

export interface ProxyProbeOptions {
  timeoutMs?: number;
  /** 注入 TCP 连接实现，便于单测（真实实现见 `defaultTcpProbe`）。 */
  connectImpl?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export interface DeadProxyReport {
  dead: ProxySetting[];
  reachable: ProxySetting[];
}

/** 解析代理环境变量；非 http(s) 与无法解析的值直接忽略（它们本来也不会被 npm 使用）。 */
export function parseProxySettings(env: NodeJS.ProcessEnv = process.env): ProxySetting[] {
  const seen = new Set<string>();
  const settings: ProxySetting[] = [];
  for (const name of PROXY_VARS) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const url = raw.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    settings.push({ name, url });
  }
  return settings;
}

export function defaultTcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function probeProxy(url: string, options: ProxyProbeOptions = {}): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return false;
  const probe = options.connectImpl ?? defaultTcpProbe;
  try {
    return await probe(parsed.hostname, port, options.timeoutMs ?? 1500);
  } catch {
    return false;
  }
}

export async function findDeadProxySettings(
  env: NodeJS.ProcessEnv = process.env,
  options: ProxyProbeOptions = {},
): Promise<DeadProxyReport> {
  const dead: ProxySetting[] = [];
  const reachable: ProxySetting[] = [];
  for (const setting of parseProxySettings(env)) {
    const ok = await probeProxy(setting.url, options);
    (ok ? reachable : dead).push(setting);
  }
  return { dead, reachable };
}

/** 返回去掉指定变量的**副本**；`process.env` 本身不被修改。 */
export function stripProxyEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of names) delete next[name];
  return next;
}

export function describeProxyReport(report: DeadProxyReport): string {
  if (report.dead.length === 0 && report.reachable.length === 0) return '未设置代理环境变量';
  const parts: string[] = [];
  if (report.reachable.length > 0) {
    parts.push(`可用：${report.reachable.map((item) => `${item.name}=${item.url}`).join(', ')}`);
  }
  if (report.dead.length > 0) {
    parts.push(`不可达（仅在本软件子进程中剔除）：${report.dead.map((item) => item.name).join(', ')}`);
  }
  return parts.join('；');
}
