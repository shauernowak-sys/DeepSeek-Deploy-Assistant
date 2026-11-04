import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DdaError, ERROR_CODES } from '@dda/spec';
import type { DownloadProgress, ErrorCode } from '@dda/spec';

export interface DownloadRequest {
  /** Final destination; a `<dest>.part` sibling is used for resume. */
  destPath: string;
  /** Ordered sources: first is primary, the rest are fallbacks. */
  sources: string[];
  sha256: string;
  expectedSize?: number;
  attemptsPerSource?: number;
  timeoutMs?: number;
  /** Aborted when the user cancels; the partial file is kept for a later resume. */
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  path: string;
  source: string;
  bytes: number;
  resumedFrom: number;
  sha256: string;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve());
  });
  return hash.digest('hex');
}

export function verifyHash(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Download with per-source retry, HTTP Range resume and mandatory SHA-256 verification.
 * A hash mismatch deletes the partial file and moves to the next source (never silently accepts).
 */
export async function downloadVerified(req: DownloadRequest): Promise<DownloadResult> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const partPath = `${req.destPath}.part`;
  const attempts = req.attemptsPerSource ?? 3;
  const timeoutMs = req.timeoutMs ?? 30_000;

  await mkdir(dirname(req.destPath), { recursive: true });
  const errors: string[] = [];
  /** 逐次失败的错误码：最终统一抛错时不能把 E_HASH_MISMATCH 说成网络问题（P-9）。 */
  const failureCodes: (ErrorCode | undefined)[] = [];

  for (let sourceIndex = 0; sourceIndex < req.sources.length; sourceIndex += 1) {
    const source = req.sources[sourceIndex]!;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let startByte = 0;
      try {
        startByte = await sizeOf(partPath);
      } catch {
        startByte = 0;
      }

      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      req.signal?.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (req.signal?.aborted) {
          throw new DdaError(ERROR_CODES.E_DOWNLOAD_NETWORK, '已取消下载', '已保留已下载部分，可稍后继续');
        }
        const headers: Record<string, string> = {};
        if (startByte > 0) headers.Range = `bytes=${startByte}-`;

        const res = await fetchImpl(source, { headers, signal: controller.signal, redirect: 'follow' });
        if (res.status === 416) {
          // Range not satisfiable: partial is already complete or bogus; restart clean.
          await rm(partPath, { force: true });
          throw new DdaError(ERROR_CODES.E_DOWNLOAD_HTTP, `HTTP 416 from ${source}`, '重新下载');
        }
        if (!res.ok) {
          throw new DdaError(
            ERROR_CODES.E_DOWNLOAD_HTTP,
            `HTTP ${res.status} from ${source}`,
            '镜像可能已失效，将尝试下一个源',
          );
        }
        if (!res.body) {
          throw new DdaError(ERROR_CODES.E_DOWNLOAD_NETWORK, 'response body is empty', '重试或更换源');
        }

        const appendMode = res.status === 206 && startByte > 0;
        const totalHeader = res.headers.get('content-length');
        const totalBytes = totalHeader ? Number(totalHeader) + (appendMode ? startByte : 0) : req.expectedSize;

        const handle = await open(partPath, appendMode ? 'a' : 'w');
        let received = appendMode ? startByte : 0;
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            await handle.write(chunk);
            received += chunk.byteLength;
            req.onProgress?.({
              url: source,
              receivedBytes: received,
              totalBytes,
              attempt,
              mirrorIndex: sourceIndex,
            });
          }
        } finally {
          await handle.close();
        }

        const actualHash = await sha256File(partPath);
        if (!verifyHash(actualHash, req.sha256)) {
          await rm(partPath, { force: true });
          throw new DdaError(
            ERROR_CODES.E_HASH_MISMATCH,
            `sha256 mismatch for ${source} (got ${actualHash.slice(0, 12)}…)`,
            '已删除损坏文件；若所有源都失败，请检查网络是否被劫持',
          );
        }

        await rm(req.destPath, { force: true });
        await rename(partPath, req.destPath);
        const bytes = (await stat(req.destPath)).size;
        if (req.expectedSize !== undefined && bytes !== req.expectedSize) {
          await rm(req.destPath, { force: true });
          throw new DdaError(
            ERROR_CODES.E_DOWNLOAD_HTTP,
            `size mismatch: expected ${req.expectedSize}, got ${bytes}`,
            '更换源重试',
          );
        }
        return { path: req.destPath, source, bytes, resumedFrom: startByte, sha256: actualHash };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source} #${attempt}: ${message}`);
        failureCodes.push(error instanceof DdaError ? error.code : undefined);
        if (req.signal?.aborted) {
          throw new DdaError(ERROR_CODES.E_DOWNLOAD_NETWORK, '已取消下载（已保留部分文件）', '可稍后继续');
        }
        if (error instanceof DdaError && error.code === ERROR_CODES.E_HASH_MISMATCH) break;
        if (attempt < attempts) await sleep(400 * attempt);
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  // 哈希不一致是安全信号，不能被更"常见"的网络错误码掩盖（P-9）。
  const hashMismatch = failureCodes.includes(ERROR_CODES.E_HASH_MISMATCH);
  const code: ErrorCode = hashMismatch
    ? ERROR_CODES.E_HASH_MISMATCH
    : (failureCodes[failureCodes.length - 1] ?? ERROR_CODES.E_DOWNLOAD_NETWORK);
  throw new DdaError(
    code,
    `all sources failed:\n${errors.join('\n')}`,
    hashMismatch
      ? '文件内容与清单哈希不一致：已删除损坏文件，请更换源或检查网络是否被劫持'
      : '检查网络连接与镜像可用性',
  );
}

async function sizeOf(path: string): Promise<number> {
  const s = await stat(path);
  return s.size;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
