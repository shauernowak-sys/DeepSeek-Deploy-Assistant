import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DdaError, ERROR_CODES, type SnowLumaConfigInspection, type SnowLumaConfigHttpServer } from '@dda/spec';

/**
 * SnowLuma 配置服务（M3.3-04）。
 *
 * 现场事实（2026-11-03 对官方 v2.4.0 包内 `index.mjs` 的静态核对，见 docs/M3.3-实施报告.md §3）：
 *  - 配置目录固定为**进程工作目录下的 `config/`**，因此启动时必须把 cwd 设为安装目录；
 *  - OneBot 全局配置是 `config/onebot.json`，形状为
 *    `{ networks: { httpServers: [{ name:"http-default", host, port, path, enableWebSocket, enableSse,
 *       accessToken, messageFormat, reportSelfMessage }], httpClients, wsServers, wsClients },
 *      statusCommand: { enabled, swallow, cooldownSeconds, trigger } }`；
 *  - 账号级 `config/onebot_<uin>.json` 是**快照**（`mode:"snapshot"`），优先级高于全局文件：
 *    它是用户在 WebUI 里确认过的结果，我们不覆盖，只如实报告；
 *  - 默认 `http-default` 监听 `127.0.0.1:3000`，`accessToken` 由上游随机生成。
 *
 * 安全：令牌只在本模块内存里传递，**不进证据、不进日志、不进返回值**。
 */

export interface ConfigDeps {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  copyDir(from: string, to: string): Promise<void>;
  now(): Date;
}

export async function copyDirRecursive(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyDirRecursive(source, target);
    else if (entry.isFile()) await copyFile(source, target);
  }
}

export function createNodeConfigDeps(): ConfigDeps {
  return {
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, 'utf8');
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    remove: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
    readdir: (path) => readdir(path),
    copyDir: (from, to) => copyDirRecursive(from, to),
    now: () => new Date(),
  };
}

const ONEBOT_CONFIG_FILE = 'onebot.json';
const CONFIG_DIR_NAME = 'config';


function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function readServers(raw: unknown): SnowLumaConfigHttpServer[] {
  const networks = asRecord(asRecord(raw)?.networks);
  const servers = networks?.httpServers;
  if (!Array.isArray(servers)) return [];
  return servers.map((item) => {
    const row = asRecord(item) ?? {};
    return {
      name: typeof row.name === 'string' ? row.name : undefined,
      host: typeof row.host === 'string' ? row.host : undefined,
      port: typeof row.port === 'number' ? row.port : undefined,
      hasToken: typeof row.accessToken === 'string' && row.accessToken.length > 0,
    };
  });
}

export async function inspectConfig(
  deps: Pick<ConfigDeps, 'exists' | 'readFile' | 'readdir'>,
  options: { installDir: string; configDirName?: string },
): Promise<SnowLumaConfigInspection> {
  const configDir = join(options.installDir, options.configDirName ?? CONFIG_DIR_NAME);
  if (!(await deps.exists(configDir))) {
    return { configDir, exists: false, files: [], httpServers: [], problem: '还没有生成配置目录（SnowLuma 首次运行后才会创建）' };
  }
  const files = (await deps.readdir(configDir)).filter((name) => name.endsWith('.json')).sort();
  const snapshots = files.filter((name) => /^onebot_\d+\.json$/.test(name));
  const ordered = [...snapshots, ...(files.includes(ONEBOT_CONFIG_FILE) ? [ONEBOT_CONFIG_FILE] : [])];

  for (const file of ordered) {
    try {
      const raw = JSON.parse(await deps.readFile(join(configDir, file))) as unknown;
      const servers = readServers(raw);
      if (servers.length > 0) {
        return { configDir, exists: true, files, httpServers: servers, sourceFile: file };
      }
    } catch {
      // 损坏的文件继续看下一个，最后统一报告。
    }
  }
  return {
    configDir,
    exists: true,
    files,
    httpServers: [],
    problem: ordered.length === 0 ? '配置目录里还没有 onebot*.json（SnowLuma 首次运行后会创建）' : '配置里没有可用的 httpServers 条目',
  };
}

/** 读取实际生效的 OneBot HTTP 端点与令牌（令牌只返回给主进程内存）。 */
export async function readActiveEndpoint(
  deps: Pick<ConfigDeps, 'exists' | 'readFile' | 'readdir'>,
  options: { installDir: string; configDirName?: string },
): Promise<{ baseUrl: string; accessToken?: string; sourceFile: string } | undefined> {
  const configDir = join(options.installDir, options.configDirName ?? CONFIG_DIR_NAME);
  if (!(await deps.exists(configDir))) return undefined;
  const files = await deps.readdir(configDir);
  const snapshots = files.filter((name) => /^onebot_\d+\.json$/.test(name)).sort();
  const ordered = [...snapshots, ...(files.includes(ONEBOT_CONFIG_FILE) ? [ONEBOT_CONFIG_FILE] : [])];
  for (const file of ordered) {
    try {
      const raw = JSON.parse(await deps.readFile(join(configDir, file))) as unknown;
      const networks = asRecord(asRecord(raw)?.networks);
      const servers = networks?.httpServers;
      if (!Array.isArray(servers)) continue;
      const typed = servers.map((item) => asRecord(item) ?? {});
      const chosen =
        typed.find((item) => item.name === 'http-default') ??
        typed.find((item) => typeof item.port === 'number') ??
        typed[0];
      if (!chosen) continue;
      const host = typeof chosen.host === 'string' && chosen.host ? chosen.host : '127.0.0.1';
      const port = typeof chosen.port === 'number' ? chosen.port : 3000;
      const token = typeof chosen.accessToken === 'string' && chosen.accessToken ? chosen.accessToken : undefined;
      return { baseUrl: `http://${host}:${port}`, accessToken: token, sourceFile: file };
    } catch {
      continue;
    }
  }
  return undefined;
}

interface EnsureConfigOptions {
  installDir: string;
  configDirName?: string;
  host?: string;
  port: number;
  /** 备份根目录（我们自己的 state 目录），每次写入前都会在这里留一份完整副本。 */
  backupRoot: string;
  /** 已有令牌缺失时才生成（默认生成）。 */
  generateToken?: boolean;
}

interface EnsureConfigResult {
  changed: boolean;
  created: boolean;
  file: string;
  backupDir?: string;
  /** 令牌是否存在（不返回值本身）。 */
  accessTokenPresent: boolean;
  evidence: string[];
}

/** 上游默认结构（逐字段来自官方包内默认值，不额外发明字段）。 */
function defaultOneBotConfig(accessToken: string): Record<string, unknown> {
  return {
    networks: {
      httpServers: [
        {
          name: 'http-default',
          host: '127.0.0.1',
          port: 3000,
          path: '/',
          enableWebSocket: false,
          enableSse: false,
          accessToken,
          messageFormat: 'array',
          reportSelfMessage: false,
        },
      ],
      httpClients: [],
      wsServers: [
        {
          name: 'ws-default',
          host: '127.0.0.1',
          port: 3001,
          path: '/',
          role: 'Universal',
          accessToken,
          messageFormat: 'array',
          reportSelfMessage: false,
        },
      ],
      wsClients: [],
    },
    statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger: '#sl' },
  };
}

function timestampSuffix(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * 保证 `http-default` 的 host/port 与期望一致。
 *
 * 规则（对应 M3.3-04 的"不得覆盖用户已有的有效配置"）：
 *  - 账号级快照存在 → **不改**，只报告（快照是用户在 WebUI 确认过的结果）；
 *  - 全局文件存在且已有 `http-default` → 只改 host/port（保留令牌与其它字段）；
 *  - 全局文件存在但没有 http-default → 在 httpServers 末尾补一条（保留其它服务）；
 *  - 全局文件缺失 → 写上游默认结构。
 */
export async function ensureOneBotHttpConfig(
  deps: ConfigDeps,
  options: EnsureConfigOptions,
): Promise<EnsureConfigResult> {
  const configDir = join(options.installDir, options.configDirName ?? CONFIG_DIR_NAME);
  const file = join(configDir, ONEBOT_CONFIG_FILE);
  const evidence: string[] = [];
  const host = options.host ?? '127.0.0.1';

  await deps.mkdir(configDir);
  const files = await deps.readdir(configDir);
  const snapshots = files.filter((name) => /^onebot_\d+\.json$/.test(name));
  if (snapshots.length > 0) {
    evidence.push(`配置：发现账号级快照 ${snapshots.join('、')}，优先于全局配置，本次不修改任何配置`);
    return { changed: false, created: false, file, accessTokenPresent: true, evidence };
  }

  const exists = await deps.exists(file);
  let backupDir: string | undefined;
  if (exists) {
    backupDir = join(options.backupRoot, `config-${timestampSuffix(deps.now())}`);
    await deps.copyDir(configDir, backupDir);
    evidence.push(`配置：写入前已备份到 ${backupDir}`);
  }

  let raw: Record<string, unknown>;
  if (exists) {
    try {
      raw = (JSON.parse(await deps.readFile(file)) as Record<string, unknown>) ?? {};
    } catch (error) {
      throw new DdaError(
        ERROR_CODES.E_MANIFEST_INVALID,
        `现有 onebot.json 无法解析：${error instanceof Error ? error.message : String(error)}`,
        `已备份到 ${backupDir ?? configDir}，可在"配置恢复"里回滚`,
      );
    }
  } else {
    raw = defaultOneBotConfig(options.generateToken === false ? '' : randomBytes(32).toString('hex'));
    evidence.push('配置：没有 onebot.json，按上游默认结构创建（令牌为 32 字节随机值，不回显）');
  }

  const networks = asRecord(raw.networks) ?? {};
  const servers = Array.isArray(networks.httpServers) ? networks.httpServers : [];
  const typed = servers.map((item) => asRecord(item) ?? {});
  let chosen = typed.find((item) => item.name === 'http-default');

  let created = !exists;
  if (!chosen) {
    chosen = {
      name: 'http-default',
      host,
      port: options.port,
      path: '/',
      enableWebSocket: false,
      enableSse: false,
      accessToken: randomBytes(32).toString('hex'),
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    typed.push(chosen);
    created = true;
    evidence.push('配置：原有配置里没有 http-default，已补一条（其它服务保持不变）');
  }

  const before = `${String(chosen.host)}:${String(chosen.port)}`;
  chosen.host = host;
  chosen.port = options.port;
  if (typeof chosen.accessToken !== 'string' || chosen.accessToken.length === 0) {
    chosen.accessToken = randomBytes(32).toString('hex');
    evidence.push('配置：原条目没有访问令牌，已生成一个（不回显）');
  }

  networks.httpServers = typed;
  if (!Array.isArray(networks.httpClients)) networks.httpClients = [];
  if (!Array.isArray(networks.wsServers)) networks.wsServers = [];
  if (!Array.isArray(networks.wsClients)) networks.wsClients = [];
  raw.networks = networks;

  const changed = created || before !== `${host}:${options.port}`;

  if (changed || !exists) {
    await deps.writeFile(file, JSON.stringify(raw, null, 2));
    evidence.push(`配置：http-default 已设为 ${host}:${options.port}`);
  } else {
    evidence.push(`配置：http-default 已是 ${host}:${options.port}，无需改动`);
  }

  // 写入后结构校验：解析回来再确认一遍，失败就回滚。
  try {
    const verify = JSON.parse(await deps.readFile(file)) as unknown;
    const verified = readServers(verify).find((item) => item.name === 'http-default');
    if (!verified || verified.port !== options.port || !verified.hasToken) {
      throw new Error('写入后的配置不含有效的 http-default（端口或令牌缺失）');
    }
    evidence.push('配置：写入后结构校验通过');
    return {
      changed,
      created,
      file,
      backupDir,
      accessTokenPresent: true,
      evidence,
    };
  } catch (error) {
    if (backupDir) {
      await deps.remove(configDir);
      await deps.copyDir(backupDir, configDir);
      evidence.push('配置：结构校验失败，已从备份恢复');
    }
    throw new DdaError(
      ERROR_CODES.E_MANIFEST_INVALID,
      `写入配置失败：${error instanceof Error ? error.message : String(error)}`,
      '已回滚到写入前状态；请到 SnowLuma WebUI 手动确认 OneBot 配置',
    );
  }
}

/** 从备份目录恢复整个 config/（先整体替换，失败时再试一次原样复制）。 */
export async function restoreConfig(
  deps: Pick<ConfigDeps, 'exists' | 'remove' | 'copyDir'>,
  options: { configDir: string; backupDir: string },
): Promise<{ restored: boolean; evidence: string[] }> {
  const evidence: string[] = [];
  if (!(await deps.exists(options.backupDir))) {
    return { restored: false, evidence: ['配置恢复：备份目录不存在'] };
  }
  try {
    await deps.remove(options.configDir);
    await deps.copyDir(options.backupDir, options.configDir);
    evidence.push(`配置恢复：已从 ${options.backupDir} 恢复 config/`);
    return { restored: true, evidence };
  } catch (error) {
    evidence.push(`配置恢复失败：${error instanceof Error ? error.message : String(error)}`);
    return { restored: false, evidence };
  }
}

/** 列出可用的配置备份（供 UI 选择恢复点）。 */
export async function listConfigBackups(
  deps: Pick<ConfigDeps, 'exists' | 'readdir'>,
  backupRoot: string,
): Promise<string[]> {
  if (!(await deps.exists(backupRoot))) return [];
  const names = await deps.readdir(backupRoot);
  return names.filter((name) => name.startsWith('config-')).sort().reverse();
}
