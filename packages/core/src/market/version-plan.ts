import { DdaError, ERROR_CODES } from '@dda/spec';
import type { CompatMatrix } from '@dda/spec';

import { assertCombination, compareVersions, satisfiesMin } from '../compat/matrix';

/**
 * D07：版本比对与目标版本切换。
 *
 * 宿主限制（前置验证 §3 / 架构决策 §4.2）：锁定的 `dsh 0.2.0-rc.2` 没有 in-place upgrade，
 * 因此"升级/降级"一律是 **remove + add**，且必须先备份 profile（D08）。
 * 同版本二次安装直接短路，不发起任何 pnpm 调用。
 */

export type PluginChangeAction = 'none' | 'install' | 'upgrade' | 'downgrade';

export interface PluginChangePlan {
  action: PluginChangeAction;
  installedVersion?: string;
  targetVersion: string;
  /** 需要用户二次确认（当前只有降级）。 */
  requiresConfirmation: boolean;
  /** `add` = 直接安装；`remove-then-add` = 版本切换。 */
  method: 'add' | 'remove-then-add';
  /** 命中的兼容组合 id（仅 install/upgrade 有）。 */
  comboId?: string;
  warnings: string[];
}

export interface PlanPluginChangeInput {
  name: string;
  installedVersion?: string;
  target: { name: string; version: string };
  matrix: CompatMatrix;
  dshVersion: string;
  /** 已部署的 Node 版本；拿不到时只校验 dsh×qqbot。 */
  nodeVersion?: string;
  /** 用户是否已在界面上确认降级（两次确认的第二道）。 */
  allowDowngrade?: boolean;
  /**
   * 是否在这里做「兼容组合」断言。安装编排传 `false`：兼容门禁由第 1 步统一执行，
   * 这样错误消息始终带步号（`第 1 步（compat）失败：…`），不会出现两处口径。
   */
  assertCombo?: boolean;
}

const REPLACE_WARNINGS = [
  '版本切换会先卸载再安装（锁定宿主不支持原地升级），profile 依赖会被重建',
  '切换前会自动备份 profile；失败时可用备份恢复',
];

export function planPluginChange(input: PlanPluginChangeInput): PluginChangePlan {
  const { installedVersion, target } = input;
  const assertCombo = input.assertCombo !== false;

  const comboFor = (version: string): { id: string } =>
    assertCombination(input.matrix, {
      dsh: input.dshVersion,
      qqbot: version,
      ...(input.nodeVersion === undefined ? {} : { node: input.nodeVersion }),
    });

  if (target.name !== input.name) {
    throw new DdaError(
      ERROR_CODES.E_VERSION_UNSUPPORTED,
      `目标插件 ${target.name} 与当前安装的 ${input.name} 不是同一个包`,
      '同一 profile 内一次只切换一个插件',
    );
  }

  if (installedVersion === undefined) {
    const combo = assertCombo ? comboFor(target.version) : undefined;
    return {
      action: 'install',
      targetVersion: target.version,
      requiresConfirmation: false,
      method: 'add',
      ...(combo === undefined ? {} : { comboId: combo.id }),
      warnings: [],
    };
  }

  const ordering = compareVersions(target.version, installedVersion);
  if (ordering === 0) {
    return {
      action: 'none',
      installedVersion,
      targetVersion: target.version,
      requiresConfirmation: false,
      method: 'add',
      warnings: [],
    };
  }

  if (ordering > 0) {
    // 升级只允许在 verified-local 组合内进行；assertCombination 会在非白名单时抛错。
    const combo = assertCombo ? comboFor(target.version) : undefined;
    return {
      action: 'upgrade',
      installedVersion,
      targetVersion: target.version,
      requiresConfirmation: false,
      method: 'remove-then-add',
      ...(combo === undefined ? {} : { comboId: combo.id }),
      warnings: REPLACE_WARNINGS,
    };
  }

  // 降级：必须显式确认（界面两次确认的第二道由调用方传 allowDowngrade）。
  if (input.allowDowngrade !== true) {
    throw new DdaError(
      ERROR_CODES.E_DECISION_UNCONFIRMED,
      `降级需要二次确认：当前 ${installedVersion} → 目标 ${target.version}`,
      '确认后再执行；降级后新版本写入的配置可能不再被识别',
    );
  }
  const combo = assertCombo ? comboFor(target.version) : undefined;
  return {
    action: 'downgrade',
    installedVersion,
    targetVersion: target.version,
    requiresConfirmation: true,
    method: 'remove-then-add',
    ...(combo === undefined ? {} : { comboId: combo.id }),
    warnings: [...REPLACE_WARNINGS, `降级：${installedVersion} → ${target.version}`],
  };
}

/** 兼容矩阵里是否声明了该版本（列表展示用，不做安装判定）。 */
export function declaredQqbotVersions(matrix: CompatMatrix): string[] {
  return [...new Set(matrix.entries.map((entry) => entry.qqbot))].sort((a, b) => compareVersions(b, a));
}

/** Node 版本是否满足矩阵条目的要求（与 assertCombination 同一判定）。 */
export function nodeSatisfies(matrix: CompatMatrix, nodeVersion: string): boolean {
  const minimum = matrix.entries
    .map((entry) => entry.node.replace(/^>=\s*/, ''))
    .sort((a, b) => compareVersions(a, b))[0];
  return minimum === undefined ? true : satisfiesMin(nodeVersion, minimum);
}
