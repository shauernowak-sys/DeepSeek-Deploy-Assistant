import { join } from 'node:path';

/**
 * 读取 SnowLuma 的 OneBot 端点与访问令牌（**只读**）。
 *
 * 上游默认会为 `http-default` 生成随机 accessToken 并写入 `config/onebot*.json`；
 * 没有它，任何 OneBot 调用都会被拒。我们只读取、只在内存里传递，绝不写日志/诊断包。
 */

export interface OneBotConfigDeps {
  readdir(path: string): Promise<string[]>;
  readJson(path: string): Promise<unknown>;
}

export interface OneBotEndpoint {
  baseUrl: string;
  accessToken?: string;
  /** 来源文件名（用于证据展示，不含内容）。 */
  sourceFile: string;
  port: number;
}

export interface OneBotEndpointResult {
  endpoint?: OneBotEndpoint;
  /** 证据行（已确保不含令牌）。 */
  evidence: string[];
}

interface HttpServerShape {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  accessToken?: unknown;
  enabled?: unknown;
}

function pickServer(raw: unknown): HttpServerShape | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const networks = (raw as { networks?: unknown }).networks;
  if (networks == null || typeof networks !== 'object') return undefined;
  const servers = (networks as { httpServers?: unknown }).httpServers;
  if (!Array.isArray(servers)) return undefined;
  const typed = servers.filter((item): item is HttpServerShape => item != null && typeof item === 'object');
  const enabled = typed.filter((item) => item.enabled !== false);
  return (
    enabled.find((item) => item.name === 'http-default') ??
    enabled.find((item) => typeof item.port === 'number') ??
    enabled[0]
  );
}

export async function readOneBotEndpoint(
  deps: OneBotConfigDeps,
  options: { installDir: string; configDir?: string; defaultPort: number; host?: string },
): Promise<OneBotEndpointResult> {
  const configDir = join(options.installDir, options.configDir ?? 'config');
  const evidence: string[] = [];

  let files: string[];
  try {
    files = (await deps.readdir(configDir)).filter((name) => /^onebot(_\d+)?\.json$/.test(name));
  } catch {
    return { evidence: [`配置读取：${configDir} 不存在或不可读`] };
  }
  if (files.length === 0) {
    return { evidence: [`配置读取：${configDir} 下没有 onebot*.json（还没有完成 OneBot 配置）`] };
  }

  // 账号级配置优先于全局配置（与上游"per-uin 覆盖 global"的语义一致）。
  const perAccount = files.filter((name) => /^onebot_\d+\.json$/.test(name)).sort();
  const ordered = [...perAccount, ...files.filter((name) => name === 'onebot.json')];

  for (const fileName of ordered) {
    let server: HttpServerShape | undefined;
    try {
      server = pickServer(await deps.readJson(join(configDir, fileName)));
    } catch {
      evidence.push(`配置读取：${fileName} 无法解析`);
      continue;
    }
    if (!server) continue;

    const port = typeof server.port === 'number' ? server.port : options.defaultPort;
    const host = typeof server.host === 'string' && server.host ? server.host : (options.host ?? '127.0.0.1');
    const accessToken = typeof server.accessToken === 'string' && server.accessToken ? server.accessToken : undefined;
    evidence.push(
      `配置读取：${fileName} 中 http-default 为 ${host}:${port}（${accessToken ? '带访问令牌' : '无访问令牌'}）`,
    );
    return { endpoint: { baseUrl: `http://${host}:${port}`, accessToken, sourceFile: fileName, port }, evidence };
  }

  evidence.push('配置读取：找到了 onebot 配置，但没有可用的 httpServers 条目');
  return { evidence };
}
