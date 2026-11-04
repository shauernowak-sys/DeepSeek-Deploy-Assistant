import { DISTRIBUTION_MODE_LABELS, DdaError, ERROR_CODES } from '@dda/spec';
import type { DistributionMode, DistributionPolicy } from '@dda/spec';

export function isDistributionAllowed(policy: DistributionPolicy, mode: DistributionMode): boolean {
  return policy.allowed.includes(mode);
}

/**
 * 阻断原因必须点名"是谁导致的"：只写"许可不允许"用户无法判断是自己选错了，还是产品缺能力。
 */
export function describeDistributionBlocker(policy: DistributionPolicy, mode: DistributionMode): string {
  const blocker = policy.blocked.find((entry) => entry.mode === mode);
  if (!blocker) return `${policy.name}@${policy.version} 未把「${DISTRIBUTION_MODE_LABELS[mode]}」列入允许清单`;
  return `${blocker.package}@${blocker.version} 的许可为 ${blocker.license}：${blocker.reason}`;
}

/**
 * 分发前的硬门禁。在线安装不受影响；离线包/镜像/重打包在许可不允许时一律抛错，
 * 因此"先拦后装"，不会出现"装完了才发现不该分发"。
 */
export function assertDistributionAllowed(policy: DistributionPolicy, mode: DistributionMode): void {
  if (isDistributionAllowed(policy, mode)) return;
  throw new DdaError(
    ERROR_CODES.E_DISTRIBUTION_BLOCKED,
    `${policy.name}@${policy.version} 不能使用「${DISTRIBUTION_MODE_LABELS[mode]}」：${describeDistributionBlocker(policy, mode)}`,
    '改为在线安装：本软件只代为调用官方安装命令，不复制、不镜像其字节',
  );
}
