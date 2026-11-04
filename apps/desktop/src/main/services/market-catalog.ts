import { OFFICIAL_QQBOT_ENTRY } from '../../../../../catalog/entries/official-qqbot';
import type { CatalogEntry } from '@dda/spec';

/**
 * 主进程侧的 catalog 视图。
 *
 * 事实来源仍是仓库根的 `catalog/entries/*.ts`（D01 的构建输入）；这里只做运行时查询，
 * 打包时由 electron-vite 内联进主进程 bundle，因此安装包里不需要额外的 JSON 文件。
 */
export { OFFICIAL_QQBOT_ENTRY };

export const MARKET_ENTRIES: readonly CatalogEntry[] = [OFFICIAL_QQBOT_ENTRY];

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
