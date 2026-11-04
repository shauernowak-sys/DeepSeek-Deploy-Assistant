import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths } from '@dda/adapters';
import { Journal, loadMatrix, Logger } from '@dda/core';
import { RuntimeManifestSchema } from '@dda/spec';

import { DeployService } from '../../apps/desktop/src/main/services/deploy-service';
import type { Container } from '../../apps/desktop/src/main/services/container';

const manifests = join(__dirname, '../../apps/desktop/resources/manifests');

/**
 * §21.10「重试这一步」的服务端守卫。
 *
 * 这一步的价值不在于"又能跑一次部署"（那是 `resume`），而在于**只重跑卡住的那一步**，
 * 所以必须先确认 stepId 真的是当前卡住的步骤；任何含糊情况都拒绝，不做"猜用户想重试哪步"。
 */
async function fixture(): Promise<{ service: DeployService; root: string }> {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-retry-'));
  const paths = appPaths(localAppData);
  await mkdir(paths.logs, { recursive: true });
  await mkdir(paths.stateTasks, { recursive: true });
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
    childEnvExclusions: [],
  } as Container;
  return {
    service: new DeployService({
      container,
      onEvent: () => undefined,
      authorize: async () => {
        throw new Error('authorize should not be called in this test');
      },
    }),
    root: paths.root,
  };
}

type StepStatus = 'pending' | 'succeeded' | 'skipped' | 'failed';

async function seedJournal(
  service: DeployService,
  steps: Array<{ id: string; title: string; status: StepStatus }>,
  status: 'failed' | 'paused' | 'succeeded' = 'failed',
): Promise<void> {
  const journal = new Journal(service.journalPath());
  await journal.save({
    taskId: service.taskId,
    scenario: 'full-deploy',
    status,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    steps: steps.map((step) => ({ ...step, attempts: 1 })),
    created: [],
  });
}

describe('§21.10 重试这一步：守卫', () => {
  it('没有任务记录时拒绝，而不是凭空跑一次部署', async () => {
    const { service } = await fixture();
    await expect(service.retryStep(service.taskId, 'install-node')).rejects.toThrowError(/没有可重试的任务记录/u);
  });

  it('任务 ID 不匹配时拒绝', async () => {
    const { service } = await fixture();
    await seedJournal(service, [{ id: 'install-node', title: '安装 Node', status: 'failed' }]);
    await expect(service.retryStep('other-task', 'install-node')).rejects.toThrowError(/任务 ID 不匹配/u);
  });

  it('所有步骤都已完成时拒绝，并提示改用「重新部署（修复）」', async () => {
    const { service } = await fixture();
    await seedJournal(
      service,
      [
        { id: 'install-node', title: '安装 Node', status: 'succeeded' },
        { id: 'install-dsh', title: '安装 Harness', status: 'skipped' },
      ],
      'succeeded',
    );
    await expect(service.retryStep(service.taskId, 'install-node')).rejects.toThrowError(/没有需要重试的步骤/u);
  });

  it('只能重试"当前卡住的那一步"：已完成步骤 / 更后面的步骤都会被拒', async () => {
    const { service } = await fixture();
    await seedJournal(service, [
      { id: 'download-node', title: '下载 Node', status: 'succeeded' },
      { id: 'install-node', title: '安装 Node', status: 'failed' },
      { id: 'install-dsh', title: '安装 Harness', status: 'pending' },
    ]);

    await expect(service.retryStep(service.taskId, 'download-node')).rejects.toThrowError(
      /当前卡住的步骤是「安装 Node」，不是「download-node」/u,
    );
    await expect(service.retryStep(service.taskId, 'install-dsh')).rejects.toThrowError(/当前卡住的步骤是「安装 Node」/u);
  });

  it('守卫拒绝时不改动 journal（不会把任务状态改成 running）', async () => {
    const { service } = await fixture();
    await seedJournal(service, [{ id: 'install-node', title: '安装 Node', status: 'failed' }]);
    const before = await readFile(service.journalPath(), 'utf8');

    await expect(service.retryStep(service.taskId, 'not-the-current-step')).rejects.toThrow();
    expect(await readFile(service.journalPath(), 'utf8')).toBe(before);
  });
});
