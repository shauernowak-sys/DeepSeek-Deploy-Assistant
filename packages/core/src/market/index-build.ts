import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Catalog, CatalogEntry, CatalogOverlay, CompatMatrix } from '@dda/spec';
import { CatalogOverlaySchema } from '@dda/spec';

import { evaluateClosure, normalizeSpdx } from './license-gate';

/**
 * D01 索引构建链。
 *
 * 生成两份产物：
 * - `index.json`（官方 format 1）—— 由官方校验器 `parseMarketIndex` 兜底，我方**只生成不解释**；
 * - `catalog.overlay.json` —— 许可/哈希/闭包/验收/风险，官方格式无承载位，只由我方消费。
 *
 * 字段分工（构建日志会原样打印，防止后来者把两者混在一起）：
 * - 官方负责：format/title/description/metadata/name/title/description/icon/author/homepage/repository/
 *   versions[].version/publishTimestamp/source/engines；我方不得重复实现这些规则；
 * - 我方负责：license/integrity/depsClosure/acceptance/compat/zh/safety/installNotes/status。
 */

export const MARKET_INDEX_BASE_URL = 'https://market.invalid/dda/v1/index.json';

export const MARKET_FIELD_OWNERSHIP = {
  official: [
    'format === 1',
    'title / description 必须含 en',
    'plugins[].name 的 npm 包名语法与长度',
    'versions[].version 精确 SemVer、去重、降序',
    'versions[].publishTimestamp 整数范围',
    'versions[].source 的 npm/git 形态与 URL 规范性',
    'versions[].engines.dsh 的 SemVer range 语法',
    'icon 的 data URL 类型/32 KiB 上限/相对引用解析',
    'metadata.categories/labels/sortKeys 的声明-引用一致性',
  ],
  overlay: [
    'license（SPDX + redistributable）',
    'integrity（sha512，与 registry dist.integrity 一致）',
    'depsClosure（D11 计算出的逐包裁决）',
    'acceptance（可执行验收项）',
    'compat（指向 compat.json 的 verified-local 条目）',
    'zh（中文名称/用途/风险）',
    'safety（外联、权限、是否需重启）',
    'installNotes',
    'status（verified / needs-review / blocked）',
  ],
} as const;

/** 索引声明过的分类 id；条目只能引用这里出现过的 id（官方校验器会强校验）。 */
export const MARKET_CATEGORIES: Readonly<Record<string, { en: string; zh: string }>> = {
  'qq-bot': { en: 'QQ integrations', zh: 'QQ 接入' },
};

export const MARKET_LABELS: Readonly<Record<string, { en: string; zh: string }>> = {
  official: { en: 'Official', zh: '官方' },
};

export const MARKET_SORT_KEYS: Readonly<Record<string, { en: string; zh: string; order: 'asc' | 'desc' }>> = {
  publisher: { en: 'Publisher', zh: '发布方', order: 'asc' },
};

/** 官方校验器会**静默丢弃**这些字段；它们一旦出现在 index.json 就说明分工被破坏。 */
export const OVERLAY_ONLY_KEYS = [
  'license',
  'integrity',
  'depsClosure',
  'dependenciesClosure',
  'acceptance',
  'safety',
  'installNotes',
  'status',
  'compat',
  'zh',
] as const;

export interface MarketVersionDocument {
  version: string;
  publishTimestamp: number;
  source: CatalogEntry['source'];
  engines: { dsh: string };
}

export interface MarketPluginDocument {
  name: string;
  title: { en: string; zh: string };
  description: { en: string; zh: string };
  icon: string;
  author?: string;
  homepage?: string;
  repository?: { url: string; directory?: string };
  metadata: {
    category: string;
    keywords: string[];
    labels: string[];
    sortKeys: Record<string, number>;
  };
  versions: MarketVersionDocument[];
}

export interface MarketIndexDocument {
  format: 1;
  title: { en: string; zh: string };
  description: { en: string; zh: string };
  metadata: {
    categories: Record<string, { title: { en: string; zh: string } }>;
    labels: Record<string, { title: { en: string; zh: string } }>;
    sortKeys: Record<string, { title: { en: string; zh: string }; order: 'asc' | 'desc' }>;
  };
  plugins: MarketPluginDocument[];
}

/** 图标按稳定 id 命名，避免同一插件的多版本各带一份图标。 */
export function iconPathFor(entry: Pick<CatalogEntry, 'id'>): string {
  return `icons/${entry.id}.svg`;
}

/** `blocked` 条目不得出现在索引里：索引里出现即等于对外宣称可用。 */
export function listedEntries(catalog: Catalog): CatalogEntry[] {
  return catalog.entries.filter((entry) => entry.status !== 'blocked');
}

export function buildMarketIndex(catalog: Catalog): MarketIndexDocument {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of listedEntries(catalog)) {
    const list = groups.get(entry.name) ?? [];
    list.push(entry);
    groups.set(entry.name, list);
  }

  const plugins: MarketPluginDocument[] = [...groups.entries()].map(([name, entries]) => {
    const first = entries[0];
    if (first === undefined) throw new Error(`空插件分组: ${name}`);
    const versions = [...entries]
      .sort((a, b) => (a.version === b.version ? 0 : a.version < b.version ? 1 : -1))
      .map<MarketVersionDocument>((entry) => ({
        version: entry.version,
        publishTimestamp: entry.publishTimestamp,
        source: entry.source,
        engines: { dsh: entry.enginesDsh },
      }));

    return {
      name,
      title: { en: first.en.name, zh: first.zh.name },
      description: { en: first.en.summary, zh: first.zh.summary },
      icon: iconPathFor(first),
      ...(first.author === undefined ? {} : { author: first.author }),
      ...(first.homepage === undefined ? {} : { homepage: first.homepage }),
      ...(first.repository === undefined ? {} : { repository: first.repository }),
      metadata: {
        category: first.category,
        keywords: first.keywords,
        labels: first.labels,
        sortKeys: { publisher: 0 },
      },
      versions,
    };
  });

  return {
    format: 1,
    title: { en: 'DeepSeek Deploy Assistant plugin catalog', zh: '插件资源中心' },
    description: {
      en: 'Curated plugins for the locked DeepSeek Harness combination.',
      zh: '为锁定版本组合策展的插件清单；在线安装，不由本软件分发插件字节。',
    },
    metadata: {
      categories: Object.fromEntries(
        Object.entries(MARKET_CATEGORIES).map(([id, title]) => [id, { title: { en: title.en, zh: title.zh } }]),
      ),
      labels: Object.fromEntries(
        Object.entries(MARKET_LABELS).map(([id, title]) => [id, { title: { en: title.en, zh: title.zh } }]),
      ),
      sortKeys: Object.fromEntries(
        Object.entries(MARKET_SORT_KEYS).map(([id, key]) => [
          id,
          { title: { en: key.en, zh: key.zh }, order: key.order },
        ]),
      ),
    },
    plugins,
  };
}

/**
 * 生成 overlay。`depsClosure` 的裁决在这里由 D11 现算，不从 catalog 读取，
 * 保证「许可事实变了 → 裁决自动跟着变」。
 */
export function buildOverlay(catalog: Catalog, generatedFrom = 'catalog'): CatalogOverlay {
  const plugins = catalog.entries.map((entry) => {
    const report = evaluateClosure(`${entry.name}@${entry.version}`, entry.depsClosure);
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      compat: entry.compat,
      license: entry.license,
      integrity: entry.integrity,
      depsClosure: report.entries,
      acceptance: entry.acceptance,
      zh: entry.zh,
      category: entry.category,
      labels: entry.labels,
      keywords: entry.keywords,
      safety: entry.safety,
      installNotes: entry.installNotes,
      status: entry.status,
    };
  });

  return CatalogOverlaySchema.parse({ schemaVersion: 1, generatedFrom, plugins });
}

/** catalog 自身的规则（不依赖官方校验器，也不联网）。返回问题列表而不是抛错，便于一次报全。 */
export function collectCatalogProblems(catalog: Catalog, matrix: CompatMatrix): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const nameVersions = new Set<string>();

  for (const entry of catalog.entries) {
    const label = `${entry.id} (${entry.name}@${entry.version})`;

    if (ids.has(entry.id)) problems.push(`${label}: id 重复`);
    ids.add(entry.id);

    const nameVersion = `${entry.name}@${entry.version}`;
    if (nameVersions.has(nameVersion)) problems.push(`${label}: 同名同版本重复`);
    nameVersions.add(nameVersion);

    const compat = matrix.entries.find((candidate) => candidate.id === entry.compat);
    if (compat === undefined) {
      problems.push(`${label}: compat 指向不存在的条目 ${entry.compat}`);
    } else {
      if (compat.status !== 'verified-local') {
        problems.push(`${label}: compat ${compat.id} 状态为 ${compat.status}，索引只能宣称 verified-local 组合`);
      }
      if (entry.enginesDsh !== `=${compat.dsh}`) {
        problems.push(`${label}: engines.dsh 必须锁定为 "=${compat.dsh}"，实际 "${entry.enginesDsh}"`);
      }
      if (entry.version !== compat.qqbot) {
        problems.push(`${label}: 版本与 compat ${compat.id} 的 qqbot=${compat.qqbot} 不一致`);
      }
    }

    if (!Object.hasOwn(MARKET_CATEGORIES, entry.category)) {
      problems.push(`${label}: category "${entry.category}" 未在索引中声明`);
    }
    for (const labelId of entry.labels) {
      if (!Object.hasOwn(MARKET_LABELS, labelId)) problems.push(`${label}: label "${labelId}" 未在索引中声明`);
    }

    const report = evaluateClosure(`${entry.name}@${entry.version}`, entry.depsClosure);
    if (report.verdict === 'allowed' && entry.license.redistributable !== true) {
      problems.push(`${label}: 闭包全部允许，但 license.redistributable=false（结论不一致）`);
    }
    if (report.verdict !== 'allowed' && entry.license.redistributable !== false) {
      problems.push(
        `${label}: 闭包含 ${[...report.denied, ...report.needsReview].map((e) => e.name).join('/')}，` +
          'license.redistributable 必须为 false',
      );
    }

    // D09：本体的 SPDX 必须与闭包里同名包一致，否则条目在宣称一个与包事实不同的许可。
    const ownPackage = entry.depsClosure.find(
      (pkg) => pkg.name === entry.name && pkg.version === entry.version,
    );
    if (ownPackage === undefined) {
      problems.push(`${label}: 闭包里缺少插件本体，无法核对许可`);
    } else if (normalizeSpdx(ownPackage.license) !== normalizeSpdx(entry.license.spdx)) {
      problems.push(
        `${label}: license.spdx=${entry.license.spdx} 与闭包内 ${ownPackage.license} 不一致`,
      );
    }

    const acceptanceIds = new Set<string>();
    for (const item of entry.acceptance) {
      if (acceptanceIds.has(item.id)) problems.push(`${label}: 验收项 id 重复 ${item.id}`);
      acceptanceIds.add(item.id);
    }

    // D09：PRD §10.2「作者/主页/仓库：可追溯」——verified 条目必须能追到人。
    if (entry.status === 'verified' && entry.author === undefined) {
      problems.push(`${label}: verified 条目必须填写 author`);
    }
    if (entry.status === 'verified' && entry.homepage === undefined && entry.repository === undefined) {
      problems.push(`${label}: verified 条目必须有 homepage 或 repository`);
    }
  }

  return problems;
}

const MAX_ICON_BYTES = 32 * 1024;
const MAX_ICON_EDGE = 256;
const ICON_EXTENSIONS = new Map([
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
]);

function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  const signature = bytes.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function svgSize(text: string): { width: number; height: number } | undefined {
  const svgTag = /<svg[^>]*>/i.exec(text)?.[0];
  if (svgTag === undefined) return undefined;
  const width = /width="(\d+(?:\.\d+)?)"/i.exec(svgTag)?.[1];
  const height = /height="(\d+(?:\.\d+)?)"/i.exec(svgTag)?.[1];
  if (width !== undefined && height !== undefined) return { width: Number(width), height: Number(height) };
  const viewBox = /viewBox="([^"]+)"/i.exec(svgTag)?.[1];
  if (viewBox === undefined) return undefined;
  const parts = viewBox.trim().split(/[\s,]+/);
  if (parts.length !== 4) return undefined;
  return { width: Number(parts[2]), height: Number(parts[3]) };
}

/**
 * 图标检查（官方校验器只看 data URL 的 32 KiB，不看磁盘文件）：
 * 存在、扩展名受支持、解码后 ≤32 KiB、边长 ≤256、内容与扩展名相符。
 */
export async function collectIconProblems(catalogDir: string, catalog: Catalog): Promise<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of listedEntries(catalog)) {
    const relPath = iconPathFor(entry);
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const fullPath = join(catalogDir, ...relPath.split('/'));
    let bytes: Buffer;
    try {
      bytes = await readFile(fullPath);
    } catch {
      problems.push(`${relPath}: 图标文件不存在`);
      continue;
    }

    const extension = relPath.split('.').pop()?.toLowerCase() ?? '';
    if (!ICON_EXTENSIONS.has(extension)) {
      problems.push(`${relPath}: 仅支持 ${[...ICON_EXTENSIONS.keys()].join('/')}`);
      continue;
    }
    if (bytes.length > MAX_ICON_BYTES) {
      problems.push(`${relPath}: ${bytes.length} B 超过 ${MAX_ICON_BYTES} B 上限`);
      continue;
    }
    if (extension === 'svg') {
      const text = bytes.toString('utf8');
      if (!/<svg[\s>]/i.test(text)) problems.push(`${relPath}: 内容不是 SVG`);
      const size = svgSize(text);
      if (size === undefined) problems.push(`${relPath}: 无法解析 SVG 尺寸（需要 width/height 或 viewBox）`);
      else if (size.width > MAX_ICON_EDGE || size.height > MAX_ICON_EDGE) {
        problems.push(`${relPath}: ${size.width}×${size.height} 超过 ${MAX_ICON_EDGE}×${MAX_ICON_EDGE}`);
      }
    } else if (extension === 'png') {
      const size = pngSize(bytes);
      if (size === undefined) problems.push(`${relPath}: 内容不是 PNG`);
      else if (size.width > MAX_ICON_EDGE || size.height > MAX_ICON_EDGE) {
        problems.push(`${relPath}: ${size.width}×${size.height} 超过 ${MAX_ICON_EDGE}×${MAX_ICON_EDGE}`);
      }
    }
  }

  return problems;
}

/** 单个版本的 registry 事实（`npm view <pkg> time` + `npm view <pkg>@<ver> dist.integrity`）。 */
export interface RegistryVersionFacts {
  /** registry 中是否存在该版本（`time[version]` 是否为合法时间戳）。 */
  versionExists: boolean;
  /** `time[version]` 换算成的 Unix 秒；无法解析时缺省。 */
  publishTimestamp?: number;
  /** `dist.integrity`（SRI）。 */
  integrity?: string;
}

/** publishTimestamp 与 dist.integrity 必须与 registry 一致，否则索引在宣称一个我们没核对过的包。 */
export function collectRegistryProblems(
  catalog: Catalog,
  facts: ReadonlyMap<string, RegistryVersionFacts>,
): string[] {
  const problems: string[] = [];

  for (const entry of listedEntries(catalog)) {
    const label = `${entry.name}@${entry.version}`;
    const fact = facts.get(label);
    if (fact === undefined) {
      problems.push(`${label}: 未能读取 registry 元数据`);
      continue;
    }
    if (!fact.versionExists) {
      problems.push(`${label}: registry 中不存在该版本`);
      continue;
    }
    if (fact.publishTimestamp === undefined) {
      problems.push(`${label}: registry 时间戳无法解析`);
    } else if (fact.publishTimestamp !== entry.publishTimestamp) {
      problems.push(`${label}: publishTimestamp ${entry.publishTimestamp} ≠ registry ${fact.publishTimestamp}`);
    }
    if (fact.integrity === undefined || fact.integrity === '') {
      problems.push(`${label}: registry 缺少 dist.integrity`);
    } else if (fact.integrity !== entry.integrity) {
      problems.push(`${label}: integrity 与 registry 不一致`);
    }
  }

  return problems;
}

export interface ParsedIndexVersion {
  version: string;
  publishTimestamp: number;
  source: unknown;
  engines: { dsh?: string };
}

export interface ParsedIndexPlugin {
  name: string;
  icon?: string;
  versions: readonly ParsedIndexVersion[];
}

export interface ParsedIndex {
  format: number;
  plugins: readonly ParsedIndexPlugin[];
}

/**
 * 生成物自检：把 `parseMarketIndex` 的返回值与 catalog 逐字段比对。
 * 目的不是重复校验，而是防止「生成了但没校验」——例如把 overlay 字段写进了 index.json。
 */
export function collectIndexProblems(
  catalog: Catalog,
  index: MarketIndexDocument,
  parsed: ParsedIndex,
  baseUrl = MARKET_INDEX_BASE_URL,
): string[] {
  const problems: string[] = [];

  if (index.format !== 1) problems.push(`index.format 必须为 1，实际 ${String(index.format)}`);

  for (const plugin of index.plugins) {
    for (const key of OVERLAY_ONLY_KEYS) {
      if (Object.hasOwn(plugin as unknown as Record<string, unknown>, key)) {
        problems.push(`${plugin.name}: index.json 里出现 overlay 字段 "${key}"（会被官方校验器静默丢弃）`);
      }
    }
    for (const version of plugin.versions) {
      for (const key of OVERLAY_ONLY_KEYS) {
        if (Object.hasOwn(version as unknown as Record<string, unknown>, key)) {
          problems.push(`${plugin.name}@${version.version}: index.json 里出现 overlay 字段 "${key}"`);
        }
      }
    }
  }

  const listed = listedEntries(catalog);
  const expectedNames = new Set(listed.map((entry) => entry.name));
  const actualNames = new Set(parsed.plugins.map((plugin) => plugin.name));
  for (const name of expectedNames) {
    if (!actualNames.has(name)) problems.push(`${name}: 索引里缺少该插件`);
  }
  for (const name of actualNames) {
    if (!expectedNames.has(name)) problems.push(`${name}: 索引里出现 catalog 之外或 blocked 的插件`);
  }

  for (const entry of listed) {
    const label = `${entry.name}@${entry.version}`;
    const plugin = parsed.plugins.find((candidate) => candidate.name === entry.name);
    if (plugin === undefined) continue;

    const expectedIcon = new URL(iconPathFor(entry), baseUrl).href;
    if (plugin.icon !== expectedIcon) {
      problems.push(`${label}: 图标解析为 ${plugin.icon ?? '(none)'}，期望 ${expectedIcon}`);
    }

    const version = plugin.versions.find((candidate) => candidate.version === entry.version);
    if (version === undefined) {
      problems.push(`${label}: 索引里缺少该版本`);
      continue;
    }
    if (version.publishTimestamp !== entry.publishTimestamp) {
      problems.push(`${label}: publishTimestamp 在索引里被改写`);
    }
    if (JSON.stringify(version.source) !== JSON.stringify(entry.source)) {
      problems.push(`${label}: source 在索引里被改写`);
    }
    if (version.engines.dsh !== entry.enginesDsh) {
      problems.push(`${label}: engines.dsh 在索引里被改写`);
    }
  }

  return problems;
}

/** 产物文件自身是否齐全（供 validate 脚本使用，不依赖 catalog 时用）。 */
export async function assertArtifactsExist(outDir: string, index: MarketIndexDocument): Promise<string[]> {
  const problems: string[] = [];
  for (const plugin of index.plugins) {
    const relPath = plugin.icon;
    if (relPath.startsWith('data:')) continue;
    const relative = relPath.replace(/^\.\//, '');
    try {
      await stat(join(outDir, ...relative.split('/')));
    } catch {
      problems.push(`${plugin.name}: 图标文件缺失 ${relative}`);
    }
  }
  return problems;
}
