import { describe, expect, it } from 'vitest';

import {
  AURABOT_ADAPTER,
  OFFICIAL_QQBOT_ADAPTER,
  PLUGIN_ADAPTERS,
  describeUnknownPlugin,
  findPluginAdapter,
} from '../../packages/core/src/market/plugin-adapters';

describe('插件适配表', () => {
  it('包名与 id 唯一，且只收录本轮真正处理过的三个插件', () => {
    expect(new Set(PLUGIN_ADAPTERS.map((a) => a.name)).size).toBe(PLUGIN_ADAPTERS.length);
    expect(new Set(PLUGIN_ADAPTERS.map((a) => a.id)).size).toBe(PLUGIN_ADAPTERS.length);
    expect(PLUGIN_ADAPTERS.map((a) => a.name).sort()).toEqual([
      '@tencent-connect/dsh-qqbot',
      'dsh-aurabot-qq',
      'dsh-qq-link',
    ]);
  });

  it('设置入口必须带核实日期、核实方式与正确形态', () => {
    for (const adapter of PLUGIN_ADAPTERS) {
      const settings = adapter.settings;
      expect(settings, adapter.name).toBeDefined();
      expect(settings!.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(settings!.evidence.length).toBeGreaterThanOrEqual(20);
      expect(settings!.label.length).toBeGreaterThan(0);
      if (settings!.kind === 'harness-panel') {
        expect(settings!.panelLabel, adapter.name).toBeTruthy();
      } else {
        expect(settings!.appPage, adapter.name).toBe('personal-qq');
      }
    }
  });

  it('卸载说明必须交代数据去哪了，不能只写「已卸载」', () => {
    for (const adapter of PLUGIN_ADAPTERS) {
      expect(adapter.uninstall.dataNote.length, adapter.name).toBeGreaterThan(30);
      expect(adapter.uninstall.restartRequired, adapter.name).toBe(true);
    }
  });

  it('Aurabot 的数据保留说明来自实测的 plugins-data 目录', () => {
    expect(AURABOT_ADAPTER.uninstall.dataNote).toContain('plugins-data\\aurabot');
    expect(AURABOT_ADAPTER.uninstall.dataNote).toContain('保留');
    expect(AURABOT_ADAPTER.settings?.panelLabel).toBe('Aurabot');
    expect(AURABOT_ADAPTER.guideId).toBe('guide-aurabot-persona');
  });

  it('官方 QQ 插件的入口是它自己的左侧栏面板，不是猜出来的地址', () => {
    expect(OFFICIAL_QQBOT_ADAPTER.settings?.kind).toBe('harness-panel');
    expect(OFFICIAL_QQBOT_ADAPTER.settings?.panelLabel).toBe('QQ 机器人');
    expect(OFFICIAL_QQBOT_ADAPTER.settings?.evidence).toContain('左侧栏');
    expect(findPluginAdapter('@tencent-connect/dsh-qqbot')).toBe(OFFICIAL_QQBOT_ADAPTER);
    expect(findPluginAdapter('not-a-plugin')).toBeUndefined();
  });

  it('未收录插件不编造设置入口，也不假装知道它的数据位置', () => {
    const unknown = describeUnknownPlugin('-example/unknown-plugin', '1.0.0');
    expect(unknown.known).toBe(false);
    expect(unknown.settings).toBeUndefined();
    expect(unknown.guideId).toBeUndefined();
    expect(unknown.state.loaded).toBe('unknown');
    expect(unknown.uninstall.dataNote).toContain('未核实');
    expect(unknown.id).toBe('pkg:-example/unknown-plugin');
  });
});
