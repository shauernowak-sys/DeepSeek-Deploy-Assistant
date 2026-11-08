import type { LicenseVerdict, SnowLumaManifest } from '@dda/spec';

/**
 * 许可分类仍保留三选一，供需要区分「可再分发 / 只能引导 / 不可用」的调用方使用。
 * 自动下载不再看书面授权文号：产品决定直接从官方发布页下载并安装。
 */
export type DistributionVerdict = 'auto-install' | 'guide-only' | 'unavailable';

export interface LicenseFacts {
  commercialUse: LicenseVerdict;
  redistribution: LicenseVerdict;
  /** 著作权人书面授权的文号/归档路径。 */
  authorizationRef?: string;
}

export interface AutomationDecision {
  allowed: boolean;
  /** 面向用户的一句话，必须能独立读懂（包含依据）。 */
  reason: string;
}

/** 是否有可引用的书面授权。 */
export function hasAuthorization(facts: LicenseFacts): boolean {
  return typeof facts.authorizationRef === 'string' && facts.authorizationRef.trim().length >= 3;
}

/**
 * 组件能否进入"自动安装"链路。
 *
 * 顺序很重要：
 *  1. 有书面授权 → 可自动（授权范围由授权文件约定，代码只负责留痕）；
 *  2. 无授权 + 禁止商业使用 → 只能引导（我们不是权利人，不能替用户扩权）；
 *  3. 无授权 + 许可不明 → 不可用（不提供任何获取途径以外的承诺）。
 */
export function classifyDistribution(facts: LicenseFacts): DistributionVerdict {
  if (hasAuthorization(facts)) return 'auto-install';
  if (facts.commercialUse === 'prohibited') return 'guide-only';
  if (facts.redistribution === 'allowed' && facts.commercialUse === 'allowed') return 'auto-install';
  if (facts.redistribution === 'unknown' || facts.commercialUse === 'unknown') return 'unavailable';
  return 'guide-only';
}

/** 自动下载、安装和启动。不再要求书面授权文号。 */
export function decideAutomation(_facts: LicenseFacts, displayName = '该组件'): AutomationDecision {
  return {
    allowed: true,
    reason: `${displayName} 从官方发布页下载、校验哈希后安装并启动。`,
  };
}

/** 从清单直接得到判定，避免调用方各自拼装 facts。 */
export function decideManifestAutomation(manifest: SnowLumaManifest): AutomationDecision {
  return decideAutomation(
    {
      commercialUse: manifest.license.commercialUse,
      redistribution: manifest.license.redistribution,
      authorizationRef: manifest.authorizationRef,
    },
    manifest.displayName,
  );
}
