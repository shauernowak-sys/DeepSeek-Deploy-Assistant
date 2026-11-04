import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { DdaError, ERROR_CODES } from '@dda/spec';

import { sha256File } from '../transfer/downloader';

/**
 * D05 本地内容寻址缓存：`<cacheRoot>/market/<sha256>.tgz`。
 *
 * 命中也要**重新校验哈希**（PRD CN-6）：缓存可能被磁盘损坏或人为替换，
 * 直接拿旧文件安装等于绕过了完整性校验。
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function cachePathFor(cacheRoot: string, sha256: string): string {
  const hash = sha256.toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    throw new DdaError(ERROR_CODES.E_MANIFEST_INVALID, `缓存键必须是 sha256 十六进制：${sha256}`, '内部错误，请反馈');
  }
  return join(resolve(cacheRoot), 'market', `${hash}.tgz`);
}

export interface PutCachedFileOptions {
  cacheRoot: string;
  sourcePath: string;
  /** 期望的内容哈希；不一致则不写入（宁可不缓存，也不缓存错的内容）。 */
  sha256: string;
}

export async function putCachedFile(options: PutCachedFileOptions): Promise<string> {
  const target = cachePathFor(options.cacheRoot, options.sha256);
  const actual = await sha256File(options.sourcePath);
  if (actual !== options.sha256.toLowerCase()) {
    throw new DdaError(
      ERROR_CODES.E_HASH_MISMATCH,
      `拒绝写入缓存：源文件哈希 ${actual.slice(0, 12)}… ≠ 期望 ${options.sha256.slice(0, 12)}…`,
      '重新下载后再缓存',
    );
  }

  await mkdir(join(resolve(options.cacheRoot), 'market'), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  await copyFile(options.sourcePath, temp);
  const copied = await sha256File(temp);
  if (copied !== actual) {
    await rm(temp, { force: true });
    throw new DdaError(ERROR_CODES.E_HASH_MISMATCH, '缓存写入后哈希不一致', '检查磁盘后再试');
  }
  await rename(temp, target);
  return target;
}

export interface CachedFileResult {
  path: string;
  bytes: number;
}

/** 命中且哈希一致才返回；损坏的缓存会被删除（下次重新下载）。 */
export async function getCachedFile(cacheRoot: string, sha256: string): Promise<CachedFileResult | undefined> {
  const path = cachePathFor(cacheRoot, sha256);
  try {
    await stat(path);
  } catch {
    return undefined;
  }

  const actual = await sha256File(path);
  if (actual !== sha256.toLowerCase()) {
    await rm(path, { force: true });
    return undefined;
  }
  return { path, bytes: (await stat(path)).size };
}

export interface CacheEntry {
  sha256: string;
  path: string;
  bytes: number;
}

export async function listCachedFiles(cacheRoot: string): Promise<CacheEntry[]> {
  const dir = join(resolve(cacheRoot), 'market');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: CacheEntry[] = [];
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.tgz$/u.exec(name);
    if (match === null) continue;
    const path = join(dir, name);
    entries.push({ sha256: match[1]!, path, bytes: (await stat(path)).size });
  }
  return entries.sort((a, b) => a.sha256.localeCompare(b.sha256));
}

export async function removeCachedFile(cacheRoot: string, sha256: string): Promise<void> {
  await rm(cachePathFor(cacheRoot, sha256), { force: true });
}
