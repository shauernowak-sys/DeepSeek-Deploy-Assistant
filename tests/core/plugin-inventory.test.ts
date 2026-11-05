import { describe, expect, it } from 'vitest';

import { buildInstalledPlugins, installedNames, type InstalledPluginFacts } from '../../packages/core/src/market/plugin-inventory';

const qq = { name: '@tencent-connect/dsh-qqbot', version: '0.5.5', installed: true };
const aurabot = { name: 'dsh-aurabot-qq', version: '1.1.24', installed: true };

function facts(overrides: Partial<InstalledPluginFacts>): InstalledPluginFacts {
  return {
    installed: [qq],
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', qq.name],
    composedNames: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', qq.name],
    clientModules: [`${qq.name}`],
    clientDeclared: [qq.name],
    ...overrides,
  };
}

describe('我的插件：证据装配', () => {
  it('装进 profile × 组合进配置 × 页面下发模块 → 各自的证据都为是', () => {
    const [plugin] = buildInstalledPlugins(facts({ configured: { [qq.name]: true } }));
    expect(plugin!.state).toEqual({ installed: true, composed: 'yes', loaded: 'yes', configured: 'yes' });
    expect(plugin!.settings?.panelLabel).toBe('QQ 机器人');
    expect(plugin!.stateNotes).toEqual([]);
  });

  it('只在依赖里、不在加载列表 → 明确说重启也不会出现', () => {
    const [plugin] = buildInstalledPlugins(facts({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      composedNames: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    }));
    expect(plugin!.state.composed).toBe('no');
    expect(plugin!.stateNotes.join(' ')).toContain('重启 Harness 也不会显示');
  });

  it('读不到组合结果 → 未验证，而不是猜测为「是」', () => {
    const [plugin] = buildInstalledPlugins(facts({ composedNames: undefined }));
    expect(plugin!.state.composed).toBe('unknown');
    expect(plugin!.stateNotes.join(' ')).toContain('无法确认');
  });

  it('Harness 运行时页面没有下发该插件模块 → 已加载为否', () => {
    const [plugin] = buildInstalledPlugins(facts({ clientModules: ['@deepseek-ai/dsh-client-ui-chat'] }));
    expect(plugin!.state.loaded).toBe('no');
    expect(plugin!.stateNotes.join(' ')).toContain('可能启动失败');
  });

  it('Harness 没运行 → 已加载未验证，不拿「已安装」冒充「已加载」', () => {
    const [plugin] = buildInstalledPlugins(facts({ clientModules: undefined }));
    expect(plugin!.state.loaded).toBe('unknown');
    expect(plugin!.stateNotes.join(' ')).toContain('Harness 当前没有运行');
  });

  it('没有网页界面的插件无法靠页面判断 → 未验证并说明原因', () => {
    const [plugin] = buildInstalledPlugins(facts({ installed: [{ ...qq, name: 'some-cli-plugin' }], clientDeclared: [] }));
    expect(plugin!.state.loaded).toBe('unknown');
    expect(plugin!.known).toBe(false);
    expect(plugin!.stateNotes.pop()).toContain('没有提供网页界面');
  });

  it('配置证据缺省时保持未验证，不因为安装成功就写「已配置」', () => {
    const [plugin] = buildInstalledPlugins(facts({}));
    expect(plugin!.state.configured).toBe('unknown');
  });

  it('未收录插件仍能卸载，但没有伪造的设置入口', () => {
    const [plugin] = buildInstalledPlugins(facts({ installed: [{ name: 'mystery-plugin', version: '0.0.1', installed: true }] }));
    expect(plugin!.known).toBe(false);
    expect(plugin!.settings).toBeUndefined();
    expect(plugin!.uninstall.dataNote.length).toBeGreaterThan(10);
  });

  it('重复与未安装的记录不会重复成卡', () => {
    const plugins = buildInstalledPlugins(facts({
      installed: [qq, qq, aurabot, { name: 'gone', installed: false }],
      bundles: [qq.name, aurabot.name],
      composedNames: [qq.name, aurabot.name],
      clientDeclared: [qq.name, aurabot.name],
      clientModules: [qq.name, aurabot.name],
    }));
    expect(plugins.map((p) => p.name)).toEqual([qq.name, aurabot.name]);
    expect(installedNames(facts({}))).toEqual([qq.name]);
  });
});
