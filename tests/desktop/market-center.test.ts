import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarketInstallSchema } from '@dda/spec';

import { CATALOG, CATALOG_CANDIDATES } from '../../catalog';
import { findInstallableMarketEntry, loadMarketCatalog } from '../../apps/desktop/src/main/services/market-catalog';
import { MarketCenter, MarketEvidence, MarketInstallAction, guideFor, installSpecFor, specMissingReason, InstallAddress } from '../../apps/desktop/src/renderer/src/components/MarketCenter';

const marketDir = join(__dirname, '../../apps/desktop/resources/market');

describe('资源中心清单和安装入口', () => {
  it('读取经过双重校验的真实清单', async () => {
    const data = await loadMarketCatalog(marketDir);
    expect(data.entries).toHaveLength(1);
    expect(data.candidates).toHaveLength(13);
    expect(data.candidates.filter((item) => item.status === 'needs-review')).toHaveLength(7);
    expect(data.candidates.filter((item) => item.status === 'blocked')).toHaveLength(6);
  });

  it('损坏的索引或 overlay 不会作为空资源列表返回', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-market-ui-'));
    const index = await readFile(join(marketDir, 'index.json'), 'utf8');
    const overlay = await readFile(join(marketDir, 'catalog.overlay.json'), 'utf8');
    await writeFile(join(dir, 'index.json'), '{');
    await writeFile(join(dir, 'catalog.overlay.json'), overlay);
    await expect(loadMarketCatalog(dir)).rejects.toThrow();
    await writeFile(join(dir, 'index.json'), index);
    await writeFile(join(dir, 'catalog.overlay.json'), '{}');
    await expect(loadMarketCatalog(dir)).rejects.toThrow();
  });

  it('格式合法但与当前策展数据不一致时整份拒绝', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-market-drift-'));
    const index = await readFile(join(marketDir, 'index.json'), 'utf8');
    const overlay = JSON.parse(await readFile(join(marketDir, 'catalog.overlay.json'), 'utf8'));
    overlay.candidates[0].zh.summary = '被修改过的插件描述';
    await writeFile(join(dir, 'index.json'), index);
    await writeFile(join(dir, 'catalog.overlay.json'), JSON.stringify(overlay));
    await expect(loadMarketCatalog(dir)).rejects.toThrow('资源清单不一致');
  });

  it('只有已验证条目渲染安装入口，所有候选均不渲染', () => {
    const render = (item: (typeof CATALOG.entries)[number] | (typeof CATALOG_CANDIDATES)[number]) =>
      renderToStaticMarkup(createElement(MarketInstallAction, { item, onClick: () => undefined }));
    expect(render(CATALOG.entries[0]!)).toContain('查看安装方案');
    for (const candidate of CATALOG_CANDIDATES) expect(render(candidate)).toBe('');
  });

  it('主进程要求明确确认，并只允许已验证的官方条目', () => {
    expect(() => MarketInstallSchema.parse({ id: CATALOG.entries[0]!.id, confirmed: false })).toThrow();
    expect(() => MarketInstallSchema.parse({ id: CATALOG.entries[0]!.id })).toThrow();
    expect(() => MarketInstallSchema.parse({ id: CATALOG.entries[0]!.id, confirmed: true, spec: 'arbitrary' })).toThrow();
    expect(findInstallableMarketEntry(CATALOG.entries, CATALOG.entries[0]!.id)).toBeDefined();
    for (const candidate of CATALOG_CANDIDATES) expect(findInstallableMarketEntry(CATALOG.entries, candidate.id)).toBeUndefined();
    expect(findInstallableMarketEntry([{ ...CATALOG.entries[0]!, status: 'blocked' }], CATALOG.entries[0]!.id)).toBeUndefined();
  });

  it('安装证据不冒充加载、配置或真实连接', () => {
    const html = renderToStaticMarkup(createElement(MarketEvidence, { item: CATALOG.entries[0]!, installed: true, installedVersion: '0.5.5' }));
    expect(html).toContain('安装：已安装 0.5.5');
    expect(html).toContain('加载：未验证');
    expect(html).toContain('配置：未验证');
    expect(html).toContain('连接：未验证');
    const unknown = renderToStaticMarkup(createElement(MarketEvidence, { item: CATALOG.entries[0]! }));
    expect(unknown).toContain('安装：未验证');
  });

  it('清单失败时展示错误与处理入口，不渲染空列表冒充正常', () => {
    const html = renderToStaticMarkup(createElement(MarketCenter, {
      loading: false, error: '资源清单校验失败', reload: () => undefined,
      openDiagnostics: () => undefined, openHarness: async () => ({ ok: false }),
      install: async () => ({ ok: false, message: '' }),
    }));
    expect(html).toContain('资源清单校验失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('打开故障诊断');
    expect(html).not.toContain('没有符合条件的插件');
  });

  it('分类覆盖 QQ 接入、人设与陪伴、记忆、语音、图片与表情包、主动消息与 QQ 空间', async () => {
    const data = await loadMarketCatalog(marketDir);
    for (const id of ['qq-bot', 'companion', 'memory', 'voice', 'images-memes', 'proactive-social']) {
      expect(data.categories[id], id).toBeDefined();
    }
    expect(data.categories.companion?.zh).toBe('人设与陪伴');
    expect(data.categories['images-memes']?.zh).toBe('图片与表情包');
    expect(data.categories['proactive-social']?.zh).toBe('主动消息与 QQ 空间');
  });

  it('推荐搭配按官方 QQ / 个人 QQ 路线展示，并说明最终选择权在用户', async () => {
    const data = await loadMarketCatalog(marketDir);
    const render = (route: 'official' | 'personal') => renderToStaticMarkup(createElement(MarketCenter, {
      data, route, loading: false, reload: () => undefined,
      openDiagnostics: () => undefined, openHarness: async () => ({ ok: false }),
      install: async () => ({ ok: false, message: '' }),
    }));
    const official = render('official');
    expect(official).toContain('推荐搭配');
    expect(official).toContain('最终选择权在你');
    expect(official).toContain('官方 QQ 机器人');
    expect(official).toContain('表情包插件（dsh-meme）');
    expect(official).not.toContain('SnowLuma（外部组件）');

    const personal = render('personal');
    expect(personal).toContain('SnowLuma（外部组件）');
    expect(personal).toContain('Aurabot（大肥鱼 QQ 陪伴）');
    expect(personal).toContain('SnowLuma QQ 工具集（dsh-qq-tools）');
    expect(personal).toContain('只选一个');
  });

  it('列表统一展示插件用途，不显示安装与验证标签', async () => {
    const data = await loadMarketCatalog(marketDir);
    const html = renderToStaticMarkup(createElement(MarketCenter, {
      data, loading: false, reload: () => undefined,
      openDiagnostics: () => undefined, openHarness: async () => ({ ok: false }),
      install: async () => ({ ok: false, message: '' }),
    }));
    expect(html).toContain('查看详情');
    expect(html).not.toContain('策展：已验证');
    expect(html).not.toContain('查看原因');
    expect(html).not.toContain('暂不可安装');
    expect(html).not.toContain('查看安装方案');
  });

  it('安装地址按真实来源生成；blocked 与 manual 不给地址', () => {
    const qq = CATALOG.entries[0]!;
    expect(installSpecFor(qq)).toBe('@tencent-connect/dsh-qqbot@0.5.5');

    const aurabot = CATALOG_CANDIDATES.find((item) => item.id === 'plg-dsh-aurabot-qq')!;
    expect(installSpecFor(aurabot)).toBe('github:aureth-labs/dsh-aurabot-qq');

    const meme = CATALOG_CANDIDATES.find((item) => item.name === 'dsh-meme')!;
    expect(installSpecFor(meme)).toBe(`dsh-meme@${meme.version}`);

    for (const blocked of CATALOG_CANDIDATES.filter((item) => item.status === 'blocked')) {
      expect(installSpecFor(blocked), blocked.name).toBeUndefined();
      expect(specMissingReason(blocked)).toContain('没有通过本产品的安装评估');
    }
    const manual = CATALOG_CANDIDATES.filter((item) => item.market.installMethod === 'manual');
    for (const item of manual) expect(installSpecFor(item), item.name).toBeUndefined();
  });

  it('安装地址一屏可见且可复制；没有地址时只说明原因', () => {
    const withSpec = renderToStaticMarkup(createElement(InstallAddress, {
      spec: '@tencent-connect/dsh-qqbot@0.5.5',
      reason: '不应出现',
      onCopy: () => undefined,
    }));
    expect(withSpec).toContain('安装地址');
    expect(withSpec).toContain('@tencent-connect/dsh-qqbot@0.5.5');
    expect(withSpec).toContain('复制');
    expect(withSpec).not.toContain('不应出现');

    const withoutSpec = renderToStaticMarkup(createElement(InstallAddress, {
      reason: '这个插件没有通过本产品的安装评估，因此不提供安装地址。',
      onCopy: () => undefined,
    }));
    expect(withoutSpec).toContain('没有通过本产品的安装评估');
    expect(withoutSpec).not.toContain('<button');
  });

  it('Aurabot 引导基于真实截图，并写清未验证范围', () => {
    const aurabot = CATALOG_CANDIDATES.find((item) => item.id === 'plg-dsh-aurabot-qq')!;
    const guide = guideFor(aurabot);
    expect(guide).toBeDefined();
    expect(guide!.steps).toHaveLength(6);
    expect(guide!.caveat).toContain('隔离验证环境');
    expect(guide!.caveat).toContain('真实收发');
    // 前五步有真实运行截图；最后一步（真实收发）没有截图，不能假装有。
    expect(guide!.steps.slice(0, 5).every((step) => step.image !== undefined)).toBe(true);
    expect(guide!.steps[5]!.image).toBeUndefined();
    const text = guide!.steps.map((step) => step.title).join(' ');
    expect(text).toContain('QQ 网关');
    expect(text).toContain('人格');
    expect(text).toContain('真实消息');
  });

  it('官方 QQ 引导使用已核实验收步骤，并标注真实收发未验证', () => {
    const guide = guideFor(CATALOG.entries[0]!);
    expect(guide).toBeDefined();
    expect(guide!.steps).toHaveLength(3);
    expect(guide!.caveat).toContain('隔离验证');
    expect(guide!.steps.map((step) => step.check).join(' ')).toContain('已绑定');
    expect(guide!.steps[0]!.image).toBeDefined();
    expect(guide!.steps[2]!.image).toBeUndefined();
  });

  it('引导只给已核实过的插件，不给候选编造步骤', () => {
    for (const candidate of CATALOG_CANDIDATES) {
      if (candidate.id === 'plg-dsh-aurabot-qq') continue;
      expect(guideFor(candidate), candidate.id).toBeUndefined();
    }
  });
});
