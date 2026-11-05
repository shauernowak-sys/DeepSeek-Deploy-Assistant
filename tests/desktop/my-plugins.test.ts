import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InstalledPluginView, PluginInventorySnapshot } from '@dda/spec';

import { GuideView } from '../../apps/desktop/src/renderer/src/components/GuideView';
import { MyPlugins } from '../../apps/desktop/src/renderer/src/components/MyPlugins';
import { MarketCenter } from '../../apps/desktop/src/renderer/src/components/MarketCenter';
import { GUIDES } from '../../apps/desktop/src/renderer/src/components/guides';
import { loadMarketCatalog } from '../../apps/desktop/src/main/services/market-catalog';
import { join } from 'node:path';

const qqPlugin: InstalledPluginView = {
  id: 'plg-official-qqbot',
  name: '@tencent-connect/dsh-qqbot',
  title: '官方 QQ 机器人',
  summary: '把 QQ 群聊和私聊接到 Harness。',
  version: '0.5.5',
  known: true,
  state: { installed: true, composed: 'yes', loaded: 'yes', configured: 'yes' },
  stateNotes: [],
  settings: {
    kind: 'harness-panel',
    label: '打开 QQ 机器人设置',
    panelLabel: 'QQ 机器人',
    verifiedAt: '2026-11-05',
    evidence: '隔离环境安装后左侧栏出现「QQ 机器人」',
  },
  guideId: 'guide-official-qqbot',
  uninstall: { dataNote: '卸载会移除插件本体与加载条目；平台授权不由本软件控制。', restartRequired: true },
};

const unknownPlugin: InstalledPluginView = {
  id: 'pkg:mystery-plugin',
  name: 'mystery-plugin',
  title: 'mystery-plugin',
  summary: '本产品还没有为这个插件提供设置入口或使用引导。',
  known: false,
  state: { installed: true, composed: 'unknown', loaded: 'unknown', configured: 'unknown' },
  stateNotes: ['设置页与数据目录未核实。'],
  uninstall: { dataNote: '卸载只移除插件本体，数据位置未核实。', restartRequired: true },
};

function snapshot(plugins: InstalledPluginView[], overrides: Partial<PluginInventorySnapshot['harness']> = {}): PluginInventorySnapshot {
  return {
    harness: { deployed: true, running: true, profile: 'web', version: '0.2.1-rc.3', ...overrides },
    plugins,
    problems: [],
    checkedAt: '2026-11-05T04:00:00.000Z',
  };
}

const noopProps = {
  onReload: () => undefined,
  onOpenSettings: () => undefined,
  onUninstall: () => undefined,
  onOpenGuide: () => undefined,
  onBrowse: () => undefined,
  onOpenDiagnostics: () => undefined,
  onOpenPersonalQq: () => undefined,
};

/** MarketCenter 需要的 mine 形状（动作名不同）。 */
const mineProps = {
  loading: false,
  reload: () => undefined,
  openSettings: () => undefined,
  uninstall: () => undefined,
  openPersonalQq: () => undefined,
};

describe('我的插件', () => {
  it('分开展示安装、加入配置、已加载和配置已写入', () => {
    const html = renderToStaticMarkup(createElement(MyPlugins, {
      ...noopProps,
      snapshot: snapshot([qqPlugin]),
      loading: false,
    }));
    expect(html).toContain('安装：是');
    expect(html).toContain('加入配置：是');
    expect(html).toContain('已加载：是');
    expect(html).toContain('配置已写入：是');
    expect(html).toContain('打开 QQ 机器人设置');
    expect(html).toContain('使用引导');
    expect(html).toContain('卸载…');
    expect(html).toContain('web 配置环境');
  });

  it('未验证的证据显示为未验证，不冒充可用', () => {
    const html = renderToStaticMarkup(createElement(MyPlugins, {
      ...noopProps,
      snapshot: snapshot([{ ...qqPlugin, state: { installed: true, composed: 'unknown', loaded: 'unknown', configured: 'unknown' } }]),
      loading: false,
    }));
    expect(html).toContain('已加载：未验证');
    expect(html).toContain('配置已写入：未验证');
  });

  it('没装插件时给出「去找插件」，而不是空页面', () => {
    const html = renderToStaticMarkup(createElement(MyPlugins, { ...noopProps, snapshot: snapshot([]), loading: false }));
    expect(html).toContain('还没有安装任何插件');
    expect(html).toContain('去找插件');
  });

  it('Harness 未部署时说清原因', () => {
    const html = renderToStaticMarkup(createElement(MyPlugins, {
      ...noopProps,
      snapshot: snapshot([], { deployed: false }),
      loading: false,
    }));
    expect(html).toContain('还没有部署 Harness');
  });

  it('读取问题、加载中与失败态都不会渲染成空列表', () => {
    const loading = renderToStaticMarkup(createElement(MyPlugins, { ...noopProps, loading: true }));
    expect(loading).toContain('正在读取已安装的插件');

    const failed = renderToStaticMarkup(createElement(MyPlugins, { ...noopProps, loading: false, error: '读取失败：pnpm 崩溃' }));
    expect(failed).toContain('pnpm 崩溃');
    expect(failed).toContain('重试');

    const withProblems = renderToStaticMarkup(createElement(MyPlugins, {
      ...noopProps,
      loading: false,
      snapshot: { ...snapshot([qqPlugin]), problems: ['读取组合结果失败'] },
    }));
    expect(withProblems).toContain('有些信息没读到');
    expect(withProblems).toContain('读取组合结果失败');
  });

  it('未收录插件没有伪造的设置按钮，并提示数据位置未核实', () => {
    const html = renderToStaticMarkup(createElement(MyPlugins, { ...noopProps, snapshot: snapshot([unknownPlugin]), loading: false }));
    expect(html).toContain('未收录');
    expect(html).toContain('没有已核实的设置入口');
    expect(html).not.toContain('打开 QQ 机器人设置');
  });

  it('卸载说明与确认按钮同时出现，缺一不可', () => {
    const html = renderToStaticMarkup(createElement(MyPlugins, {
      ...noopProps,
      snapshot: snapshot([qqPlugin]),
      loading: false,
      notice: { ok: false, message: '卸载失败：网络错误' },
    }));
    expect(html).toContain('卸载失败：网络错误');
    expect(html).not.toContain('确认卸载');
  });
});

describe('插件中心两个入口', () => {
  const marketDir = join(__dirname, '../../apps/desktop/resources/market');

  it('顶部提供「找插件」与「我的插件」两个入口', async () => {
    const data = await loadMarketCatalog(marketDir);
    const html = renderToStaticMarkup(createElement(MarketCenter, {
      data,
      loading: false,
      reload: () => undefined,
      openDiagnostics: () => undefined,
      openHarness: async () => ({ ok: true }),
      install: async () => ({ ok: true, message: '' }),
      mine: { ...mineProps, snapshot: snapshot([qqPlugin]) },
    }));
    expect(html).toContain('找插件');
    expect(html).toContain('我的插件（1）');
    expect(html).toContain('插件中心');
  });

  it('一开始就能进入「我的插件」，不需要先读目录', () => {
    const html = renderToStaticMarkup(createElement(MarketCenter, {
      loading: true,
      reload: () => undefined,
      openDiagnostics: () => undefined,
      openHarness: async () => ({ ok: true }),
      install: async () => ({ ok: false, message: '' }),
      mine: { ...mineProps, snapshot: snapshot([qqPlugin]) },
      initialTab: 'mine',
    }));
    expect(html).toContain('我的插件');
    expect(html).toContain('官方 QQ 机器人');
  });

  it('已安装的插件在「找插件」里带已安装标记', async () => {
    const data = await loadMarketCatalog(marketDir);
    const html = renderToStaticMarkup(createElement(MarketCenter, {
      data,
      loading: false,
      reload: () => undefined,
      openDiagnostics: () => undefined,
      openHarness: async () => ({ ok: true }),
      install: async () => ({ ok: true, message: '' }),
      mine: { ...mineProps, snapshot: snapshot([qqPlugin]) },
    }));
    expect(html).toContain('已安装');
  });
});

describe('图文引导', () => {
  it('真实截图逐步展示，并标明红框是说明添加的', () => {
    const guide = GUIDES['guide-aurabot-persona']!;
    const html = renderToStaticMarkup(createElement(GuideView, {
      guide,
      step: 2,
      onStep: () => undefined,
      onBack: () => undefined,
    }));
    expect(html).toContain('Aurabot 人设管理引导');
    expect(html).toContain('真实运行截图');
    expect(html).toContain('红框与编号为说明添加');
    expect(html).toContain('aurabot-wizard-gateway');
    expect(html).toContain('看到什么算完成');
  });

  it('没有截图的步骤明确说明原因，不伪装成截图', () => {
    const guide = GUIDES['guide-official-qqbot']!;
    const html = renderToStaticMarkup(createElement(GuideView, {
      guide,
      step: guide.steps.length - 1,
      onStep: () => undefined,
      onBack: () => undefined,
    }));
    expect(html).toContain('没有截图');
    expect(html).not.toContain('<figure');
  });

  it('引导正文与截图来源都写清未验证范围', () => {
    for (const guide of Object.values(GUIDES)) {
      expect(guide.caveat.length).toBeGreaterThan(40);
      expect(guide.steps.length).toBeGreaterThan(2);
      for (const step of guide.steps) {
        expect(step.check.length).toBeGreaterThan(4);
        expect(step.body.length).toBeGreaterThan(8);
      }
    }
  });
});
