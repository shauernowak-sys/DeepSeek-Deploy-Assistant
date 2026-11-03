import type { LicenseVerdict, SnowLumaManifest } from '@dda/spec';

/**
 * 许可判定（PRD §12.1 的三选一，不给"部分可用"）。
 *
 * 这一层是**授权闸门**：SnowLuma 的 EULA §5.4 把"通过自动化脚本部署"列为需事先书面授权事项，
 * 因此 `authorizationRef` 为空的清单**永远**只能走"引导安装"——即使许可本身允许再分发。
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

/** 自动化部署是否放行（fail-closed：拿不到授权就只允许引导）。 */
export function decideAutomation(facts: LicenseFacts, displayName = '该组件'): AutomationDecision {
  if (hasAuthorization(facts)) {
    return {
      allowed: true,
      reason: `已登记著作权人书面授权（${facts.authorizationRef}），允许自动安装与启动。`,
    };
  }
  if (facts.commercialUse === 'prohibited') {
    return {
      allowed: false,
      reason: `${displayName} 的许可禁止商业使用，且其 EULA 要求"通过自动化脚本部署"须事先取得书面授权；本软件在你确认授权前只提供官方入口与装后检测。`,
    };
  }
  return {
    allowed: false,
    reason: `${displayName} 未登记书面授权，按合规要求只提供官方入口与装后检测。`,
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
