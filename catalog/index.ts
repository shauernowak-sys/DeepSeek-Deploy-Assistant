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
 * 候选里既有做过闭包/安装探测的 npm 包，也有 2026-11-05 生态调研新增的 GitHub 项目；
 * 后者以 `market.kind` 区分插件、桥接程序、工具与参考资料，且必须显式标注未审计。
 */
export const CATALOG: Catalog = CatalogSchema.parse({
  schemaVersion: 1,
  entries: [OFFICIAL_QQBOT_ENTRY],
});

export { CATALOG_CANDIDATES, OFFICIAL_QQBOT_ENTRY };
