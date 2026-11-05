import { CatalogSchema } from '@dda/spec';
import type { Catalog } from '@dda/spec';

import { CATALOG_CANDIDATES } from './candidates';
import { OFFICIAL_QQBOT_ENTRY } from './entries/official-qqbot';

/**
 * catalog 的唯一事实来源。条目只在这里登记；`scripts/build-index.ts` 负责把它编译成
 * 官方 `index.json` + 我方 `catalog.overlay.json`，并在构建期做 zod + 官方校验器双重校验。
 *
 * `CATALOG.entries` 只放**可安装**条目（进 index.json）；
 * `CATALOG_CANDIDATES` 是评估过但不可安装的候选（只进 overlay，见 D09 完整策展）。
 */
export const CATALOG: Catalog = CatalogSchema.parse({
  schemaVersion: 1,
  entries: [OFFICIAL_QQBOT_ENTRY],
});

export { CATALOG_CANDIDATES, OFFICIAL_QQBOT_ENTRY };
