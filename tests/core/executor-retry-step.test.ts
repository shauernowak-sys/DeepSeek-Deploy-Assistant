import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { executePlan, Journal, type Step } from '@dda/core';

/**
 * §21.10「重试这一步」的执行语义：只重跑目标步骤，成功后**停下**，
 * 后续步骤保持 pending，任务状态是 `paused` 且 `pausedReason='step-retry'`
 * （不能复用 `pausedByUser=true`，否则 UI 会把它说成"你主动暂停了"）。
 */

async function tempJournal(): Promise<Journal> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-retry-step-'));
  return new Journal(join(dir, 'task.json'));
}

interface Recorder {
  log: string[];
  steps: Step[];
}

function makeSteps(b: 'ok' | 'fail'): Recorder {
  const log: string[] = [];
  const steps: Step[] = [
    {
      id: 'download',
      title: '下载',
      weight: 1,
      async run() {
        log.push('download');
      },
    },
    {
      id: 'install',
      title: '安装',
      weight: 1,
      async run() {
        log.push('install');
        if (b === 'fail') throw new Error('pnpm 失败');
      },
    },
    {
      id: 'config',
      title: '配置',
      weight: 1,
      async run() {
        log.push('config');
      },
    },
  ];
  return { log, steps };
}

async function firstRunWithFailure(): Promise<{ journal: Journal; log: string[]; steps: Step[] }> {
  const journal = await tempJournal();
  const failed = makeSteps('fail');
  const first = await executePlan({
    taskId: 't-retry',
    scenario: 'test',
    steps: failed.steps,
    journal,
    resume: false,
    log: () => undefined,
  });
  expect(first.summary.status).toBe('failed');
  expect(first.summary.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'pending']);
  return { journal, log: failed.log, steps: makeSteps('ok').steps };
}

describe('§21.10 单步重试（executor.stopAfterStepId）', () => {
  it('只重跑失败那一步，成功后停下：状态 paused + pausedReason=step-retry，后续步骤不执行', async () => {
    const { journal, steps } = await firstRunWithFailure();
    const log: string[] = [];

    const result = await executePlan({
      taskId: 't-retry',
      scenario: 'test',
      steps,
      journal,
      resume: true,
      stopAfterStepId: 'install',
      log: (line) => {
        log.push(line);
      },
    });

    expect(result.summary.status).toBe('paused');
    expect(result.summary.pausedReason).toBe('step-retry');
    expect(result.summary.pausedByUser).toBe(false);
    expect(result.summary.error).toBeUndefined();
    expect(result.summary.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'pending']);
    // 已完成的 download 没有被重跑
    expect(log.some((line) => line.includes('install'))).toBe(true);
  });

  it('停下后「继续」能把剩下的步骤跑完（不重复已完成步骤）', async () => {
    const { journal, steps } = await firstRunWithFailure();
    await executePlan({
      taskId: 't-retry',
      scenario: 'test',
      steps,
      journal,
      resume: true,
      stopAfterStepId: 'install',
      log: () => undefined,
    });

    const log: string[] = [];
    const finished = await executePlan({
      taskId: 't-retry',
      scenario: 'test',
      steps: steps.map((step) => ({
        ...step,
        run: async () => {
          log.push(step.id);
        },
      })),
      journal,
      resume: true,
      log: () => undefined,
    });

    expect(finished.summary.status).toBe('succeeded');
    expect(log).toEqual(['config']);
  });

  it('目标步骤被 precondition 跳过时也停在它之后（不接着跑后面的步骤）', async () => {
    const journal = await tempJournal();
    const log: string[] = [];
    const steps: Step[] = [
      {
        id: 'a',
        title: 'A',
        weight: 1,
        async run() {
          log.push('a');
        },
      },
      {
        id: 'b',
        title: 'B',
        weight: 1,
        async precondition() {
          return true;
        },
        async run() {
          log.push('b');
        },
      },
      {
        id: 'c',
        title: 'C',
        weight: 1,
        async run() {
          log.push('c');
        },
      },
    ];

    const result = await executePlan({
      taskId: 't-skip',
      scenario: 'test',
      steps,
      journal,
      resume: false,
      stopAfterStepId: 'b',
      log: () => undefined,
    });

    expect(result.summary.steps.map((s) => s.status)).toEqual(['succeeded', 'skipped', 'pending']);
    expect(result.summary.status).toBe('paused');
    expect(result.summary.pausedReason).toBe('step-retry');
    expect(log).toEqual(['a']);
  });

  it('不传 stopAfterStepId 时行为不变（一路跑到成功）', async () => {
    const { journal, steps } = await firstRunWithFailure();
    const result = await executePlan({
      taskId: 't-retry',
      scenario: 'test',
      steps,
      journal,
      resume: true,
      log: () => undefined,
    });
    expect(result.summary.status).toBe('succeeded');
    expect(result.summary.pausedReason).toBeUndefined();
  });
});
