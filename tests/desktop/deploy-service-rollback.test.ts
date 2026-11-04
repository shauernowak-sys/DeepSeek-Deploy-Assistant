import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths } from '@dda/adapters';
import { Journal, loadMatrix, Logger } from '@dda/core';
import { RuntimeManifestSchema } from '@dda/spec';

import { DeployService } from '../../apps/desktop/src/main/services/deploy-service';
import type { Container } from '../../apps/desktop/src/main/services/container';

const manifests = join(__dirname, '../../apps/desktop/resources/manifests');

async function fixture(): Promise<{
  service: DeployService;
  root: string;
  localAppData: string;
}> {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-rollback-'));
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
  return {
    service: new DeployService({
      container,
      onEvent: () => undefined,
      authorize: async () => {
        throw new Error('authorize should not be called in this test');
      },
    }),
    root: paths.root,
    localAppData,
  };
}

async function seedJournal(service: DeployService, created: string[], status: 'succeeded' | 'failed' = 'succeeded') {
  const journal = new Journal(service.journalPath());
  await journal.save({
    taskId: service.taskId,
    scenario: 'full-deploy',
    status,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    steps: [],
    created,
  });
}

async function makeArtifact(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'payload.bin'), 'x');
}

describe('回滚：二次确认与删除边界', () => {
  it('没有 confirmed=true 时一律不删除任何东西', async () => {
    const { service, root } = await fixture();
    const artifact = join(root, 'runtimes', 'node', '22.23.4');
    await makeArtifact(artifact);
    await seedJournal(service, [artifact]);

    const result = await service.rollback(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('二次确认');
    expect(result.deleted).toEqual([]);
    expect(await readFile(join(artifact, 'payload.bin'), 'utf8')).toBe('x');
  });

  it('确认后只删除本次任务记录的产物，并把任务标为 rolled-back', async () => {
    const { service, root } = await fixture();
    const artifact = join(root, 'harness', '0.2.0-rc.2');
    await makeArtifact(artifact);
    // A user-owned file inside the managed root but NOT created by this task.
    const userProfile = join(root, 'dsh-home', 'profiles', 'web', 'config.json');
    await mkdir(join(root, 'dsh-home', 'profiles', 'web'), { recursive: true });
    await writeFile(userProfile, '{"keep":true}');
    await seedJournal(service, [artifact]);

    const result = await service.rollback(true);
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual([artifact]);
    expect(result.refused).toEqual([]);
    expect(result.summary?.status).toBe('rolled-back');
    expect(await readFile(userProfile, 'utf8')).toBe('{"keep":true}');
  });

  it('预览区分"可删除"与"无法确认归属"，并给出原因', async () => {
    const { service, root, localAppData } = await fixture();
    const artifact = join(root, 'runtimes', 'pnpm');
    await makeArtifact(artifact);
    const outside = join(localAppData, 'user-documents', 'draft.docx');
    await mkdir(join(localAppData, 'user-documents'), { recursive: true });
    await writeFile(outside, 'keep');
    await seedJournal(service, [artifact, outside]);

    const preview = await service.rollbackPreview();
    expect(preview.taskId).toBe(service.taskId);
    expect(preview.roots).toEqual([root]);
    expect(preview.existingCount).toBe(2);
    expect(preview.deletableCount).toBe(1);
    const refused = preview.entries.find((e) => e.path === outside);
    expect(refused?.deletable).toBe(false);
    expect(refused?.reason).toContain('不在本软件管理目录内');
  });

  it('journal 里混入受管目录外的路径时，回滚保留该路径并如实报告', async () => {
    const { service, root, localAppData } = await fixture();
    const artifact = join(root, 'runtimes', 'pnpm');
    await makeArtifact(artifact);
    const outside = join(localAppData, 'keep-me.txt');
    await writeFile(outside, 'user data');
    await seedJournal(service, [artifact, outside], 'failed');

    const result = await service.rollback(true);
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([artifact]);
    expect(result.refused.map((r) => r.path)).toEqual([outside]);
    expect(result.message).toContain('保留');
    expect(await readFile(outside, 'utf8')).toBe('user data');
  });

  it('没有任务记录时明确拒绝，而不是静默成功', async () => {
    const { service } = await fixture();
    const result = await service.rollback(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('没有可回滚的任务记录');
    expect(result.deleted).toEqual([]);
  });
});
