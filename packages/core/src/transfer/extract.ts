import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

import yauzl from 'yauzl';

import { DdaError, ERROR_CODES } from '@dda/spec';

const MAX_ENTRIES = 50_000;

/**
 * Reject any archive entry that escapes the destination (zip-slip), uses an absolute path,
 * a drive letter, a UNC path, or a symlink. Pure function so it is directly unit-testable.
 */
export function assertSafeEntryPath(entryName: string): string {
  if (!entryName || entryName.includes('\0')) {
    throw new DdaError(ERROR_CODES.E_EXTRACT_UNSAFE_PATH, `empty or NUL entry name`, '改用官方压缩包');
  }
  const unified = entryName.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified) || unified.startsWith('//')) {
    throw new DdaError(ERROR_CODES.E_EXTRACT_UNSAFE_PATH, `absolute path in archive: ${entryName}`, '改用官方压缩包');
  }
  const segments = unified.split('/');
  if (segments.some((s) => s === '..')) {
    throw new DdaError(ERROR_CODES.E_EXTRACT_UNSAFE_PATH, `path traversal in archive: ${entryName}`, '改用官方压缩包');
  }
  return segments.filter((s) => s !== '' && s !== '.').join(sep);
}

export interface ExtractOptions {
  zipPath: string;
  destDir: string;
  /** Hard cap on total uncompressed bytes (default 1 GiB). */
  maxTotalBytes?: number;
  stripTopLevelDir?: boolean;
}

export async function extractZip(options: ExtractOptions): Promise<{ files: number; bytes: number }> {
  const maxTotal = options.maxTotalBytes ?? 1024 * 1024 * 1024;
  const root = resolve(options.destDir);
  await mkdir(root, { recursive: true });

  return new Promise((resolvePromise, reject) => {
    yauzl.open(options.zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new DdaError(ERROR_CODES.E_EXTRACT_FAILED, `无法打开压缩包: ${err?.message}`, '重新下载'));
        return;
      }

      let files = 0;
      let bytes = 0;
      let entries = 0;
      let settled = false;

      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          /* ignore */
        }
        reject(e);
      };

      zipfile.on('error', (e) => fail(new DdaError(ERROR_CODES.E_EXTRACT_FAILED, e.message, '重新下载')));
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolvePromise({ files, bytes });
      });

      zipfile.on('entry', (entry: yauzl.Entry) => {
        entries += 1;
        if (entries > MAX_ENTRIES) {
          fail(new DdaError(ERROR_CODES.E_EXTRACT_FAILED, '压缩包条目过多', '改用官方压缩包'));
          return;
        }

        let relative: string;
        try {
          relative = assertSafeEntryPath(entry.fileName);
        } catch (e) {
          fail(e as Error);
          return;
        }

        // Unix mode in the high 16 bits; symlink = 0xA000.
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0xf000) === 0xa000) {
          fail(new DdaError(ERROR_CODES.E_EXTRACT_UNSAFE_PATH, `压缩包含符号链接: ${entry.fileName}`, '改用官方压缩包'));
          return;
        }

        if (relative === '') {
          zipfile.readEntry();
          return;
        }

        let targetRelative = relative;
        if (options.stripTopLevelDir) {
          const parts = relative.split(sep);
          targetRelative = parts.slice(1).join(sep);
          if (!targetRelative) {
            zipfile.readEntry();
            return;
          }
        }

        const target = join(root, targetRelative);
        const normalized = normalize(target);
        if (!normalized.startsWith(root + sep) && normalized !== root) {
          fail(new DdaError(ERROR_CODES.E_EXTRACT_UNSAFE_PATH, `越界写出: ${entry.fileName}`, '改用官方压缩包'));
          return;
        }

        if (isAbsolute(targetRelative)) {
          fail(new DdaError(ERROR_CODES.E_EXTRACT_UNSAFE_PATH, `绝对路径: ${entry.fileName}`, '改用官方压缩包'));
          return;
        }

        if (/\/$/.test(entry.fileName)) {
          mkdir(normalized, { recursive: true })
            .then(() => zipfile.readEntry())
            .catch((e) => fail(new DdaError(ERROR_CODES.E_EXTRACT_FAILED, String(e), '检查磁盘空间')));
          return;
        }

        bytes += entry.uncompressedSize;
        if (bytes > maxTotal) {
          fail(new DdaError(ERROR_CODES.E_EXTRACT_FAILED, '解压总量超过上限', '检查磁盘空间或更换压缩包'));
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(new DdaError(ERROR_CODES.E_EXTRACT_FAILED, streamErr?.message ?? 'entry stream failed', '重新下载'));
            return;
          }
          mkdir(dirname(normalized), { recursive: true })
            .then(() => {
              const out = createWriteStream(normalized);
              readStream.pipe(out);
              out.on('error', (e) => fail(new DdaError(ERROR_CODES.E_EXTRACT_FAILED, e.message, '检查磁盘空间')));
              out.on('close', () => {
                files += 1;
                zipfile.readEntry();
              });
            })
            .catch((e) => fail(new DdaError(ERROR_CODES.E_EXTRACT_FAILED, String(e), '检查磁盘空间')));
        });
      });

      zipfile.readEntry();
    });
  });
}

export async function cleanupDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
