import type { CatalogEntry } from '@dda/spec';
import { CatalogOverlaySchema } from '@dda/spec';
import { buildMarketIndex, buildOverlay, MARKET_CATEGORIES, MARKET_INDEX_BASE_URL } from '@dda/core';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CATALOG_CANDIDATES } from '../../../../../catalog/candidates';
import { CATALOG } from '../../../../../catalog';
import { OFFICIAL_QQBOT_ENTRY } from '../../../../../catalog/entries/official-qqbot';

/**
 * 主进程侧的 catalog 视图。
 *
 * 事实来源仍是仓库根的 `catalog/entries/*.ts`（D01 的构建输入）；这里只做运行时查询，
 * 打包时由 electron-vite 内联进主进程 bundle，因此安装包里不需要额外的 JSON 文件。
 */
export { CATALOG_CANDIDATES, OFFICIAL_QQBOT_ENTRY };

export const MARKET_ENTRIES: readonly CatalogEntry[] = [OFFICIAL_QQBOT_ENTRY];

/** 先完整校验随包的两份清单，再返回同源策展数据；任一失败都不能变成空列表。 */
export async function loadMarketCatalog(directory: string) {
  const [indexText, overlayText] = await Promise.all([
    readFile(join(directory, 'index.json'), 'utf8'),
    readFile(join(directory, 'catalog.overlay.json'), 'utf8'),
  ]);
  const index: unknown = JSON.parse(indexText);
  parseMarketIndex(index, MARKET_INDEX_BASE_URL);
  const overlay = CatalogOverlaySchema.parse(JSON.parse(overlayText));
  if (JSON.stringify(index) !== JSON.stringify(buildMarketIndex(CATALOG)) ||
      JSON.stringify(overlay) !== JSON.stringify(buildOverlay(CATALOG, overlay.generatedFrom, CATALOG_CANDIDATES))) {
    throw new Error('资源清单不一致或已过期');
  }
  return { entries: CATALOG.entries, candidates: CATALOG_CANDIDATES, categories: MARKET_CATEGORIES };
}

/** 当前安装服务只支持经过策展的官方 QQ 插件。 */
export function findInstallableMarketEntry(entries: readonly CatalogEntry[], id: string): CatalogEntry | undefined {
  return entries.find((entry) => entry.id === id && entry.status === 'verified' && entry.name === '@tencent-connect/dsh-qqbot');
}

export function findMarketEntry(name: string, version?: string): CatalogEntry | undefined {
  return MARKET_ENTRIES.find(
    (entry) => entry.name === name && (version === undefined || entry.version === version),
  );
}

/** 只接受精确 `name@version`；格式非法返回 undefined（门禁已在更早一步拒绝）。 */
export function findMarketEntryBySpec(spec: string): CatalogEntry | undefined {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return undefined;
  return findMarketEntry(spec.slice(0, at), spec.slice(at + 1));
}
