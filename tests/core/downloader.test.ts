import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { downloadVerified, verifyHash } from '@dda/core';
import { DdaError } from '@dda/spec';

const payload = Buffer.from('D'.repeat(64 * 1024) + 'END', 'utf8');
const payloadSha = createHash('sha256').update(payload).digest('hex');

let closeServer: (() => Promise<void>) | undefined;

async function serve(behaviour: {
  requireRange?: boolean;
  corrupt?: boolean;
  failFirst?: number;
}): Promise<string> {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (behaviour.failFirst && requests <= behaviour.failFirst) {
      res.statusCode = 404;
      res.end('missing');
      return;
    }
    const body = behaviour.corrupt ? Buffer.from(payload.map((b) => b ^ 1)) : payload;
    const range = req.headers.range;
    if (behaviour.requireRange && !range) {
      res.statusCode = 200;
      res.setHeader('content-length', body.length);
      res.end(body);
      return;
    }
    if (range) {
      const match = /bytes=(\d+)-/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const slice = body.subarray(start);
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`);
      res.setHeader('content-length', slice.length);
      res.end(slice);
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-length', body.length);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closeServer = async () => new Promise<void>((resolve) => server.close(() => resolve()));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/file.zip`;
}

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe('downloadVerified', () => {
  it('下载完整文件并校验 sha256', async () => {
    const url = await serve({});
    const dir = await mkdtemp(join(tmpdir(), 'dda-dl-'));
    const dest = join(dir, 'node.zip');
    const result = await downloadVerified({ destPath: dest, sources: [url], sha256: payloadSha, expectedSize: payload.length });
    expect(result.bytes).toBe(payload.length);
    expect(result.resumedFrom).toBe(0);
    expect(await readFile(dest)).toEqual(payload);
  });

  it('从 .part 续传（HTTP 206）', async () => {
    const url = await serve({});
    const dir = await mkdtemp(join(tmpdir(), 'dda-dl-'));
    const dest = join(dir, 'node.zip');
    const half = Math.floor(payload.length / 2);
    await writeFile(`${dest}.part`, payload.subarray(0, half));

    const result = await downloadVerified({ destPath: dest, sources: [url], sha256: payloadSha });
    expect(result.resumedFrom).toBe(half);
    expect(await readFile(dest)).toEqual(payload);
  });

  it('哈希不一致时删除文件并抛 E_HASH_MISMATCH', async () => {
    const url = await serve({ corrupt: true });
    const dir = await mkdtemp(join(tmpdir(), 'dda-dl-'));
    const dest = join(dir, 'node.zip');
    await expect(
      downloadVerified({ destPath: dest, sources: [url], sha256: payloadSha, attemptsPerSource: 1 }),
    ).rejects.toMatchObject({ code: 'E_HASH_MISMATCH' });
    await expect(readFile(dest)).rejects.toThrow();
  });

  it('首个源 404 时回退到备用源', async () => {
    const bad = await serve({ failFirst: 99 });
    const good = await serve({});
    const dir = await mkdtemp(join(tmpdir(), 'dda-dl-'));
    const dest = join(dir, 'node.zip');
    const result = await downloadVerified({
      destPath: dest,
      sources: [bad, good],
      sha256: payloadSha,
      attemptsPerSource: 1,
    });
    expect(result.source).toBe(good);
  });

  it('verifyHash 使用定长比较', () => {
    expect(verifyHash(payloadSha, payloadSha)).toBe(true);
    expect(verifyHash(payloadSha, payloadSha.slice(0, 63) + 'x')).toBe(false);
    expect(verifyHash(payloadSha, 'abc')).toBe(false);
  });

  it('所有源都失败时抛出带明细的 DdaError', async () => {
    const bad = await serve({ failFirst: 99 });
    const dir = await mkdtemp(join(tmpdir(), 'dda-dl-'));
    const error = await downloadVerified({
      destPath: join(dir, 'x.zip'),
      sources: [bad],
      sha256: payloadSha,
      attemptsPerSource: 1,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DdaError);
    expect((error as DdaError).message).toContain('all sources failed');
  });

  // P-9：最终错误码必须反映真实原因，不能被更"常见"的网络错误码掩盖。
  it('全是 404 时抛 E_DOWNLOAD_HTTP（不是网络错误）', async () => {
    const bad = await serve({ failFirst: 99 });
    await expect(
      downloadVerified({ destPath: join(await mkdtemp(join(tmpdir(), 'dda-dl-')), 'x.zip'), sources: [bad], sha256: payloadSha, attemptsPerSource: 1 }),
    ).rejects.toMatchObject({ code: 'E_DOWNLOAD_HTTP' });
  });

  it('一个源哈希不一致、另一个源不可达时仍报 E_HASH_MISMATCH', async () => {
    const corrupt = await serve({ corrupt: true });
    const unreachable = 'http://127.0.0.1:9/never.zip';
    const dir = await mkdtemp(join(tmpdir(), 'dda-dl-'));
    const error = await downloadVerified({
      destPath: join(dir, 'x.zip'),
      sources: [corrupt, unreachable],
      sha256: payloadSha,
      attemptsPerSource: 1,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);
    expect((error as DdaError).code).toBe('E_HASH_MISMATCH');
    expect((error as DdaError).hint).toContain('哈希');
  });
});
