import { z } from 'zod';

/**
 * SnowLuma 组件清单（M3.2 个人 QQ 路线，PRD R4）。
 *
 * 这里的每一条都是上游一手事实（见 docs/M3.2-SnowLuma专项技术调查报告.md）：
 *  - 版本/哈希/大小来自官方 Releases 的实际产物；
 *  - 许可结论来自 LICENSE + EULA 原文；
 *  - `authorizationRef` 是"书面授权"的唯一代码级开关：为空时禁止任何自动化部署（fail-closed）。
 */

export const SNOWLUMA_COMPONENT_ID = 'snowluma';

const httpUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, '必须是 http(s) 地址');

const sha256 = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/i, 'SHA-256 只能是十六进制');

/** 许可证结论：判定口径与 PRD §12.1 一致，不给"部分可用"。 */
export const LICENSE_VERDICTS = ['allowed', 'conditional', 'prohibited', 'unknown'] as const;
export type LicenseVerdict = (typeof LICENSE_VERDICTS)[number];

export const SnowLumaAssetSchema = z
  .object({
    platform: z.literal('win32-x64'),
    fileName: z.string().min(1).max(200),
    url: httpUrl,
    sizeBytes: z.number().int().positive(),
    sha256,
  })
  .strict();

export const SnowLumaManifestSchema = z
  .object({
    id: z.literal(SNOWLUMA_COMPONENT_ID),
    displayName: z.string().min(1).max(80),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, '必须是不带前缀的精确版本，例如 2.4.0'),
    projectUrl: httpUrl,
    releasesUrl: httpUrl,
    license: z
      .object({
        name: z.string().min(1),
        spdx: z.string().min(1),
        commercialUse: z.enum(LICENSE_VERDICTS),
        redistribution: z.enum(LICENSE_VERDICTS),
        /** 许可与 EULA 原文地址（UI 必须给出可点击入口）。 */
        textUrl: httpUrl,
        eulaUrl: httpUrl,
        /** 需要用户本人接受协议；本软件不得代按。 */
        requiresUserConsent: z.boolean(),
        /** 上游明确要求书面授权的动作，用于 UI 披露与闸门判定。 */
        restrictedActions: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    /** 著作权人书面授权的文号/归档路径。为空 = 未授权 = 只允许引导安装。 */
    authorizationRef: z.string().min(3).max(200).optional(),
    /** 只允许在授权文号存在时启用自动化（fail-closed）。 */
    automationPolicy: z.literal('authorized-only'),
    assets: z.array(SnowLumaAssetSchema).min(1),
    ports: z
      .object({
        webui: z.number().int().min(1).max(65535),
        onebotHttp: z.number().int().min(1).max(65535),
        onebotWs: z.number().int().min(1).max(65535),
      })
      .strict(),
    /** 运行前置条件：QQNT 必须已安装（SnowLuma 注入的是运行中的 QQ.exe）。 */
    requires: z.array(z.enum(['qqnt'])).min(1),
    /** 上游配置/数据在安装目录下的相对位置（只读检测用）。 */
    layout: z
      .object({
        configDir: z.string().min(1),
        releaseFile: z.string().min(1),
        entry: z.string().min(1),
        launcher: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type SnowLumaManifest = z.infer<typeof SnowLumaManifestSchema>;
export type SnowLumaAsset = z.infer<typeof SnowLumaAssetSchema>;

/** 我们自己的安装记录（写入我们自己的 components 目录，不含任何凭据）。 */
export const SnowLumaInstallRecordSchema = z
  .object({
    id: z.literal(SNOWLUMA_COMPONENT_ID),
    version: z.string().min(1),
    sha256,
    sizeBytes: z.number().int().positive(),
    sourceUrl: httpUrl,
    installDir: z.string().min(1),
    installedAt: z.string().min(1),
  })
  .strict();

export type SnowLumaInstallRecord = z.infer<typeof SnowLumaInstallRecordSchema>;

/** 从清单里挑出当前平台的资产（Windows x64 是本产品唯一目标）。 */
export function selectAsset(manifest: SnowLumaManifest): SnowLumaAsset {
  const asset = manifest.assets.find((item) => item.platform === 'win32-x64');
  if (!asset) throw new Error('清单里没有 win32-x64 资产');
  return asset;
}
