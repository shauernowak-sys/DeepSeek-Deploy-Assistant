import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG } from '../../catalog/index';
import { buildOverlay, collectCatalogProblems, evaluateClosure, loadMatrix } from '@dda/core';
import { CatalogSchema } from '@dda/spec';

const MANIFESTS = join(__dirname, '..', '..', 'apps', 'desktop', 'resources', 'manifests');

async function matrix() {
  return loadMatrix(JSON.parse(await readFile(join(MANIFESTS, 'compat.json'), 'utf8')));
}

/** PRD §10.5 冻结结果：V0.1 只有一个真插件。 */
const OFFICIAL_QQBOT = '@tencent-connect/dsh-qqbot';

describe('D09 首批资源策展：范围', () => {
  it('V0.1 只有一个真插件条目（不得为"显得丰富"而扩充）', () => {
    expect(CATALOG.entries).toHaveLength(1);
    expect(CATALOG.entries[0]?.name).toBe(OFFICIAL_QQBOT);
    expect(CATALOG.entries[0]?.status).toBe('verified');
  });
});

describe('D09 首批资源策展：PRD §10.2 必需字段', () => {
  it('名称/标题/描述（中英）、作者、主页或仓库、精确版本与发布时间', () => {
    for (const entry of CATALOG.entries) {
      expect(entry.zh.name).not.toBe('');
      expect(entry.en.name).not.toBe('');
      expect(entry.zh.summary).not.toBe('');
      expect(entry.en.summary).not.toBe('');
      expect(entry.zh.description).not.toBe('');
      expect(entry.author).toBeTruthy();
      expect(entry.homepage ?? entry.repository).toBeTruthy();
      expect(entry.version).not.toBe('latest');
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.publishTimestamp).toBeGreaterThan(0);
    }
  });

  it('兼容范围锁定到 verified-local 组合的宿主版本', async () => {
    const compat = await matrix();
    for (const entry of CATALOG.entries) {
      const match = compat.entries.find((candidate) => candidate.id === entry.compat);
      expect(match?.status).toBe('verified-local');
      expect(entry.enginesDsh).toBe(`=${match?.dsh}`);
    }
  });

  it('来源、完整性、许可、验收、依赖闭包齐备', () => {
    for (const entry of CATALOG.entries) {
      expect(entry.source.type).toBe('npm');
      expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      expect(entry.license.spdx).toBe('MIT');
      expect(entry.acceptance.length).toBeGreaterThanOrEqual(1);
      expect(entry.depsClosure.length).toBeGreaterThanOrEqual(1);
      expect(entry.safety.network.length).toBeGreaterThan(0);
      expect(entry.installNotes.length).toBeGreaterThan(0);
    }
  });
});

describe('D09 首批资源策展：验收方式必须可执行', () => {
  it('每条都有唯一 id，且"操作"与"证据"分开描述、不重复', () => {
    for (const entry of CATALOG.entries) {
      const ids = entry.acceptance.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const item of entry.acceptance) {
        expect(item.id).toMatch(/^acc-[a-z0-9-]+$/);
        expect(item.step).not.toBe(item.evidence);
        expect(item.step.length).toBeGreaterThanOrEqual(6);
        expect(item.evidence.length).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('官方 QQ 插件覆盖扫码绑定、群消息、私聊图片三条真实链路', () => {
    const entry = CATALOG.entries[0]!;
    const joined = entry.acceptance.map((item) => `${item.step}${item.evidence}`).join('\n');
    expect(joined).toContain('扫码');
    expect(joined).toContain('群');
    expect(joined).toContain('图片');
  });
});

describe('D09 首批资源策展：许可结论与 D11 输出一致（快照比对）', () => {
  it('overlay 里的逐包裁决 == evaluateClosure 现算结果', () => {
    const overlay = buildOverlay(CATALOG);
    for (const entry of CATALOG.entries) {
      const generated = overlay.plugins.find((plugin) => plugin.id === entry.id);
      const report = evaluateClosure(`${entry.name}@${entry.version}`, entry.depsClosure);
      expect(generated?.depsClosure).toEqual(report.entries);
    }
  });

  it('闭包含 UNLICENSED → 条目判定"仅在线安装"（redistributable=false）', () => {
    for (const entry of CATALOG.entries) {
      const report = evaluateClosure(`${entry.name}@${entry.version}`, entry.depsClosure);
      expect(report.verdict).toBe('denied');
      expect(report.denied.map((pkg) => pkg.name)).toContain('@tencent-connect/qqbot-connector');
      expect(entry.license.redistributable).toBe(false);
    }
  });

  it('本体许可与闭包内同名包一致（不宣称与包事实不同的许可）', () => {
    for (const entry of CATALOG.entries) {
      const own = entry.depsClosure.find((pkg) => pkg.name === entry.name && pkg.version === entry.version);
      expect(own?.license).toBe(entry.license.spdx);
    }
  });

  it('闭包快照与前置验证 §5.2 的数量与分布一致（37 包）', () => {
    for (const entry of CATALOG.entries) {
      const report = evaluateClosure(`${entry.name}@${entry.version}`, entry.depsClosure);
      expect(report.entries).toHaveLength(37);
      expect(report.byLicense).toEqual(
        expect.arrayContaining([
          { license: 'MIT', count: 26 },
          { license: 'ISC', count: 8 },
          { license: 'Apache-2.0', count: 1 },
          { license: 'Python-2.0', count: 1 },
          { license: 'UNLICENSED', count: 1 },
        ]),
      );
    }
  });
});

describe('D09 首批资源策展：schema 强校验', () => {
  it('真实 catalog 通过全部策展规则', async () => {
    expect(collectCatalogProblems(CATALOG, await matrix())).toEqual([]);
  });

  it('缺 license 的条目被 zod 拒绝（全字段必填）', () => {
    const entry = CATALOG.entries[0]!;
    const { license: _license, ...withoutLicense } = entry;
    const parsed = CatalogSchema.safeParse({ schemaVersion: 1, entries: [withoutLicense] });
    expect(parsed.success).toBe(false);
  });

  it('把验收项写成纯字符串（不可执行）会被拒绝', () => {
    const entry = CATALOG.entries[0]!;
    const parsed = CatalogSchema.safeParse({
      schemaVersion: 1,
      entries: [{ ...entry, acceptance: ['群内 @ 机器人并收到回复'] }],
    });
    expect(parsed.success).toBe(false);
  });
});
