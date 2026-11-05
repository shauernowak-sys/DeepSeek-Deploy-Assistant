import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AppPaths } from '../../packages/adapters/src/paths';
import type { PluginState } from '@dda/spec';
import { PluginInventoryService, type PluginInventoryDeps } from '../../apps/desktop/src/main/services/plugin-inventory-service';
import type { HarnessService } from '../../apps/desktop/src/main/services/harness-service';

const PROFILE_PACKAGE = JSON.stringify({
  name: 'dsh-profile-web',
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@tencent-connect/dsh-qqbot'] } },
});

function paths(root: string): AppPaths {
  return {
    root,
    runtimes: join(root, 'runtimes'),
    nodeDir: join(root, 'runtimes', 'node'),
    pnpmPrefix: join(root, 'runtimes', 'pnpm'),
    harnessDir: join(root, 'harness'),
    dshHome: join(root, 'dsh-home'),
    stateTasks: join(root, 'state', 'tasks'),
    stateBackups: join(root, 'state', 'backups'),
    logs: join(root, 'logs'),
    downloads: join(root, 'cache', 'downloads'),
    licenses: join(root, 'licenses'),
  };
}

interface HarnessStubOptions {
  plugins?: PluginState[];
  listError?: string;
  dump?: string;
  clientModules?: string[] | undefined;
  running?: boolean;
  url?: string;
}

function harnessStub(options: HarnessStubOptions = {}) {
  const calls = { launch: 0, stop: 0, remove: [] as string[], restart: 0 };
  const harness = {
    running: options.running ?? false,
    ...(options.url === undefined ? {} : { get bindUrl() { return options.url; } }),
    async listPlugins() {
      if (options.listError !== undefined) throw new Error(options.listError);
      return options.plugins ?? [];
    },
    async dumpProfileConfig() {
      if (options.dump === undefined) throw new Error('dump-config 不可用');
      return options.dump;
    },
    async clientModuleIds() {
      return options.clientModules;
    },
    async launch() {
      calls.launch += 1;
      harness.running = true;
      return { running: true, url: 'http://127.0.0.1:1234/?token=t' };
    },
    async stop() {
      calls.stop += 1;
      harness.running = false;
    },
    async removePlugin(name: string) {
      // 运行中删除会失败（Windows 文件占用），这里把顺序也记下来供断言。
      calls.remove.push(name);
    },
    async restart() {
      calls.restart += 1;
      return { running: true };
    },
  } as unknown as HarnessService & { running: boolean };
  return { harness, calls };
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dda-plugins-'));
}

function deps(root: string, overrides: Partial<PluginInventoryDeps> = {}): Partial<PluginInventoryDeps> {
  return { harnessDeployed: true, harnessVersion: '0.2.1-rc.3', profile: 'web', ...overrides };
}

const qqList: PluginState[] = [{ name: '@tencent-connect/dsh-qqbot', version: '0.5.5', installed: true }];

describe('插件清单服务', () => {
  it('Harness 未部署时如实说明，不返回空列表冒充「没有插件」', async () => {
    const root = await makeRoot();
    const { harness } = harnessStub();
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root, { harnessDeployed: false }));
    const snapshot = await service.snapshot();
    expect(snapshot.harness.deployed).toBe(false);
    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.problems[0]).toContain('尚未安装');
  });

  it('插件列表读取失败时给出问题，而不是「没有安装任何插件」', async () => {
    const root = await makeRoot();
    const { harness } = harnessStub({ listError: 'pnpm 崩溃' });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root));
    const snapshot = await service.snapshot();
    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.problems.join(' ')).toContain('pnpm 崩溃');
  });

  it('组合真实读到的 profile 文件与 dump-config，得出可复核的状态', async () => {
    const root = await makeRoot();
    const profileDir = join(root, 'dsh-home', 'profiles', 'web');
    const pkgDir = join(profileDir, 'node_modules', '@tencent-connect', 'dsh-qqbot');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(profileDir, 'package.json'), PROFILE_PACKAGE, 'utf8');
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@tencent-connect/dsh-qqbot', dsh: { client: { platform: 'web' } } }), 'utf8');
    await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: im-qqbot\n  config:\n    access:\n      c2cMode: open\n', 'utf8');

    const { harness } = harnessStub({
      plugins: qqList,
      dump: "entries:\n  - name: '@deepseek-ai/dsh-web-app'\n  - name: '@tencent-connect/dsh-qqbot'\n",
      clientModules: ['@tencent-connect/dsh-qqbot'],
      running: true,
      url: 'http://127.0.0.1:1234/?token=t',
    });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root, { harnessRunning: true }));
    const snapshot = await service.snapshot();

    expect(snapshot.harness).toMatchObject({ deployed: true, running: true, profile: 'web', version: '0.2.1-rc.3' });
    const plugin = snapshot.plugins[0]!;
    expect(plugin.name).toBe('@tencent-connect/dsh-qqbot');
    expect(plugin.state).toEqual({ installed: true, composed: 'yes', loaded: 'yes', configured: 'yes' });
    expect(plugin.settings?.panelLabel).toBe('QQ 机器人');
  });

  it('Aurabot 的「配置已写入」来自它自己的 setupDone，而不是安装成功', async () => {
    const root = await makeRoot();
    const dataDir = join(root, 'dsh-home', 'plugins-data', 'aurabot');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ setupDone: false }), 'utf8');

    const { harness } = harnessStub({
      plugins: [{ name: 'dsh-aurabot-qq', version: '1.1.24', installed: true }],
      dump: "  - name: 'dsh-aurabot-qq'\n",
    });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root));
    const snapshot = await service.snapshot();
    expect(snapshot.plugins[0]!.state.configured).toBe('no');
    expect(snapshot.plugins[0]!.known).toBe(true);
  });

  it('打开设置：核实过的入口会先启动 Harness 并返回地址', async () => {
    const root = await makeRoot();
    const { harness, calls } = harnessStub({
      plugins: qqList,
      dump: "  - name: '@tencent-connect/dsh-qqbot'\n",
      url: 'http://127.0.0.1:1234/?token=t',
    });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root));
    const result = await service.openSettings('@tencent-connect/dsh-qqbot');
    expect(calls.launch).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.panelLabel).toBe('QQ 机器人');
    expect(result.url).toContain('token=');
  });

  it('打开设置：没有核实入口的插件不会被编一个地址', async () => {
    const root = await makeRoot();
    const { harness, calls } = harnessStub({
      plugins: [{ name: 'mystery-plugin', version: '1.0.0', installed: true }],
      dump: '  - name: mystery-plugin\n',
    });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root));
    const result = await service.openSettings('mystery-plugin');
    expect(result.ok).toBe(false);
    expect(result.url).toBeUndefined();
    expect(calls.launch).toBe(0);
  });

  it('卸载：未确认时不动环境', async () => {
    const root = await makeRoot();
    const { harness, calls } = harnessStub({ plugins: qqList, dump: "  - name: '@tencent-connect/dsh-qqbot'\n" });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root));
    const result = await service.uninstall('@tencent-connect/dsh-qqbot', false);
    expect(result.ok).toBe(false);
    expect(calls.remove).toEqual([]);
  });

  it('卸载：备份失败就中止，不删除任何东西', async () => {
    const root = await makeRoot();
    const { harness, calls } = harnessStub({ plugins: qqList, dump: "  - name: '@tencent-connect/dsh-qqbot'\n" });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root));
    const result = await service.uninstall('@tencent-connect/dsh-qqbot', true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('已中止卸载');
    expect(calls.remove).toEqual([]);
  });

  it('卸载：备份成功后才移除，并在运行时重启，同时说明数据保留情况', async () => {
    const root = await makeRoot();
    const profileDir = join(root, 'dsh-home', 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'package.json'), PROFILE_PACKAGE, 'utf8');
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');

    const { harness, calls } = harnessStub({
      plugins: qqList,
      dump: "  - name: '@tencent-connect/dsh-qqbot'\n",
      running: true,
    });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root, { harnessRunning: true }));
    const result = await service.uninstall('@tencent-connect/dsh-qqbot', true);
    expect(result.ok).toBe(true);
    expect(result.backupDir).toBeDefined();
    expect(calls.remove).toEqual(['@tencent-connect/dsh-qqbot']);
    // 运行中的 Harness 会占住 profile 文件，必须先停再卸，成功后重新启动。
    expect(calls.stop).toBe(1);
    expect(calls.launch).toBe(1);
    expect(result.message).toContain('卸载');
    expect(result.message).toContain('授权');
  });

  it('卸载：Harness 未运行时不额外启动它', async () => {
    const root = await makeRoot();
    const profileDir = join(root, 'dsh-home', 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'package.json'), PROFILE_PACKAGE, 'utf8');
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');

    const { harness, calls } = harnessStub({ plugins: qqList, dump: "  - name: '@tencent-connect/dsh-qqbot'\n" });
    const service = new PluginInventoryService({ paths: paths(root) } as never, harness, deps(root));
    const result = await service.uninstall('@tencent-connect/dsh-qqbot', true);
    expect(result.ok).toBe(true);
    expect(calls.stop).toBe(0);
    expect(calls.launch).toBe(0);
    expect(result.restarted).toBe(false);
  });
});
