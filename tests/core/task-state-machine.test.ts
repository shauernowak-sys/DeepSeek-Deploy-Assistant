import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTaskControl, executePlan, Journal, rollbackPlan } from '@dda/core';
import type { Step } from '@dda/core';

/**
 * The engine must never conflate the five user-visible outcomes:
 *  - succeeded   全部完成
 *  - paused      用户主动暂停（可继续）
 *  - failed      步骤出错（需处理，不是"暂停"）
 *  - cancelled   用户取消
 *  - rolled-back 已回滚
 * These tests pin the semantics that the UI renders.
 */
async function makeJournal(): Promise<{ journal: Journal; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-state-'));
  const file = join(dir, 'task.json');
  return { journal: new Journal(file), file };
}

interface Harness {
  steps: Step[];
  log: string[];
  failOnce: boolean;
}

function buildSteps(): Harness {
  const log: string[] = [];
  const harness: Harness = { log, failOnce: true, steps: [] };
  harness.steps = [
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
        if (harness.failOnce) {
          harness.failOnce = false;
          throw new Error('pnpm 安装失败：ENOTFOUND');
        }
      },
    },
    {
      id: 'three',
      title: 'three',
      weight: 1,
      async run() {
        log.push('three');
      },
    },
  ];
  return harness;
}

describe('部署任务状态机', () => {
  it('正常部署：全部成功 → succeeded，进度事件按步骤推进', async () => {
    const { journal } = await makeJournal();
    const steps: Step[] = [
      { id: 'a', title: 'a', weight: 1, run: async () => undefined },
      { id: 'b', title: 'b', weight: 1, run: async () => undefined },
    ];
    const events: string[] = [];
    const result = await executePlan({
      taskId: 'ok',
      scenario: 'test',
      steps,
      journal,
      log: () => undefined,
      onEvent: (e) => events.push(`${e.stepId}:${e.status}`),
    });
    expect(result.summary.status).toBe('succeeded');
    expect(result.summary.pausedByUser).toBeUndefined();
    expect(result.summary.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
    expect(events).toEqual(['a:running', 'a:succeeded', 'b:running', 'b:succeeded']);
  });

  it('主动暂停：状态 paused + pausedByUser=true，错误为空，恢复后从断点继续', async () => {
    const harness = buildSteps();
    const { journal } = await makeJournal();
    const handle = createTaskControl();
    handle.pause();

    const first = await executePlan({
      taskId: 'pause',
      scenario: 'test',
      steps: harness.steps,
      journal,
      control: handle.control,
      log: () => undefined,
    });
    expect(first.summary.status).toBe('paused');
    expect(first.summary.pausedByUser).toBe(true);
    expect(first.summary.error).toBeUndefined();
    expect(harness.log).toEqual([]);

    harness.failOnce = false; // the transient problem the user was waiting for is gone
    const second = await executePlan({
      taskId: 'pause',
      scenario: 'test',
      steps: harness.steps,
      journal,
      resume: true,
      log: () => undefined,
    });
    expect(second.summary.status).toBe('succeeded');
    expect(harness.log).toEqual(['one', 'two', 'three']);
  });

  it('步骤失败：状态 failed（不是 paused），保留错误原因与失败步骤', async () => {
    const harness = buildSteps();
    const { journal, file } = await makeJournal();
    const result = await executePlan({
      taskId: 'fail',
      scenario: 'test',
      steps: harness.steps,
      journal,
      log: () => undefined,
    });

    expect(result.summary.status).toBe('failed');
    expect(result.summary.pausedByUser).toBe(false);
    expect(result.summary.error).toContain('pnpm 安装失败');
    expect(result.summary.steps[1]?.status).toBe('failed');
    expect(result.summary.steps[2]?.status).toBe('pending');
    expect(harness.log).toEqual(['one', 'two']);

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { status: string; error?: string };
    expect(persisted.status).toBe('failed');
    expect(persisted.error).toContain('pnpm 安装失败');
  });

  it('失败后恢复：只重跑失败及其后的步骤，完成后状态回到 succeeded', async () => {
    const harness = buildSteps();
    const { journal } = await makeJournal();
    await executePlan({ taskId: 'retry', scenario: 'test', steps: harness.steps, journal, log: () => undefined });

    const resumed = await executePlan({
      taskId: 'retry',
      scenario: 'test',
      steps: harness.steps,
      journal,
      resume: true,
      log: () => undefined,
    });
    expect(resumed.summary.status).toBe('succeeded');
    expect(resumed.summary.error).toBeUndefined();
    // 'one' succeeded before the failure and must not be repeated.
    expect(harness.log).toEqual(['one', 'two', 'two', 'three']);
  });

  it('取消：状态 cancelled，未执行的步骤不会被标记为失败', async () => {
    const harness = buildSteps();
    const { journal } = await makeJournal();
    const handle = createTaskControl();
    handle.cancel();
    const result = await executePlan({
      taskId: 'cancel',
      scenario: 'test',
      steps: harness.steps,
      journal,
      control: handle.control,
      log: () => undefined,
    });
    expect(result.summary.status).toBe('cancelled');
    expect(result.summary.error).toContain('取消');
    expect(result.summary.pausedByUser).toBeUndefined();
    expect(harness.log).toEqual([]);
  });

  it('回滚：状态 rolled-back，与 failed 明确区分', async () => {
    const harness = buildSteps();
    const { journal } = await makeJournal();
    const result = await executePlan({ taskId: 'rb', scenario: 'test', steps: harness.steps, journal, log: () => undefined });
    await rollbackPlan(result.data, harness.steps, () => undefined);
    expect(result.data.status).toBe('rolled-back');
    expect(result.data.status).not.toBe('failed');
  });

  it('重复操作：无待执行步骤时再次 resume 不重跑任何步骤', async () => {
    const harness = buildSteps();
    harness.failOnce = false;
    const { journal } = await makeJournal();
    await executePlan({ taskId: 'dup', scenario: 'test', steps: harness.steps, journal, log: () => undefined });
    const before = [...harness.log];

    const again = await executePlan({
      taskId: 'dup',
      scenario: 'test',
      steps: harness.steps,
      journal,
      resume: true,
      log: () => undefined,
    });
    expect(again.summary.status).toBe('succeeded');
    expect(harness.log).toEqual(before);
  });

  it('异常退出：journal 停在 running 的步骤会在恢复时重跑并收敛', async () => {
    const harness = buildSteps();
    harness.failOnce = false;
    const { journal, file } = await makeJournal();

    // Simulate a crash: the journal recorded "two" as running and the process died.
    await journal.save({
      taskId: 'crash',
      scenario: 'test',
      status: 'running',
      startedAt: new Date().toISOString(),
      steps: [
        { id: 'one', title: 'one', status: 'succeeded', attempts: 1 },
        { id: 'two', title: 'two', status: 'running', attempts: 1 },
        { id: 'three', title: 'three', status: 'pending', attempts: 0 },
      ],
      created: [],
    });

    const resumed = await executePlan({
      taskId: 'crash',
      scenario: 'test',
      steps: harness.steps,
      journal,
      resume: true,
      log: () => undefined,
    });
    expect(resumed.summary.status).toBe('succeeded');
    expect(harness.log).toEqual(['two', 'three']);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { status: string };
    expect(persisted.status).toBe('succeeded');
  });
});
