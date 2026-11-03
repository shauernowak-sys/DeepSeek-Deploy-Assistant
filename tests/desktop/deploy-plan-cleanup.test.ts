import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, loadMatrix, rollbackPlan, type Step, type StepContext } from '@dda/core';
import { appPaths, type DshCli } from '@dda/adapters';
import { RuntimeManifestSchema } from '@dda/spec';

import { buildDeploySteps } from '../../apps/desktop/src/main/services/deploy-plan';

const manifestPath = join(__dirname, '../../apps/desktop/resources/manifests/node.json');
const matrixPath = join(__dirname, '../../apps/desktop/resources/manifests/compat.json');

async function buildPlan() {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-plan-'));
  const paths = appPaths(localAppData);
  const manifest = RuntimeManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const matrix = loadMatrix(JSON.parse(await readFile(matrixPath, 'utf8')));

  const calls: string[] = [];
  const cli: DshCli = {
    version: async () => ({ id: 'dsh', installed: true, version: '0.2.0-rc.2' }),
    ensureProfile: async (profile) => {
      calls.push(`ensureProfile:${profile}`);
      await mkdir(join(paths.dshHome, 'profiles', profile), { recursive: true });
    },
    listPlugins: async () => [],
    addPlugin: async (profile, spec) => {
      calls.push(`addPlugin:${profile}:${spec}`);
    },
    removePlugin: async () => undefined,
    launchWeb: async () => {
      throw new Error('not used in this test');
    },
  };

  const steps = buildDeploySteps({
    paths,
    manifest,
    matrix,
    registry: 'https://registry.npmmirror.com',
    log: () => undefined,
    cli,
  });
  return { paths, steps, calls };
}

function ctxFor(created: string[]): StepContext {
  return {
    progress: () => undefined,
    created: (p) => created.push(p),
    log: () => undefined,
    signal: new AbortController().signal,
    isCancelled: () => false,
  };
}

function step(steps: Step[], id: string): Step {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`step ${id} missing`);
  return found;
}

describe('部署计划：清理边界', () => {
  it('ensure-profile 不把 dsh-home 记入 created[]（否则取消清理会删掉用户 profile）', async () => {
    const { paths, steps, calls } = await buildPlan();
    const created: string[] = [];
    await step(steps, 'ensure-profile').run(ctxFor(created));

    expect(calls).toContain('ensureProfile:web');
    expect(created).toEqual([]);
    // Nothing under the user data root may ever be recorded.
    for (const p of created) expect(p.startsWith(paths.dshHome)).toBe(false);
  });

  it('取消清理：用户 profile 与其中的配置保持完好，只删除安装产物', async () => {
    const { paths, steps } = await buildPlan();
    const profileDir = join(paths.dshHome, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    const userConfig = join(profileDir, 'config.json');
    await writeFile(userConfig, '{"apiKey":"user-owned"}', 'utf8');

    // Simulate the artifacts a cancelled deployment created.
    const artifacts = [paths.downloads, paths.nodeDir, join(paths.root, 'bin')];
    for (const dir of artifacts) await mkdir(dir, { recursive: true });
    await writeFile(join(paths.downloads, 'node.zip'), 'x');

    const journal = new Journal(join(paths.stateTasks, 'full-deploy.json'));
    const data = {
      taskId: 'full-deploy',
      scenario: 'full-deploy',
      status: 'cancelled' as const,
      startedAt: new Date().toISOString(),
      steps: [],
      created: [...artifacts],
    };
    await journal.save(data);
    await rollbackPlan(data, steps, () => undefined, { pruneAbove: paths.root, allowedRoots: [paths.root] });

    expect(await readFile(userConfig, 'utf8')).toBe('{"apiKey":"user-owned"}');
    for (const dir of artifacts) {
      await expect(readFile(join(dir, 'nothing'))).rejects.toThrow();
    }
    expect(data.status).toBe('rolled-back');
  });

  it('安装产物才会被记入 created[]（抽查 5 个步骤）', async () => {
    const { paths, steps } = await buildPlan();
    for (const id of ['download-node', 'extract-node', 'ensure-pnpm', 'write-shim', 'install-dsh']) {
      expect(typeof step(steps, id).run).toBe('function');
    }
    const artifactPrefixes = [paths.downloads, paths.nodeDir, paths.pnpmPrefix, paths.harnessDir, join(paths.root, 'bin')];
    for (const prefix of artifactPrefixes) expect(prefix.startsWith(paths.dshHome)).toBe(false);
  });
});
