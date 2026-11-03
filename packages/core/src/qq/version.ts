import type { PluginState } from '@dda/spec';

import { compareVersions } from '../compat/matrix';
import { QQ_PLUGIN_NAME } from './patch';

/** 版本判定（插件声明的兼容性是精确版本列表，不接受 latest）。 */
export interface QqVersionCheck {
  state: 'ok' | 'missing' | 'mismatch';
  found?: string;
  expected: string;
  message: string;
}

export function findQqPlugin(plugins: PluginState[]): PluginState | undefined {
  return plugins.find((plugin) => plugin.name === QQ_PLUGIN_NAME);
}

export function checkQqVersion(found: string | undefined, expected: string): QqVersionCheck {
  if (!found) {
    return { state: 'missing', expected, message: `未安装 ${QQ_PLUGIN_NAME}` };
  }
  const same = found.trim() === expected.trim();
  return same
    ? { state: 'ok', found, expected, message: `版本 ${found} 与验证基线一致` }
    : { state: 'mismatch', found, expected, message: `当前 ${found}，本版本只验证过 ${expected}` };
}

/** 供 UI 排序/比较用（保持与 Harness 兼容矩阵同一套 SemVer 语义）。 */
export { compareVersions };
