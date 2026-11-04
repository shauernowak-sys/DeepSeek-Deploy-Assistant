import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MarketIndexError, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';
import { describe, expect, it } from 'vitest';

import { CATALOG } from '../../catalog/index';
import {
  MARKET_INDEX_BASE_URL,
  assertArtifactsExist,
  buildMarketIndex,
  buildOverlay,
  collectCatalogProblems,
  collectIconProblems,
  collectIndexProblems,
  collectRegistryProblems,
  loadMatrix,
  type RegistryVersionFacts,
} from '@dda/core';
import { CatalogOverlaySchema, CatalogSchema } from '@dda/spec';

const REPO_ROOT = join(__dirname, '..', '..');
const MANIFESTS = join(REPO_ROOT, 'apps', 'desktop', 'resources', 'manifests');
const CATALOG_DIR = join(REPO_ROOT, 'catalog');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 故意改坏的索引：测试要能随意删字段，因此用宽松结构。 */
type LooseIndex = {
  format: number;
  title: unknown;
  plugins: Array<Record<string, unknown> & { versions: Array<Record<string, unknown>> }>;
};

function looseIndex(): LooseIndex {
  return clone(buildMarketIndex(CATALOG)) as unknown as LooseIndex;
}

async function matrix() {
  return loadMatrix(JSON.parse(await readFile(join(MANIFESTS, 'compat.json'), 'utf8')));
}

/** 官方校验器抛出的错误路径，用于断言「是哪一条规则拦下的」。 */
function officialError(document: unknown, baseUrl = MARKET_INDEX_BASE_URL): MarketIndexError {
  try {
    parseMarketIndex(document, baseUrl);
  } catch (error) {
    if (error instanceof MarketIndexError) return error;
    throw error;
  }
  throw new Error('官方校验器未拒绝该索引');
}

describe('D01 索引构建链：官方校验器通过 + 生成物与 catalog 一致', () => {
  it('合法 catalog 产出的 index.json 能通过 parseMarketIndex，且逐字段与 catalog 一致', () => {
    const index = buildMarketIndex(CATALOG);
    const parsed = parseMarketIndex(index, MARKET_INDEX_BASE_URL);

    expect(parsed.format).toBe(1);
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0]?.name).toBe('@tencent-connect/dsh-qqbot');
    expect(parsed.plugins[0]?.versions[0]?.version).toBe('0.5.5');
    // 相对图标必须被官方校验器按索引基址解析成同源绝对 URL
    expect(parsed.plugins[0]?.icon).toBe(
      new URL('icons/plg-official-qqbot.svg', MARKET_INDEX_BASE_URL).href,
    );
    expect(collectIndexProblems(CATALOG, index, parsed)).toEqual([]);
  });

  it('缺 publishTimestamp → 官方校验器在 versions[0].publishTimestamp 处失败', () => {
    const index = looseIndex();
    delete index.plugins[0]?.versions[0]?.publishTimestamp;
    expect(officialError(index).path).toBe('$.plugins[0].versions[0].publishTimestamp');
  });

  it('版本写成 latest → 官方校验器拒绝（索引只能宣称精确版本）', () => {
    const index = looseIndex();
    const version = index.plugins[0]?.versions[0];
    if (version === undefined) throw new Error('缺少版本');
    version.version = 'latest';
    expect(officialError(index).path).toBe('$.plugins[0].versions[0].version');
  });

  it('纯中文 title → 官方校验器拒绝（必须含 en）', () => {
    const index = looseIndex();
    index.title = { zh: '插件资源中心' };
    expect(officialError(index).path).toBe('$.title');
  });

  it('图标超过 32 KiB 或缺失 → 构建期断言失败（官方只校验 data URL，不看磁盘文件）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-icons-'));
    await mkdir(join(dir, 'icons'), { recursive: true });
    await writeFile(join(dir, 'icons', 'plg-official-qqbot.svg'), `<svg width="64" height="64">${'x'.repeat(33 * 1024)}</svg>`, 'utf8');

    const oversize = await collectIconProblems(dir, CATALOG);
    expect(oversize.join('\n')).toContain('上限');

    const missingDir = await mkdtemp(join(tmpdir(), 'dda-icons-missing-'));
    const missing = await collectIconProblems(missingDir, CATALOG);
    expect(missing.join('\n')).toContain('不存在');
  });

  it('overlay 缺少 license → zod 校验失败（overlay 字段不允许漏）', () => {
    const overlay = clone(buildOverlay(CATALOG)) as { plugins: Array<Record<string, unknown>> };
    expect(CatalogOverlaySchema.safeParse(overlay).success).toBe(true);

    delete overlay.plugins[0]?.license;
    const parsed = CatalogOverlaySchema.safeParse(overlay);
    expect(parsed.success).toBe(false);
  });

  it('把 overlay 字段塞进 index.json → 官方校验器静默丢弃，我方一致性断言必须报错', () => {
    const index = looseIndex();
    const plugin = index.plugins[0];
    if (plugin === undefined) throw new Error('缺少插件');
    plugin.license = { spdx: 'MIT', redistributable: false };
    plugin.versions[0]!.acceptance = ['x'];

    // 官方校验器接受它，但字段被丢掉 —— 这正是「看起来配了、实际丢失」的假象
    const parsed = parseMarketIndex(index, MARKET_INDEX_BASE_URL);
    expect(Object.hasOwn(parsed.plugins[0] ?? {}, 'license')).toBe(false);

    const problems = collectIndexProblems(
      CATALOG,
      index as unknown as Parameters<typeof collectIndexProblems>[1],
      parsed,
    ).join('\n');
    expect(problems).toContain('overlay 字段 "license"');
    expect(problems).toContain('overlay 字段 "acceptance"');
  });

  it('blocked 条目不出现在索引里', () => {
    const blockedCatalog = CatalogSchema.parse({
      schemaVersion: 1,
      entries: CATALOG.entries.map((entry) => ({ ...entry, status: 'blocked' })),
    });
    expect(buildMarketIndex(blockedCatalog).plugins).toHaveLength(0);
  });

  it('产物目录里的图标可被解析（validate-index 的存在性检查）', async () => {
    const outDir = join(REPO_ROOT, 'apps', 'desktop', 'resources', 'market');
    const index = buildMarketIndex(CATALOG);
    expect(await assertArtifactsExist(outDir, index)).toEqual([]);
  });

  it('英文标题/描述不含中文（拿中文顶替 en 只是骗过校验器）', () => {
    const index = buildMarketIndex(CATALOG);
    const cjk = /[\u3400-\u9fff]/;
    expect(cjk.test(index.title.en)).toBe(false);
    expect(cjk.test(index.description.en)).toBe(false);
    for (const plugin of index.plugins) {
      expect(cjk.test(plugin.title.en)).toBe(false);
      expect(cjk.test(plugin.description.en)).toBe(false);
    }
  });
});

describe('D01 catalog 规则（不联网即可判定）', () => {
  it('真实 catalog 通过全部规则', async () => {
    expect(collectCatalogProblems(CATALOG, await matrix())).toEqual([]);
  });

  it('engines.dsh 未锁定到 compat 版本 → 报错（不得宣称未验证组合）', async () => {
    const catalog = CatalogSchema.parse({
      schemaVersion: 1,
      entries: [{ ...CATALOG.entries[0], enginesDsh: '>=0.2.0-rc.2 <0.3.0' }],
    });
    expect(collectCatalogProblems(catalog, await matrix()).join('\n')).toContain('engines.dsh 必须锁定');
  });

  it('compat 指向非 verified-local 条目 → 报错', async () => {
    const catalog = CatalogSchema.parse({
      schemaVersion: 1,
      entries: [{ ...CATALOG.entries[0], compat: 'C3-latest' }],
    });
    expect(collectCatalogProblems(catalog, await matrix()).join('\n')).toContain('verified-local');
  });

  it('闭包含 UNLICENSED 却标记 redistributable=true → 报错', async () => {
    const catalog = CatalogSchema.parse({
      schemaVersion: 1,
      entries: [{ ...CATALOG.entries[0], license: { spdx: 'MIT', redistributable: true } }],
    });
    expect(collectCatalogProblems(catalog, await matrix()).join('\n')).toContain('redistributable 必须为 false');
  });
});

describe('D01 registry 复核', () => {
  const facts = (overrides: Partial<RegistryVersionFacts> = {}): RegistryVersionFacts => ({
    versionExists: true,
    publishTimestamp: 1793375955,
    integrity: CATALOG.entries[0]!.integrity,
    ...overrides,
  });

  it('与 registry 一致时无问题', () => {
    const map = new Map<string, RegistryVersionFacts>([
      ['@tencent-connect/dsh-qqbot@0.5.5', facts()],
    ]);
    expect(collectRegistryProblems(CATALOG, map)).toEqual([]);
  });

  it('时间戳或 integrity 不一致、版本不存在时必须报错', () => {
    const label = '@tencent-connect/dsh-qqbot@0.5.5';
    const mismatched = new Map<string, RegistryVersionFacts>([
      [label, facts({ publishTimestamp: 1 })],
    ]);
    expect(collectRegistryProblems(CATALOG, mismatched).join('\n')).toContain('publishTimestamp');

    const badIntegrity = new Map<string, RegistryVersionFacts>([
      [label, facts({ integrity: 'sha512-AAAA' })],
    ]);
    expect(collectRegistryProblems(CATALOG, badIntegrity).join('\n')).toContain('integrity');

    const missing = new Map<string, RegistryVersionFacts>([[label, facts({ versionExists: false })]]);
    expect(collectRegistryProblems(CATALOG, missing).join('\n')).toContain('不存在该版本');
  });
});
