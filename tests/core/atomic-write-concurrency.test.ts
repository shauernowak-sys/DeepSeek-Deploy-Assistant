import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, writeFileAtomic } from '@dda/core';
import type { JournalData } from '@dda/core';

/**
 * These cases exist because "temp file + rename" alone is not concurrency safety: with a fixed
 * temp name two writers share one file, and the winner of the rename publishes the *other*
 * writer's bytes while still reporting success.
 */

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function journalWith(index: number): JournalData {
  return {
    taskId: 'concurrency',
    scenario: 'full-deploy',
    status: 'running',
    startedAt: `2026-11-04T00:00:${String(index).padStart(2, '0')}.000Z`,
    steps: [{ id: 'step', title: 'step', status: 'running', attempts: index }],
    created: [`artifact-${index}`],
  };
}

describe('writeFileAtomic：并发写同一路径', () => {
  it('20 个并发写入串行化后结果确定，且没有临时文件残留', async () => {
    const dir = await tempDir('dda-concurrent-');
    const target = join(dir, 'config.json');
    const payloads = Array.from({ length: 20 }, (_, index) => JSON.stringify({ index }));

    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

    // Serialised in call order, so the last caller is the one on disk. The failure this guards
    // against is a caller resolving successfully while the file holds another caller's payload.
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ index: 19 });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('并发写不同路径互不干扰', async () => {
    const dir = await tempDir('dda-concurrent-');
    const targets = Array.from({ length: 10 }, (_, index) => join(dir, `file-${index}.json`));

    await Promise.all(targets.map((target, index) => writeFileAtomic(target, JSON.stringify({ index }))));

    const contents = await Promise.all(targets.map((target) => readFile(target, 'utf8')));
    expect(contents.map((content) => JSON.parse(content) as { index: number })).toEqual(
      targets.map((_, index) => ({ index })),
    );
  });
});

describe('Journal：并发保存', () => {
  it('并发 save 之后 journal 一定是可解析的，且内容来自其中一次保存', async () => {
    const dir = await tempDir('dda-journal-concurrent-');
    const file = join(dir, 'task.json');
    const journal = new Journal(file);
    const snapshots = Array.from({ length: 12 }, (_, index) => journalWith(index));

    await Promise.all(snapshots.map((snapshot) => journal.save(snapshot)));

    const loaded = await Journal.load(file);
    // `Journal.load` swallows parse errors, so `undefined` here means the file was corrupted.
    expect(loaded).toBeDefined();
    expect(loaded?.startedAt).toBe(snapshots[snapshots.length - 1]?.startedAt);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
