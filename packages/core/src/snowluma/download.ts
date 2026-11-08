import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { SnowLumaStepProgress } from '@dda/spec';

import { downloadVerified, sha256File, verifyHash } from '../transfer/downloader';
import type { ResolvedRelease } from './release';

/**
 * SnowLuma 安装包下载服务（M3.3-02）。
 *
 * 复用 M2 的 `downloadVerified`（Range 续传 + 强制 SHA-256 + 多源重试），外层补三件事：
 *  1. **已下载且校验通过就不重复下载**（避免每次点部署都拉 43 MB）；
 *  2. 进度/速度/剩余时间的稳定估算（按时间窗口，不用瞬时值）；
 *  3. 取消语义：只丢弃 `.part`，绝不删除同目录里已通过校验的完整包，也绝不碰安装目录。
 */

export interface PackageFsDeps {
  stat(path: string): Promise<{ size: number }>;
  sha256File(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  download(req: {
    destPath: string;
    sources: string[];
    sha256: string;
    expectedSize?: number;
    signal?: AbortSignal;
    onProgress?: (p: { receivedBytes: number; totalBytes?: number }) => void;
  }): Promise<{ path: string; bytes: number; resumedFrom: number; sha256: string }>;
  now(): number;
}

export function createNodePackageDeps(): PackageFsDeps {
  return {
    stat: (path) => stat(path),
    sha256File,
    remove: (path) => rm(path, { force: true }),
    download: (req) => downloadVerified({ ...req, attemptsPerSource: 2, timeoutMs: 90_000 }),
    now: () => Date.now(),
  };
}

interface EnsurePackageOptions {
  release: ResolvedRelease;
  cacheDir: string;
  signal?: AbortSignal;
  /** 忽略已有缓存（"重新下载"按钮）。 */
  force?: boolean;
  onProgress?: (progress: SnowLumaStepProgress) => void;
}

interface EnsurePackageResult {
  path: string;
  reused: boolean;
  bytes: number;
  sha256: string;
  evidence: string[];
}

interface Sample {
  at: number;
  bytes: number;
}

/** 用最近 ~2.5 秒的窗口估算速度，避免进度条速度值剧烈跳动。 */
export function estimateSpeed(samples: Sample[], windowMs = 2500): number | undefined {
  if (samples.length < 2) return undefined;
  const last = samples[samples.length - 1]!;
  let first = samples[0]!;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const item = samples[i]!;
    if (last.at - item.at > windowMs) break;
    first = item;
  }
  const elapsed = last.at - first.at;
  if (elapsed <= 0) return undefined;
  const delta = last.bytes - first.bytes;
  if (delta <= 0) return 0;
  return Math.round((delta / elapsed) * 1000);
}

/**
 * 官方地址在前。后面的前缀只是把同一个 GitHub 发布文件搬过来，
 * 下载完仍必须对上清单里的 SHA-256，对不上就丢弃。
 */
export function snowlumaDownloadSources(officialUrl: string): string[] {
  const prefixes = ['https://gh-proxy.com/', 'https://ghproxy.net/', 'https://mirror.ghproxy.com/'];
  return [officialUrl, ...prefixes.map((prefix) => `${prefix}${officialUrl}`)];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function ensurePackage(
  deps: PackageFsDeps,
  options: EnsurePackageOptions,
): Promise<EnsurePackageResult> {
  const { release, cacheDir } = options;
  const destPath = join(cacheDir, release.fileName);
  const evidence: string[] = [];

  if (!options.force) {
    try {
      const existing = await deps.stat(destPath);
      if (existing.size === release.sizeBytes) {
        const actual = (await deps.sha256File(destPath)).toLowerCase();
        if (verifyHash(actual, release.sha256.toLowerCase())) {
          evidence.push(`下载：复用已校验的安装包（${release.fileName}，${formatBytes(existing.size)}）`);
          options.onProgress?.({
            receivedBytes: existing.size,
            totalBytes: release.sizeBytes,
            percent: 100,
            speedBps: 0,
            etaSeconds: 0,
          });
          return { path: destPath, reused: true, bytes: existing.size, sha256: actual, evidence };
        }
        evidence.push('下载：缓存里的文件哈希不符，丢弃后重新下载');
        await deps.remove(destPath);
      } else {
        evidence.push(`下载：缓存文件大小不符（${existing.size} ≠ ${release.sizeBytes}），重新下载`);
        await deps.remove(destPath);
      }
    } catch {
      // 没有缓存：正常路径。
    }
  }

  if (options.signal?.aborted) {
    evidence.push('下载：已取消（未开始）');
    return Promise.reject(Object.assign(new Error('已取消下载'), { cancelled: true }));
  }

  const samples: Sample[] = [];
  let reportedPercent = 0;
  const result = await deps.download({
    destPath,
    sources: snowlumaDownloadSources(release.url),
    sha256: release.sha256,
    expectedSize: release.sizeBytes,
    signal: options.signal,
    onProgress: (p) => {
      const at = deps.now();
      samples.push({ at, bytes: p.receivedBytes });
      while (samples.length > 240) samples.shift();
      const speedBps = estimateSpeed(samples);
      const total = p.totalBytes ?? release.sizeBytes;
      const percent = total > 0 ? Math.min(100, Math.round((p.receivedBytes / total) * 100)) : undefined;
      const etaSeconds =
        speedBps && speedBps > 0 && total > p.receivedBytes ? Math.round((total - p.receivedBytes) / speedBps) : undefined;
      // 进度事件可能非常密集：只在百分比变化或每 ~500ms 时上报。
      if (percent !== undefined && percent === reportedPercent && samples.length % 8 !== 0) return;
      reportedPercent = percent ?? reportedPercent;
      options.onProgress?.({
        receivedBytes: p.receivedBytes,
        totalBytes: total,
        percent,
        speedBps,
        etaSeconds,
      });
    },
  });

  evidence.push(
    `下载：完成 ${release.fileName}（${formatBytes(result.bytes)}）` +
      (result.resumedFrom > 0 ? `，其中断点续传 ${formatBytes(result.resumedFrom)}` : ''),
  );
  evidence.push('下载：SHA-256 校验通过');

  return { path: result.path, reused: false, bytes: result.bytes, sha256: result.sha256, evidence };
}
