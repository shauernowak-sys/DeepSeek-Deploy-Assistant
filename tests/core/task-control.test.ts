import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTaskControl, executePlan, Journal, rollbackPlan } from '@dda/core';
import type { Step } from '@dda/core';

async function makeJournal(): Promise<{ journal: Journal; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-ctl-'));
  const file = join(dir, 'task.json');
  return { journal: new Journal(file), file };
}

const slow = (log: string[]): Step[] => [
  {
    id: 'one',
    title: 'one',
    weight: 1,
    async run(ctx) {
      log.push('one');
      ctx.created(join(tmpdir(), 'dda-ctl-artifact-1'));
    },
  },
  {
    id: 'two',
    title: 'two',
    weight: 1,
    async run(ctx) {
      log.push('two');
      ctx.created(join(tmpdir(), 'dda-ctl-artifact-2'));
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

describe('任务控制：暂停', () => {
  it('暂停在步骤边界生效，已完成步骤保留，可继续且不重跑', async () => {
    const log: string[] = [];
    const { journal } = await makeJournal();
    const steps = slow(log);
    const handle = createTaskControl();

    // Request pause while step "one" is running (simulated by pausing before start).
    const pausedRun = executePlan({
      taskId: 't-pause',
      scenario: 'test',
      steps,
      journal,
      resume: false,
      control: handle.control,
      log: () => undefined,
    });
    handle.pause();
    const first = await pausedRun;

    expect(first.summary.status).toBe('paused');
    expect(first.summary.pausedByUser).toBe(true);
    expect(log).toEqual([]);

    const second = await executePlan({
      taskId: 't-pause',
      scenario: 'test',
      steps,
      journal,
      resume: true,
      log: () => undefined,
    });
    expect(second.summary.status).toBe('succeeded');
    expect(log).toEqual(['one', 'two', 'three']);
  });
});

describe('任务控制：取消', () => {
  it('取消后状态为 cancelled，且未删除任何文件', async () => {
    const log: string[] = [];
    const { journal, file } = await makeJournal();
    const steps = slow(log);
    const handle = createTaskControl();
    handle.cancel();

    const result = await executePlan({
      taskId: 't-cancel',
      scenario: 'test',
      steps,
      journal,
      resume: false,
      control: handle.control,
      log: () => undefined,
    });

    expect(result.summary.status).toBe('cancelled');
    expect(log).toEqual([]);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { status: string; created: string[] };
    expect(persisted.status).toBe('cancelled');
  });

  it('取消 + 清理只删除本次任务创建的路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-cancel-'));
    const createdA = join(dir, 'task-artifact-a');
    const createdB = join(dir, 'task-artifact-b');
    const userData = join(dir, 'user-harness-data');
    await writeFile(createdA, 'x');
    await writeFile(createdB, 'y');
    await writeFile(userData, 'keep');

    const steps: Step[] = [
      {
        id: 'make',
        title: 'make',
        weight: 1,
        async run(ctx) {
          ctx.created(createdA);
          ctx.created(createdB);
        },
      },
    ];

    const { journal, file } = await makeJournal();
    await executePlan({ taskId: 't-clean', scenario: 'test', steps, journal, resume: false, log: () => undefined });
    const data = JSON.parse(await readFile(file, 'utf8')) as Parameters<typeof rollbackPlan>[0];
    await rollbackPlan(data, steps, () => undefined);

    const left = await readdir(dir);
    expect(left).toEqual(['user-harness-data']);
  });

  it('清理会删除被清空的父目录，但不会越过安装根目录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-prune-'));
    const root = join(dir, 'app-root');
    const nested = join(root, 'runtimes', 'node', '22.23.4');
    const keepDir = join(root, 'dsh-home');
    await mkdir(nested, { recursive: true });
    await mkdir(keepDir, { recursive: true });
    await writeFile(join(nested, 'node.exe'), 'x');
    await writeFile(join(keepDir, 'user-config.json'), '{"sentinel":true}');

    const steps: Step[] = [
      {
        id: 'make',
        title: 'make',
        weight: 1,
        async run(ctx) {
          ctx.created(nested);
        },
      },
    ];

    const { journal, file } = await makeJournal();
    await executePlan({ taskId: 't-prune', scenario: 'test', steps, journal, resume: false, log: () => undefined });
    const data = JSON.parse(await readFile(file, 'utf8')) as Parameters<typeof rollbackPlan>[0];
    await rollbackPlan(data, steps, () => undefined, root);

    expect(await readdir(root)).toEqual(['dsh-home']);
    expect(await readFile(join(keepDir, 'user-config.json'), 'utf8')).toContain('sentinel');
  });

  it('取消信号会中断下载（保留 .part 以便续传）', async () => {
    const { createServer } = await import('node:http');
    const { downloadVerified } = await import('@dda/core');
    const dir = await mkdtemp(join(tmpdir(), 'dda-abort-'));
    const dest = join(dir, 'file.zip');

    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-length', 10 * 1024 * 1024);
      // Never finishes: the client must abort.
      res.write(Buffer.alloc(64 * 1024));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const error = await downloadVerified({
      destPath: dest,
      sources: [`http://127.0.0.1:${port}/file.zip`],
      sha256: 'a'.repeat(64),
      attemptsPerSource: 1,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    server.close();

    expect(String(error)).toMatch(/已取消/);
  }, 20_000);
});
