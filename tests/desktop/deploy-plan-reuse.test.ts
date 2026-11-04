import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths, type DshCli } from '@dda/adapters';
import { loadMatrix } from '@dda/core';
import { RuntimeManifestSchema, type RuntimeSelection } from '@dda/spec';

import { buildDeploySteps } from '../../apps/desktop/src/main/services/deploy-plan';

const manifests = join(__dirname, '../../apps/desktop/resources/manifests');

function fakeCli(version = '0.2.0-rc.2'): DshCli {
  return {
    version: async () => ({ id: 'dsh', installed: true, version }),
    ensureProfile: async () => undefined,
    listPlugins: async () => [],
    addPlugin: async () => undefined,
    removePlugin: async () => undefined,
    launchWeb: async () => {
      throw new Error('not used');
    },
  };
}

async function fixture(runtime?: RuntimeSelection, cli = fakeCli()) {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-reuse-plan-'));
  const paths = appPaths(localAppData);
  const manifest = RuntimeManifestSchema.parse(JSON.parse(await readFile(join(manifests, 'node.json'), 'utf8')));
  const matrix = loadMatrix(JSON.parse(await readFile(join(manifests, 'compat.json'), 'utf8')));
  const steps = buildDeploySteps({
    paths,
    manifest,
    matrix,
    registry: 'https://registry.npmmirror.com',
    log: () => undefined,
    cli,
    runtime,
  });
  return { paths, steps };
}

function ctx() {
  return {
    progress: () => undefined,
    created: () => undefined,
    log: () => undefined,
    signal: new AbortController().signal,
    isCancelled: () => false,
  };
}

const systemRuntime = (harnessBin: string): RuntimeSelection => ({
  node: { mode: 'system', exe: process.execPath, version: process.versions.node, dir: dirname(process.execPath) },
  harness: { mode: 'system', bin: harnessBin, version: '0.2.0-rc.2' },
});

describe('部署计划：复用已有运行时', () => {
  it('复用系统 Node：不下载、不解压 Node，只校验可执行', async () => {
    const { steps } = await fixture({
      node: { mode: 'system', exe: process.execPath, version: process.versions.node, dir: dirname(process.execPath) },
      harness: { mode: 'managed' },
    });
    const ids = steps.map((s) => s.id);
    expect(ids).not.toContain('download-node');
    expect(ids).not.toContain('extract-node');
    expect(ids).toContain('verify-node');
    expect(ids).toContain('install-dsh');
    expect(ids).toContain('ensure-pnpm');
  });

  it('复用系统 Harness：不安装第二份 dsh，只校验版本', async () => {
    const { steps } = await fixture(systemRuntime('C:\\x\\bin.js'));
    const ids = steps.map((s) => s.id);
    expect(ids).not.toContain('install-dsh');
    expect(ids).toContain('verify-dsh');
    expect(ids).not.toContain('download-node');
  });

  it('复用系统 Node 时验证步骤真的执行 node.exe，并检查下限', async () => {
    const { steps } = await fixture({
      node: { mode: 'system', exe: process.execPath, version: process.versions.node, dir: dirname(process.execPath) },
      harness: { mode: 'managed' },
    });
    const verify = steps.find((s) => s.id === 'verify-node')!;
    await expect(verify.run(ctx())).resolves.toBeUndefined();
  });

  it('复用系统 Harness 时校验步骤拒绝版本不一致', async () => {
    const bad = fakeCli('0.1.0-rc.8');
    const { steps } = await fixture(systemRuntime('C:\\x\\bin.js'), bad);
    const verify = steps.find((s) => s.id === 'verify-dsh')!;
    await expect(verify.run(ctx())).rejects.toThrow(/版本不符/);
  });

  it('pnpm shim 指向实际复用的 node.exe（不会回落到不存在的私有路径）', async () => {
    const { paths, steps } = await fixture({
      node: { mode: 'system', exe: process.execPath, version: process.versions.node, dir: dirname(process.execPath) },
      harness: { mode: 'managed' },
    });
    const writeShim = steps.find((s) => s.id === 'write-shim')!;
    await writeShim.run(ctx());
    const shim = await readFile(join(paths.root, 'bin', 'pnpm.cmd'), 'utf8');
    expect(shim).toContain(process.execPath);
    expect(shim).not.toContain(`${paths.nodeDir}\\node.exe`);
  });

  it('私有运行时计划保持原有完整步骤（回归）', async () => {
    const { steps } = await fixture(undefined);
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([
      'check-disk',
      'download-node',
      'extract-node',
      'verify-node',
      'ensure-pnpm',
      'write-shim',
      'install-dsh',
      'verify-dsh',
      'assert-combo',
      'ensure-profile',
      'install-qqbot',
      'verify-plugin',
      'route-report',
    ]);
  });
});
