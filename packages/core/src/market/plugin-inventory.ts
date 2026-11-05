import type { InstalledPluginView, PluginEvidence, PluginState } from '@dda/spec';

import { describeUnknownPlugin, findPluginAdapter } from './plugin-adapters';

/**
 * 「我的插件」的纯装配逻辑：把主进程读到的**事实**拼成卡片视图。
 *
 * 这里不做任何 IO，也不做任何猜测：每个证据字段要么来自真实读取，
 * 要么明确是 `unknown`。缺数据时宁可不给结论，也不要让「安装成功」冒充「可以使用」。
 */
export interface InstalledPluginFacts {
  /** `dsh plugin --profile <p> list` 的结果（顶层依赖）。 */
  installed: readonly PluginState[];
  /** profile `package.json` 的 `dsh.profile.bundles`。 */
  bundles: readonly string[];
  /** `--dump-config` 里出现的插件条目名（读不到时为 undefined）。 */
  composedNames?: readonly string[];
  /** 运行中的 Harness 下发给浏览器的客户端模块 id；未运行/读取失败为 undefined。 */
  clientModules?: readonly string[];
  /** profile 里声明了 `dsh.client` 的包名（只有它们可能有网页界面）。 */
  clientDeclared?: readonly string[];
  /** 已核实的「配置已写入」结论，键为包名；未列出的保持 unknown。 */
  configured?: Readonly<Record<string, boolean>>;
}

function composedEvidence(name: string, facts: InstalledPluginFacts): { value: PluginEvidence; note?: string } {
  if (facts.composedNames === undefined) {
    return { value: 'unknown', note: '没有读到 web 配置环境的组合结果，无法确认它是否会随 Harness 加载。' };
  }
  const inBundles = facts.bundles.includes(name);
  const inConfig = facts.composedNames.includes(name);
  if (inBundles && inConfig) return { value: 'yes' };
  if (!inBundles && !inConfig) {
    return {
      value: 'no',
      note: '它已在依赖里，但不在 web 配置环境的加载列表中：重启 Harness 也不会显示它自己提供的界面。',
    };
  }
  return {
    value: 'unknown',
    note: '加载列表与组合结果不一致（可能刚改动过配置），请重启 Harness 后再刷新。',
  };
}

function loadedEvidence(
  name: string,
  facts: InstalledPluginFacts,
): { value: PluginEvidence; note?: string } {
  if (!(facts.clientDeclared ?? []).includes(name)) {
    return {
      value: 'unknown',
      note: '这个插件没有提供网页界面，无法从 Harness 页面判断是否已加载；请在 Harness 里按插件说明确认。',
    };
  }
  if (facts.clientModules === undefined) {
    return { value: 'unknown', note: 'Harness 当前没有运行，加载情况未验证；启动后再刷新即可看到结果。' };
  }
  // `clientModules` 里是去掉 `/client.js` 的模块 id（例如 `@scope/plugin`）。
  return facts.clientModules.includes(name)
    ? { value: 'yes' }
    : {
        value: 'no',
        note: 'Harness 正在运行，但没有向页面下发这个插件的界面模块：它可能启动失败，或需要重启 Harness。',
      };
}

export function buildInstalledPlugins(facts: InstalledPluginFacts): InstalledPluginView[] {
  const seen = new Set<string>();
  const views: InstalledPluginView[] = [];

  for (const plugin of facts.installed) {
    if (!plugin.installed || seen.has(plugin.name)) continue;
    seen.add(plugin.name);
    const adapter = findPluginAdapter(plugin.name);
    const base: InstalledPluginView = adapter === undefined
      ? describeUnknownPlugin(plugin.name, plugin.version)
      : {
          id: adapter.id,
          name: adapter.name,
          title: adapter.title,
          summary: adapter.summary,
          ...(plugin.version === undefined ? {} : { version: plugin.version }),
          known: true,
          state: { installed: true, composed: 'unknown', loaded: 'unknown', configured: 'unknown' },
          stateNotes: [],
          ...(adapter.settings === undefined ? {} : { settings: adapter.settings }),
          ...(adapter.guideId === undefined ? {} : { guideId: adapter.guideId }),
          uninstall: adapter.uninstall,
          ...(adapter.requires === undefined ? {} : { requires: adapter.requires }),
        };

    const composed = composedEvidence(plugin.name, facts);
    const loaded = loadedEvidence(plugin.name, facts);
    const configured: PluginEvidence =
      facts.configured?.[plugin.name] === undefined
        ? 'unknown'
        : facts.configured[plugin.name]
          ? 'yes'
          : 'no';

    const notes = [...base.stateNotes];
    if (composed.note) notes.push(composed.note);
    if (loaded.note) notes.push(loaded.note);

    views.push({
      ...base,
      state: { installed: true, composed: composed.value, loaded: loaded.value, configured },
      stateNotes: notes,
    });
  }
  return views;
}

/** 把「已安装」和「目录里可安装但还没装」对齐，供「找插件」展示安装状态。 */
export function installedNames(facts: InstalledPluginFacts): string[] {
  return facts.installed.filter((plugin) => plugin.installed).map((plugin) => plugin.name);
}
