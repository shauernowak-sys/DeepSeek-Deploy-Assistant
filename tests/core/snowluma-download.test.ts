import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensurePackage, estimateSpeed, formatBytes, snowlumaDownloadSources, type PackageFsDeps } from '@dda/core';
import type { ResolvedRelease } from '@dda/core';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-dl-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function release(fileName: string, content: string): ResolvedRelease {
  return {
    version: '9.9.9',
    fileName,
    url: `https://github.com/SnowLuma/SnowLuma/releases/download/v9.9.9/${fileName}`,
    sizeBytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    verifiedAgainst: 'manifest+github',
    checkedAt: new Date().toISOString(),
    evidence: [],
  };
}

describe('SnowLuma 安装包下载', () => {
  it('官方地址失败时还有加速地址，文件仍按同一份校验', () => {
    const official = 'https://github.com/SnowLuma/SnowLuma/releases/download/v2.4.0/SnowLuma-v2.4.0-win-x64.zip';
    const sources = snowlumaDownloadSources(official);
    expect(sources[0]).toBe(official);
    expect(sources.length).toBeGreaterThan(1);
    expect(sources.slice(1).every((url) => url.endsWith(official))).toBe(true);
  });

  it('已存在且哈希一致时不重复下载', async () => {
    const dir = await tempDir();
    const content = 'payload-1';
    const rel = release('SnowLuma-v9.9.9-win-x64.zip', content);
    await writeFile(join(dir, rel.fileName), content);

    let downloads = 0;
    const deps: PackageFsDeps = {
      stat: async (path) => ({ size: (await readFile(path)).byteLength }),
      sha256File: async (path) => createHash('sha256').update(await readFile(path)).digest('hex'),
      remove: async (path) => {
        await rm(path, { force: true });
      },
      download: async () => {
        downloads += 1;
        throw new Error('不应下载');
      },
      now: () => Date.now(),
    };

    const result = await ensurePackage(deps, { release: rel, cacheDir: dir });
    expect(result.reused).toBe(true);
    expect(downloads).toBe(0);
    expect(result.evidence.join('\n')).toContain('复用已校验的安装包');
  });

  it('缓存哈希不符时丢弃并重新下载', async () => {
    const dir = await tempDir();
    const content = 'payload-2';
    const rel = release('SnowLuma-v9.9.9-win-x64.zip', content);
    await writeFile(join(dir, rel.fileName), 'tampered!');

    let downloads = 0;
    const deps: PackageFsDeps = {
      stat: async (path) => ({ size: (await readFile(path)).byteLength }),
      sha256File: async () => 'deadbeef',
      remove: async (path) => {
        await rm(path, { force: true });
      },
      download: async (req) => {
        downloads += 1;
        await writeFile(req.destPath, content);
        const sha256 = createHash('sha256').update(content).digest('hex');
        req.onProgress?.({ receivedBytes: 4, totalBytes: content.length });
        req.onProgress?.({ receivedBytes: content.length, totalBytes: content.length });
        return { path: req.destPath, bytes: content.length, resumedFrom: 0, sha256 };
      },
      now: () => Date.now(),
    };

    const progress: number[] = [];
    const result = await ensurePackage(deps, {
      release: rel,
      cacheDir: dir,
      onProgress: (p) => {
        if (p.percent !== undefined) progress.push(p.percent);
      },
    });
    expect(downloads).toBe(1);
    expect(result.reused).toBe(false);
    expect(result.evidence.join('\n')).toContain('哈希不符');
    expect(result.evidence.join('\n')).toContain('SHA-256 校验通过');
    expect(progress.at(-1)).toBe(100);
  });

  it('下载前取消会以 cancelled 标记失败，且不删除任何已有文件', async () => {
    const dir = await tempDir();
    const content = 'payload-3';
    const rel = release('SnowLuma-v9.9.9-win-x64.zip', content);
    await writeFile(join(dir, 'keep.txt'), 'keep');

    const controller = new AbortController();
    controller.abort();
    const deps: PackageFsDeps = {
      stat: async () => {
        throw new Error('missing');
      },
      sha256File: async () => '',
      remove: async () => undefined,
      download: async () => {
        throw new Error('不应下载');
      },
      now: () => Date.now(),
    };

    await expect(
      ensurePackage(deps, { release: rel, cacheDir: dir, signal: controller.signal }),
    ).rejects.toMatchObject({ cancelled: true });
    expect(await readFile(join(dir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('速度估算按时间窗口，不因单次抖动失真', () => {
    expect(estimateSpeed([{ at: 0, bytes: 0 }])).toBeUndefined();
    expect(
      estimateSpeed([
        { at: 0, bytes: 0 },
        { at: 1000, bytes: 1000 },
      ]),
    ).toBe(1000);
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
