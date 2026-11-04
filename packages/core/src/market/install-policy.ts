import { DdaError, ERROR_CODES } from '@dda/spec';
import type { CompatMatrix } from '@dda/spec';

import { assertCombination } from '../compat/matrix';

/**
 * P-10：所有插件安装入口共用同一道门禁（Gate 4 ⑤）。
 *
 * 现状问题：`harness-service.installQqPlugin()` 与 `installPlugin(spec)` 直接调 pnpm，
 * 不经过 `assertCombination`，于是"非白名单版本组合无法通过任何入口安装"不成立。
 *
 * 本模块只接受**精确 `name@version`**：
 * - 官方插件 → 必须在 catalog 允许清单内，且命中 `compat.json` 的 `verified-local` 组合；
 * - 适配插件（个人 QQ 的 dsh-qq-link）→ 必须在显式适配白名单内（它不属于 compat 矩阵的 qqbot 三元组）；
 * - 其它一律拒绝，包括 `latest`、范围、git 地址与本地路径。
 */

const EXACT_SPEC =
  /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

export function parseExactPluginSpec(spec: string): { name: string; version: string } {
  const match = EXACT_SPEC.exec(spec.trim());
  if (match === null) {
    throw new DdaError(
      ERROR_CODES.E_VERSION_UNSUPPORTED,
      `插件安装只接受精确的 name@version，收到：${spec}`,
      '使用清单中的精确版本；不接受 latest、版本范围、git 地址或本地路径',
    );
  }
  return { name: match[1]!, version: match[2]! };
}

export interface PluginInstallGateInput {
  matrix: CompatMatrix;
  spec: string;
  /** 当前要装进去的宿主版本（锁定的 BASELINE.dsh.version）。 */
  dshVersion: string;
  /** catalog 允许的官方插件精确 spec，例如 `@tencent-connect/dsh-qqbot@0.5.5`。 */
  catalogSpecs: readonly string[];
  /** 允许代装的适配插件精确 spec（个人 QQ 路线），可不填。 */
  adapterSpecs?: readonly string[];
}

export function assertPluginInstallAllowed(input: PluginInstallGateInput): { name: string; version: string } {
  const target = parseExactPluginSpec(input.spec);

  const fromCatalog = input.catalogSpecs.includes(input.spec);
  const fromAdapter = (input.adapterSpecs ?? []).includes(input.spec);
  if (!fromCatalog && !fromAdapter) {
    throw new DdaError(
      ERROR_CODES.E_VERSION_UNSUPPORTED,
      `插件 ${input.spec} 不在允许清单内`,
      `只允许安装：${[...input.catalogSpecs, ...(input.adapterSpecs ?? [])].join('、')}`,
    );
  }

  // 官方插件必须命中已验证组合；适配插件不在这张矩阵里，只受白名单约束。
  if (fromCatalog) {
    assertCombination(input.matrix, { dsh: input.dshVersion, qqbot: target.version });
  }
  return target;
}
