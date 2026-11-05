import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildInstalledPlugins,
  createProfileBackup,
  readQqEntry,
} from '@dda/core';
import { dshBinJs, fileExists, loadRuntimeSelection } from '@dda/adapters';
import { BASELINE, type InstalledPluginView, type PluginInventorySnapshot, type PluginState } from '@dda/spec';

import type { Container } from './container';
import type { HarnessService } from './harness-service';

/** 只做读取的依赖集合；测试里可整体替换，不需要真实的 Harness。 */
export interface PluginInventoryDeps {
  listPlugins: () => Promise<PluginState[]>;
  dumpConfig: () => Promise<string>;
  clientModuleIds: () => Promise<string[] | undefined>;
  readTextFile: (path: string) => Promise<string | undefined>;
  fileExists: (path: string) => Promise<boolean>;
  harnessRunning: boolean;
  harnessUrl?: string;
  harnessDeployed: boolean;
  harnessVersion?: string;
  profile: string;
}

function parseBundles(packageJson: string | undefined): string[] {
  if (packageJson === undefined) return [];
  try {
    const parsed = JSON.parse(packageJson) as { dsh?: { profile?: { bundles?: unknown } } };
    const bundles = parsed.dsh?.profile?.bundles;
    return Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** `--dump-config` 的输出里，每个条目有一行 `name: '@scope/pkg'`。 */
function composedNamesFrom(dump: string | undefined): string[] | undefined {
  if (dump === undefined) return undefined;
  const names = new Set<string>();
  for (const match of dump.matchAll(/^\s*-?\s*name:\s*['"]?(@?[^'"\s]+)['"]?\s*$/gm)) {
    names.add(match[1]!);
  }
  return [...names];
}

/** 声明了 `dsh.client` 的包才有网页界面模块，只有它们能靠页面判断「已加载」。 */
async function declaredClientPackages(
  profileDir: string,
  names: readonly string[],
  deps: PluginInventoryDeps,
): Promise<string[]> {
  const declared: string[] = [];
  for (const name of names) {
    const raw = await deps.readTextFile(join(profileDir, 'node_modules', name, 'package.json'));
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw) as { dsh?: { client?: unknown } };
      if (parsed.dsh?.client !== undefined) declared.push(name);
    } catch {
      // 包清单读不到或损坏时保守处理：不声称能判断它的加载状态。
    }
  }
  return declared;
}

export class PluginInventoryService {
  constructor(
    private readonly container: Container,
    private readonly harness: HarnessService,
    private readonly overrides?: Partial<PluginInventoryDeps>,
  ) {}

  private get profileDir(): string {
    return join(this.container.paths.dshHome, 'profiles', BASELINE.dsh.profile);
  }

  private async resolveDeps(): Promise<PluginInventoryDeps> {
    const { paths } = this.container;
    const runtime = await loadRuntimeSelection(paths);
    const bin = runtime.harness.bin ?? dshBinJs(paths);
    const base: PluginInventoryDeps = {
      listPlugins: () => this.harness.listPlugins(),
      dumpConfig: () => this.harness.dumpProfileConfig(),
      clientModuleIds: () => this.harness.clientModuleIds(),
      readTextFile: (path) => readFile(path, 'utf8').catch(() => undefined),
      fileExists,
      harnessRunning: this.harness.running,
      ...(this.harness.bindUrl === undefined ? {} : { harnessUrl: this.harness.bindUrl }),
      harnessDeployed: await fileExists(bin),
      ...(runtime.harness.version === undefined ? {} : { harnessVersion: runtime.harness.version }),
      profile: BASELINE.dsh.profile,
    };
    return { ...base, ...this.overrides };
  }

  /** 插件自己写入的配置是否已存在；只有真能读到的才算数。 */
  private async configuredFor(name: string, deps: PluginInventoryDeps): Promise<boolean | undefined> {
    if (name === '@tencent-connect/dsh-qqbot') {
      const patch = await deps.readTextFile(join(this.profileDir, 'cordis.patch.yml'));
      if (patch === undefined) return false;
      return readQqEntry(patch).present;
    }
    if (name === 'dsh-aurabot-qq') {
      const raw = await deps.readTextFile(join(this.container.paths.dshHome, 'plugins-data', 'aurabot', 'config.json'));
      if (raw === undefined) return false;
      try {
        const parsed = JSON.parse(raw) as { setupDone?: unknown };
        return parsed.setupDone === true;
      } catch {
        return false;
      }
    }
    return undefined;
  }

  async snapshot(): Promise<PluginInventorySnapshot> {
    const deps = await this.resolveDeps();
    const problems: string[] = [];
    const checkedAt = new Date().toISOString();

    if (!deps.harnessDeployed) {
      return {
        harness: {
          deployed: false,
          running: false,
          profile: deps.profile,
          ...(deps.harnessVersion === undefined ? {} : { version: deps.harnessVersion }),
        },
        plugins: [],
        problems: ['Harness 尚未安装：先完成「部署向导」里的环境部署，才能读取已安装的插件。'],
        checkedAt,
      };
    }

    let installed: PluginState[] = [];
    try {
      installed = await deps.listPlugins();
    } catch (error) {
      problems.push(
        `读取已安装插件失败：${error instanceof Error ? error.message : String(error)}。请先确认 Harness 已正确部署，然后重试。`,
      );
    }

    const bundles = parseBundles(await deps.readTextFile(join(this.profileDir, 'package.json')));
    let composedNames: string[] | undefined;
    try {
      composedNames = composedNamesFrom(await deps.dumpConfig());
    } catch (error) {
      problems.push(
        `读取 web 配置环境的组合结果失败：${error instanceof Error ? error.message : String(error)}。加载情况会显示为未验证。`,
      );
    }

    const clientModules = deps.harnessRunning ? await deps.clientModuleIds() : undefined;
    if (deps.harnessRunning && clientModules === undefined) {
      problems.push('Harness 正在运行，但没有读到它的页面模块清单；加载情况会显示为未验证。');
    }

    const names = installed.filter((plugin) => plugin.installed).map((plugin) => plugin.name);
    const clientDeclared = await declaredClientPackages(this.profileDir, names, deps);

    const configured: Record<string, boolean> = {};
    for (const name of names) {
      const value = await this.configuredFor(name, deps);
      if (value !== undefined) configured[name] = value;
    }

    const plugins = buildInstalledPlugins({
      installed,
      bundles,
      ...(composedNames === undefined ? {} : { composedNames }),
      ...(clientModules === undefined ? {} : { clientModules }),
      clientDeclared,
      configured,
    });

    return {
      harness: {
        deployed: true,
        running: deps.harnessRunning,
        ...(deps.harnessUrl === undefined ? {} : { url: deps.harnessUrl }),
        profile: deps.profile,
        ...(deps.harnessVersion === undefined ? {} : { version: deps.harnessVersion }),
      },
      plugins,
      problems,
      checkedAt,
    };
  }

  /**
   * 打开插件真实存在的设置入口。
   *
   * 只有适配表里**核实过**的入口才会走到这里；`harness-panel` 会先确保 Harness 在本软件管理
   * 的环境里运行，再把带 token 的地址交给系统浏览器（同一套 profile，不会是另一个环境）。
   */
  async openSettings(name: string): Promise<{
    ok: boolean;
    url?: string;
    panelLabel?: string;
    appPage?: 'personal-qq';
    guideId?: string;
    message: string;
  }> {
    const snapshot = await this.snapshot();
    const plugin = snapshot.plugins.find((item) => item.name === name);
    if (plugin === undefined) {
      return { ok: false, message: `${name} 不在本软件管理的环境里，无法打开设置。` };
    }
    const settings = plugin.settings;
    if (settings === undefined) {
      return { ok: false, message: '这个插件没有已核实的设置入口。可以到 Harness 网页的「插件」页面查看它自己的界面。' };
    }
    if (settings.kind === 'app-page') {
      return { ok: true, appPage: settings.appPage ?? 'personal-qq', message: '已切换到本软件里的设置页。' };
    }
    try {
      await this.harness.launch(0);
    } catch (error) {
      return {
        ok: false,
        message: `Harness 启动失败：${error instanceof Error ? error.message : String(error)}。请到「故障诊断」查看原因后重试。`,
      };
    }
    const url = this.harness.bindUrl;
    if (url === undefined) return { ok: false, message: 'Harness 已启动，但没有取得访问地址，请重试。' };
    return {
      ok: true,
      url,
      ...(settings.panelLabel === undefined ? {} : { panelLabel: settings.panelLabel }),
      ...(plugin.guideId === undefined ? {} : { guideId: plugin.guideId }),
      message: settings.panelLabel === undefined
        ? '已在浏览器中打开 Harness。'
        : `已在浏览器中打开 Harness：请点左侧栏的「${settings.panelLabel}」。`,
    };
  }

  /**
   * 卸载：先备份 web 配置环境，再交给官方的 `plugin remove`，最后按需重启。
   * 只操作这一个包名，不做通配删除，也不碰插件自己的数据目录。
   */
  async uninstall(name: string, confirmed: boolean): Promise<{
    ok: boolean;
    message: string;
    backupDir?: string;
    restarted: boolean;
    plugins?: InstalledPluginView[];
  }> {
    if (!confirmed) return { ok: false, message: '需要确认后才能卸载插件。', restarted: false };
    const snapshot = await this.snapshot();
    const target = snapshot.plugins.find((item) => item.name === name);
    if (target === undefined) {
      return { ok: false, message: `${name} 不在本软件管理的环境里，未执行任何删除。`, restarted: false };
    }

    let backupDir: string | undefined;
    try {
      await mkdir(this.container.paths.stateBackups, { recursive: true });
      const backup = await createProfileBackup({
        profileDir: this.profileDir,
        backupsRoot: this.container.paths.stateBackups,
      });
      backupDir = backup.dir;
    } catch (error) {
      // 没有备份就不动用户的 profile：失败要可诊断、可恢复。
      return {
        ok: false,
        message: `卸载前备份 web 配置环境失败，已中止卸载：${error instanceof Error ? error.message : String(error)}。`,
        restarted: false,
      };
    }

    // Windows 上运行中的 Harness 会占住 profile 里的文件，pnpm 无法删除 → 先停再卸。
    const wasRunning = this.harness.running;
    if (wasRunning) {
      try {
        await this.harness.stop();
      } catch (error) {
        return {
          ok: false,
          message: `卸载前无法停止 Harness，已中止卸载：${error instanceof Error ? error.message : String(error)}。`,
          backupDir,
          restarted: false,
        };
      }
    }

    try {
      await this.harness.removePlugin(name);
    } catch (error) {
      const detail = await this.readPluginManagerLog();
      const storeHint = /UNEXPECTED_STORE/.test(`${detail}${String(error)}`)
        ? '这个 profile 的依赖是用另一个 pnpm 存储目录安装的，删除时对不上。可以在 Harness 网页的「插件」页面卸载，或重新部署该环境后再试。'
        : '';
      const message = `卸载失败：${error instanceof Error ? error.message : String(error)}。${storeHint}${detail}配置环境已备份，可在「回到上一可用」里恢复。`;
      if (wasRunning) {
        try {
          await this.harness.launch(0);
        } catch {
          // 重启失败不影响「卸载失败」这条结论，用户仍可手动启动。
        }
      }
      return { ok: false, message, backupDir, restarted: false };
    }

    let restarted = false;
    if (wasRunning) {
      try {
        await this.harness.launch(0);
        restarted = true;
      } catch (error) {
        return {
          ok: true,
          message: `已卸载 ${name}，但重新启动 Harness 失败：${error instanceof Error ? error.message : String(error)}。请手动启动后再确认。`,
          backupDir,
          restarted,
        };
      }
    }

    const after = await this.snapshot();
    return {
      ok: true,
      message: `已卸载 ${name}。${target.uninstall.dataNote}`,
      backupDir,
      restarted,
      plugins: after.plugins,
    };
  }

  /** Harness 把 pnpm 的具体报错写在 profile 的 `.plugin-manager/logs` 里；失败时带上一小段。 */
  private async readPluginManagerLog(): Promise<string> {
    try {
      const logsRoot = join(this.profileDir, '.plugin-manager', 'logs');
      const entries = await readdir(logsRoot, { withFileTypes: true });
      const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      const latest = dirs[dirs.length - 1];
      if (latest === undefined) return '';
      const text = await readFile(join(logsRoot, latest, 'pnpm.log'), 'utf8');
      const tail = text.trim().slice(-400);
      return tail === '' ? '' : `安装器返回：${tail}。`;
    } catch {
      return '';
    }
  }

  /** 已安装包名集合：给「找插件」显示安装状态。 */
  async installedNames(): Promise<string[]> {
    try {
      const list = await this.harness.listPlugins();
      return list.filter((plugin) => plugin.installed).map((plugin) => plugin.name);
    } catch {
      return [];
    }
  }
}
