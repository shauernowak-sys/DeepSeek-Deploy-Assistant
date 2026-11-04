import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { appPaths, type DshCli } from '@dda/adapters';
import { loadMatrix } from '@dda/core';
import { QQ_PLUGIN_DISTRIBUTION, RuntimeManifestSchema, type RuntimeSelection } from '@dda/spec';

import { buildDeploySteps } from '../../apps/desktop/src/main/services/deploy-plan';

const manifests = join(__dirname, '../../apps/desktop/resources/manifests');

/**
 * Gate 4 ② 降级后的行为锁：
 * - 官方 QQ 插件的安装步骤必须先过分发门禁，再调用官方安装命令；
 * - 日志里必须出现"仅支持在线安装"的说明（不得只写在文档里）。
 */
async function officialSteps(cli: DshCli, runtime?: RuntimeSelection) {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-dist-gate-'));
  const paths = appPaths(localAppData);
  const manifest = RuntimeManifestSchema.parse(JSON.parse(await readFile(join(manifests, 'node.json'), 'utf8')));
  const matrix = loadMatrix(JSON.parse(await readFile(join(manifests, 'compat.json'), 'utf8')));
  return buildDeploySteps({
    paths,
    manifest,
    matrix,
    registry: 'https://registry.npmmirror.com',
    log: () => undefined,
    cli,
    runtime,
    qqMode: 'official',
  });
}

function recordingCli() {
  const addPlugin = vi.fn(async () => undefined);
  const cli: DshCli = {
    version: async () => ({ id: 'dsh', installed: true, version: '0.2.0-rc.2' }),
    ensureProfile: async () => undefined,
    listPlugins: async () => [{ name: '@tencent-connect/dsh-qqbot', version: '0.5.5', installed: true }],
    addPlugin,
    removePlugin: async () => undefined,
    launchWeb: async () => {
      throw new Error('not used');
    },
  };
  return { cli, addPlugin };
}

function ctx(logs: string[]) {
  return {
    progress: () => undefined,
    created: () => undefined,
    log: (line: string) => logs.push(line),
    signal: new AbortController().signal,
    isCancelled: () => false,
  };
}

describe('官方 QQ 插件安装：分发门禁 + 在线安装说明', () => {
  it('通过在线安装门禁，调用锁定版本的官方安装命令，并在日志说明许可边界', async () => {
    const { cli, addPlugin } = recordingCli();
    const steps = await officialSteps(cli);
    const install = steps.find((s) => s.id === 'install-qqbot');
    expect(install).toBeDefined();

    const logs: string[] = [];
    await install!.run(ctx(logs));

    expect(addPlugin).toHaveBeenCalledTimes(1);
    expect(addPlugin).toHaveBeenCalledWith('web', '@tencent-connect/dsh-qqbot@0.5.5');
    const joined = logs.join('\n');
    expect(joined).toContain('仅支持在线安装');
    expect(joined).toContain('UNLICENSED');
    expect(joined).toContain('不提供离线安装');
  });

  it('个人 QQ 路线不产生官方插件安装步骤（不误装）', async () => {
    const { cli } = recordingCli();
    const localAppData = await mkdtemp(join(tmpdir(), 'dda-dist-gate-personal-'));
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
      qqMode: 'personal',
    });
    expect(steps.map((s) => s.id)).not.toContain('install-qqbot');
  });

  it('说明文案与实际策略同源（不在 UI/日志里另写一套）', async () => {
    const logs: string[] = [];
    const { cli } = recordingCli();
    const steps = await officialSteps(cli);
    await steps.find((s) => s.id === 'install-qqbot')!.run(ctx(logs));
    expect(logs).toContain(QQ_PLUGIN_DISTRIBUTION.notice);
  });
});
