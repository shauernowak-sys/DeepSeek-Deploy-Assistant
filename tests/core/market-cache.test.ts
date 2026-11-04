import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getCachedFile, listCachedFiles, putCachedFile, removeCachedFile } from '@dda/core';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('D05 内容寻址缓存', () => {
  it('写入后可读回（路径按 sha256 命名）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-market-cache-'));
    const source = join(root, 'plugin.tgz');
    await writeFile(source, 'bytes', 'utf8');
    const digest = sha('bytes');

    const cachedPath = await putCachedFile({ cacheRoot: root, sourcePath: source, sha256: digest });
    expect(cachedPath).toBe(join(root, 'market', `${digest}.tgz`));

    const hit = await getCachedFile(root, digest);
    expect(hit?.path).toBe(cachedPath);
    expect(await readFile(hit!.path, 'utf8')).toBe('bytes');
    expect((await listCachedFiles(root)).map((entry) => entry.sha256)).toEqual([digest]);
  });

  it('源文件哈希与期望不一致 → 拒绝写入（宁可不缓存）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-market-cache-'));
    const source = join(root, 'plugin.tgz');
    await writeFile(source, 'bytes', 'utf8');

    await expect(
      putCachedFile({ cacheRoot: root, sourcePath: source, sha256: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'E_HASH_MISMATCH' });
    expect(await listCachedFiles(root)).toEqual([]);
  });

  it('缓存被篡改 → 命中失败并删除损坏文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-market-cache-'));
    const source = join(root, 'plugin.tgz');
    await writeFile(source, 'bytes', 'utf8');
    const digest = sha('bytes');
    const cachedPath = await putCachedFile({ cacheRoot: root, sourcePath: source, sha256: digest });

    await writeFile(cachedPath, 'tampered', 'utf8');
    expect(await getCachedFile(root, digest)).toBeUndefined();
    expect(await listCachedFiles(root)).toEqual([]);
  });

  it('非法缓存键直接拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-market-cache-'));
    expect(() => listCachedFiles).not.toThrow();
    await expect(getCachedFile(root, 'not-a-hash')).rejects.toMatchObject({ code: 'E_MANIFEST_INVALID' });
  });

  it('移除后不再命中', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-market-cache-'));
    const source = join(root, 'plugin.tgz');
    await writeFile(source, 'bytes', 'utf8');
    const digest = sha('bytes');
    await putCachedFile({ cacheRoot: root, sourcePath: source, sha256: digest });

    await removeCachedFile(root, digest);
    expect(await getCachedFile(root, digest)).toBeUndefined();
  });
});
