import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { executePlan, Journal, rollbackPlan, deriveTaskId, type Step } from '@dda/core';

async function tempJournal(): Promise<{ journal: Journal; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-journal-'));
  const file = join(dir, 'task.json');
  return { journal: new Journal(file), file };
}

function stepsWith(log: string[], overrides: Partial<Step> = {}): Step[] {
  return [
    {
      id: 'step-a',
      title: 'A',
      weight: 1,
      async precondition() {
        return true;
      },
      async run() {
        log.push('a');
      },
      ...overrides,
    },
    {
      id: 'step-b',
      title: 'B',
      weight: 2,
      async run(ctx) {
        log.push('b');
        ctx.created(join(tmpdir(), 'dda-created-artifact'));
      },
    },
  ];
}

describe('executor', () => {
  it('precondition 为真时记为 skipped 且不执行', async () => {
    const log: string[] = [];
    const { journal } = await tempJournal();
    const result = await executePlan({
      taskId: 't1',
      scenario: 'test',
      steps: stepsWith(log),
      journal,
      resume: false,
      log: () => undefined,
    });
    expect(result.summary.steps.map((s) => s.status)).toEqual(['skipped', 'succeeded']);
    expect(log).toEqual(['b']);
    expect(result.summary.status).toBe('succeeded');
  });

  it('步骤失败记为 failed（不是 paused），可 resume 且不重复执行已完成步骤', async () => {
    const log: string[] = [];
    const { journal, file } = await tempJournal();
    let failOnce = true;
    const steps: Step[] = [
      {
        id: 'one',
        title: 'one',
        weight: 1,
        async run() {
          log.push('one');
        },
      },
      {
        id: 'two',
        title: 'two',
        weight: 1,
        async run() {
          log.push('two');
          if (failOnce) {
            failOnce = false;
            throw new Error('boom');
          }
        },
      },
    ];

    const first = await executePlan({ taskId: 't2', scenario: 'test', steps, journal, resume: false, log: () => undefined });
    expect(first.summary.status).toBe('failed');
    expect(first.summary.pausedByUser).toBe(false);
    expect(first.summary.error).toContain('boom');
    expect(first.summary.steps[1]?.status).toBe('failed');
    expect(log).toEqual(['one', 'two']);

    const second = await executePlan({ taskId: 't2', scenario: 'test', steps, journal, resume: true, log: () => undefined });
    expect(second.summary.status).toBe('succeeded');
    expect(log).toEqual(['one', 'two', 'two']);

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { status: string };
    expect(persisted.status).toBe('succeeded');
  });

  it('单步重试后成功', async () => {
    const { journal } = await tempJournal();
    let attempts = 0;
    const steps: Step[] = [
      {
        id: 'flaky',
        title: 'flaky',
        weight: 1,
        retries: 3,
        async run() {
          attempts += 1;
          if (attempts < 3) throw new Error('transient');
        },
      },
    ];
    const result = await executePlan({ taskId: 't3', scenario: 'test', steps, journal, resume: false, log: () => undefined });
    expect(attempts).toBe(3);
    expect(result.summary.status).toBe('succeeded');
  });

  it('rollback 只删除本次创建的文件，不碰其他内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-rb-'));
    const created = join(dir, 'created.txt');
    const untouched = join(dir, 'user-data.txt');
    await writeFile(created, 'x');
    await writeFile(untouched, 'keep');

    const { journal, file } = await tempJournal();
    const steps: Step[] = [
      {
        id: 'make',
        title: 'make',
        weight: 1,
        async run(ctx) {
          ctx.created(created);
        },
      },
    ];
    await executePlan({ taskId: 't4', scenario: 'test', steps, journal, resume: false, log: () => undefined });

    const data = JSON.parse(await readFile(file, 'utf8')) as Parameters<typeof rollbackPlan>[0];
    await rollbackPlan(data, steps, () => undefined);

    const left = await readdir(dir);
    expect(left).toEqual(['user-data.txt']);
    expect(await readFile(untouched, 'utf8')).toBe('keep');
  });

  it('taskId 对同一目标稳定、对不同版本不同', () => {
    const a = deriveTaskId('full-deploy', { dsh: '0.2.0-rc.2', node: '22.23.4' });
    const b = deriveTaskId('full-deploy', { node: '22.23.4', dsh: '0.2.0-rc.2' });
    const c = deriveTaskId('full-deploy', { dsh: '0.2.1-rc.5', node: '22.23.4' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
