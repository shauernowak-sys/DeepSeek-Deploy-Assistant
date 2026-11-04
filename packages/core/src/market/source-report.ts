/**
 * D06：记录每次安装**实际**从哪些 host 下载了 tarball。
 *
 * 前置验证 §4.3 的遗留问题：把 registry 设成镜像后，仍有部分 tarball 从 `registry.npmjs.org`
 * 下载（1–43 KiB/s），成因未完全确认（疑似 pnpm 跨源元数据缓存复用）。因此产品不得承诺
 * "全部国内下载"，只能**记录事实**并把每次安装的真实 host 写进日志/诊断。
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface TarballHostCount {
  host: string;
  count: number;
}

export interface TarballHostReport {
  total: number;
  hosts: TarballHostCount[];
}

const TARBALL_URL = /https?:\/\/([^/\s"']+)\/[^\s"']*?\.tgz\b/giu;

/** 从 pnpm/dsh 输出里统计 tarball 的下载 host（按 host 计数，降序）。 */
export function extractTarballHosts(output: string): TarballHostReport {
  const counts = new Map<string, number>();
  let total = 0;
  for (const match of output.matchAll(TARBALL_URL)) {
    const host = match[1]?.toLowerCase();
    if (host === undefined || host === '') continue;
    total += 1;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return {
    total,
    hosts: [...counts.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
  };
}

/** 给日志用：没有可解析的 tarball 行时明确说"未取得"，而不是假装 0 个。 */
export function formatTarballHosts(report: TarballHostReport): string {
  if (report.total === 0) return '未取得 tarball host（pnpm 未输出下载地址）';
  return `实际下载 host：${report.hosts.map((item) => `${item.host} × ${item.count}`).join('，')}`;
}

/** 是否全部来自同一个 host（诊断用；不据此做任何承诺）。 */
export function singleSourceHost(report: TarballHostReport): string | undefined {
  return report.hosts.length === 1 ? report.hosts[0]?.host : undefined;
}

/**
 * pnpm 把每个 registry 的元数据分别缓存在 `<cache>/<版本>/metadata/<urlencode(registry)>`。
 * 目录名形如 `https%3A+registry.npmjs.org`。用它判断"这次安装到底问了哪些源"。
 */
export function decodeRegistryDirName(name: string): string | undefined {
  // pnpm 的目录名是"百分号编码 + 分隔符折叠"（实测形如 `https%3A+registry.npmjs.org`），
  // 因此这里按 host 还原，而不是猜它到底用 `+` 表示一个还是两个 `/`。
  const text = name.replace(/%3A/giu, ':').replace(/\+/gu, '/');
  const match = /^(https?):\/*(.+)$/iu.exec(text);
  if (match === null) return undefined;
  const host = match[2]!.replace(/^\/+/u, '').replace(/\/+$/u, '');
  if (host === '') return undefined;
  return `${match[1]!.toLowerCase()}://${host}`;
}

export interface MetadataSourceReport {
  /** 找到的 metadata 目录（没有则为 undefined，说明 pnpm 版本布局不同）。 */
  metadataDir?: string;
  /** 去重后的 registry 源，按字典序。 */
  registries: string[];
}

/** 在给定 pnpm cache 目录里找 metadata 目录并列出 registry 源。 */
export async function listMetadataRegistrySources(cacheRoot: string): Promise<MetadataSourceReport> {
  let entries: string[] = [];
  try {
    entries = await readdir(cacheRoot);
  } catch {
    return { registries: [] };
  }

  const candidates = [join(cacheRoot, 'metadata')];
  for (const entry of entries) {
    if (/^v\d+$/u.test(entry)) candidates.push(join(cacheRoot, entry, 'metadata'));
  }

  for (const dir of candidates) {
    try {
      const children = await readdir(dir);
      const registries = [...new Set(children.map(decodeRegistryDirName).filter((v): v is string => v !== undefined))].sort();
      return { metadataDir: dir, registries };
    } catch {
      continue;
    }
  }
  return { registries: [] };
}

