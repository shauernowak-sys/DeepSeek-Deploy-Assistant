import { CompatMatrixSchema, DdaError, ERROR_CODES } from '@dda/spec';
import type { CompatEntry, CompatMatrix } from '@dda/spec';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseVersion(input: string): SemVer {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim());
  if (!match) throw new DdaError(ERROR_CODES.E_VERSION_UNSUPPORTED, `无法解析版本号: ${input}`, '使用清单中的精确版本');
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** SemVer precedence, including prerelease rules (a prerelease sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const len = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export function satisfiesMin(actual: string, min: string): boolean {
  return compareVersions(actual, min) >= 0;
}

export function loadMatrix(raw: unknown): CompatMatrix {
  const parsed = CompatMatrixSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DdaError(
      ERROR_CODES.E_MANIFEST_INVALID,
      `兼容矩阵校验失败: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      '重新安装应用，不要手工编辑清单',
    );
  }
  return parsed.data;
}

/**
 * Only `verified-local` entries may be installed. Upstream claims alone are never enough
 * (M0 proved an upstream "compatible" claim that did not boot).
 */
export function assertCombination(
  matrix: CompatMatrix,
  target: { dsh: string; qqbot: string; node: string },
): CompatEntry {
  const entry = matrix.entries.find((e) => e.dsh === target.dsh && e.qqbot === target.qqbot);
  if (!entry) {
    throw new DdaError(
      ERROR_CODES.E_VERSION_UNSUPPORTED,
      `组合未列入白名单: dsh=${target.dsh}, qqbot=${target.qqbot}`,
      '只能使用清单中经过本机验证的组合',
    );
  }
  if (entry.status !== 'verified-local') {
    throw new DdaError(
      ERROR_CODES.E_VERSION_UNSUPPORTED,
      `组合状态为 ${entry.status}，不允许安装: ${entry.id}`,
      entry.note ?? '等待兼容性验证',
    );
  }
  if (!satisfiesMin(target.node, entry.node.replace(/^>=\s*/, ''))) {
    throw new DdaError(
      ERROR_CODES.E_VERSION_UNSUPPORTED,
      `Node ${target.node} 不满足组合 ${entry.id} 的要求 ${entry.node}`,
      '使用清单锁定的 Node 版本',
    );
  }
  return entry;
}
