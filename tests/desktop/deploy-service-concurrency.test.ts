import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths } from '@dda/adapters';
import { Journal, loadMatrix, Logger } from '@dda/core';
import { RuntimeManifestSchema } from '@dda/spec';

import { DeployService } from '../../apps/desktop/src/main/services/deploy-service';
import type { Container } from '../../apps/desktop/src/main/services/container';
import type { JournalData } from '@dda/core';

const manifests = join(__dirname, '../../apps/desktop/resources/manifests');

async function fixture(): Promise<{ service: DeployService; root: string }> {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-lifecycle-'));
  const paths = appPaths(localAppData);
  await mkdir(paths.logs, { recursive: true });
  const logger = await Logger.create(paths.logs, 'test.log');
  const manifest = RuntimeManifestSchema.parse(JSON.parse(await readFile(join(manifests, 'node.json'), 'utf8')));
  const matrix = loadMatrix(JSON.parse(await readFile(join(manifests, 'compat.json'), 'utf8')));
  const container = {
    paths,
    logger,
    matrix,
    nodeManifest: manifest,
    manifestsDir: manifests,
    registry: 'https://registry.npmmirror.com',
  } as Container;
  return { service: new DeployService({ container, onEvent: () => undefined, authorize: notUsed }), root: paths.root };
}

async function notUsed(): Promise<never> {
  throw new Error('authorize should not be called in this test');
}

async function seed(service: DeployService, data: JournalData): Promise<void> {
  await new Journal(service.journalPath()).save(data);
}

function baseJournal(service: DeployService, overrides: Partial<JournalData> = {}): JournalData {
  return {
    taskId: service.taskId,
    scenario: 'full-deploy',
    status: 'succeeded',
    startedAt: '2026-11-04T00:00:00.000Z',
    finishedAt: '2026-11-04T00:01:00.000Z',
    steps: [],
    created: [],
    ...overrides,
  };
}

describe('回滚与启动互斥', () => {
  it('并发回滚按顺序执行：第二次回滚看到的是第一次已经删完的真实状态', async () => {
    const { service, root } = await fixture();
    const artifact = join(root, 'runtimes', 'pnpm');
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, 'payload.bin'), 'x');
    await seed(service, baseJournal(service, { created: [artifact] }));

    // Without serialisation both calls pass their `isRunning`/`exists` checks on the same stale
    // snapshot; the second would then report deleting a path the first already removed.
    const [first, second] = await Promise.all([service.rollback(true), service.rollback(true)]);

    expect(first.deleted).toEqual([artifact]);
    expect(second.deleted).toEqual([]);
    expect(second.refused).toEqual([]);
    expect(second.summary?.status).toBe('rolled-back');
  });

  it('回滚与取消清理并发时只删一次，任务记录保持一致', async () => {
    const { service, root } = await fixture();
    const artifact = join(root, 'harness', '0.2.0-rc.2');
    await mkdir(artifact, { recursive: true });
    await seed(service, baseJournal(service, { created: [artifact] }));

    const [rolledBack, cancelled] = await Promise.all([service.rollback(true), service.cancel(true)]);

    // Exactly one of the two operations may claim the path; the other sees it already gone.
    const claimed = [...rolledBack.deleted, ...cancelled.cleaned];
    expect(claimed).toEqual([artifact]);
    expect(await Journal.load(service.journalPath())).toBeDefined();
  });
});

describe('异常退出后的状态对账', () => {
  it('把停在 running 的任务修正为 failed，并保留已完成步骤', async () => {
    const { service } = await fixture();
    await seed(
      service,
      baseJournal(service, {
        status: 'running',
        finishedAt: undefined,
        steps: [
          { id: 'check-disk', title: '检查磁盘', status: 'succeeded', attempts: 1 },
          { id: 'install-node', title: '安装 Node', status: 'running', attempts: 1 },
          { id: 'install-harness', title: '安装 Harness', status: 'pending', attempts: 0 },
        ],
      }),
    );

    await service.reconcileInterrupted();

    const summary = await service.summary();
    expect(summary?.status).toBe('failed');
    expect(summary?.error).toContain('未正常结束');
    expect(summary?.steps.map((step) => step.status)).toEqual(['succeeded', 'failed', 'pending']);
  });

  it('正常结束的任务不会被改动', async () => {
    const { service } = await fixture();
    await seed(service, baseJournal(service, { status: 'succeeded', error: undefined }));

    await service.reconcileInterrupted();

    const summary = await service.summary();
    expect(summary?.status).toBe('succeeded');
    expect(summary?.error).toBeUndefined();
  });

  it('没有任务记录时是无操作', async () => {
    const { service } = await fixture();
    await expect(service.reconcileInterrupted()).resolves.toBeUndefined();
    expect(await service.summary()).toBeUndefined();
  });
});
