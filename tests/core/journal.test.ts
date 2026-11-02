import { mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, type JournalData } from '@dda/core';

function sample(status: JournalData['status']): JournalData {
  return {
    taskId: 't1',
    scenario: 'full-deploy',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    steps: [{ id: 's1', title: 'S1', status: 'pending', attempts: 0 }],
    created: [],
  };
}

describe('Journal.save 的健壮性', () => {
  /**
   * Windows 会在目标文件被其他进程（杀毒、诊断导出、外部读取者）打开时拒绝 rename。
   * 短暂占用必须重试成功，而不是让整个任务以未处理异常结束。
   */
  it('目标文件短暂被占用时重试成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-journal-save-'));
    const file = join(dir, 'nested', 'task.json');
    const journal = new Journal(file);
    await journal.save(sample('pending'));
    expect(JSON.parse(await readFile(file, 'utf8')).status).toBe('pending');

    const handle = await open(file, 'r');
    const pending = journal.save(sample('running'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await handle.close();

    await expect(pending).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8')).status).toBe('running');
  });

  it('写入失败时抛出错误，不静默丢弃', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-journal-broken-'));
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'x');
    const journal = new Journal(join(blocker, 'task.json'));
    await expect(journal.save(sample('running'))).rejects.toThrow();
  });
});
