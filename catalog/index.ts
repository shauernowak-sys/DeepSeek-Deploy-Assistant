import { CatalogSchema } from '@dda/spec';
import type { Catalog } from '@dda/spec';

import { OFFICIAL_QQBOT_ENTRY } from './entries/official-qqbot';

/**
 * catalog 的唯一事实来源。条目只在这里登记；`scripts/build-index.ts` 负责把它编译成
 * 官方 `index.json` + 我方 `catalog.overlay.json`，并在构建期做 zod + 官方校验器双重校验。
 */
export const CATALOG: Catalog = CatalogSchema.parse({
  schemaVersion: 1,
  entries: [OFFICIAL_QQBOT_ENTRY],
});

export { OFFICIAL_QQBOT_ENTRY };
