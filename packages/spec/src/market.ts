import { z } from 'zod';

import { DepsClosureEntrySchema } from './licensing';

/**
 * 插件资源中心的两层数据（docs/M4-技术架构决策.md §2.1）：
 * - `index.json`：官方 format 1，**由官方校验器负责**，我方不得重复实现；
 * - overlay（`catalog.overlay.json`）：官方格式无承载位的字段（许可/哈希/闭包/验收/风险），只由我方消费。
 *
 * 把 overlay 字段塞进 `index.json` 会被官方校验器**静默丢弃**（M4 前置验证 §1.3 用例 D 实测），
 * 因此两者必须分开产出、分开校验。
 */

const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `verified` 是唯一允许展示安装按钮的状态（PRD §10.1）。 */
export const CATALOG_STATUSES = ['verified', 'needs-review', 'blocked'] as const;

export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export const CatalogLicenseSchema = z
  .object({
    spdx: z.string().min(1),
    /**
     * 整条目（含依赖闭包）能否由我方分发。`true` 只表示闭包 100% 在允许列表内；
     * 只要有一个 `UNLICENSED` 依赖就必须为 `false`（LIC-2）。
     */
    redistributable: z.boolean(),
    needsReview: z.boolean().optional(),
  })
  .strict();

export const CatalogSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('npm'), registry: z.string().url().optional() }).strict(),
  z
    .object({
      type: z.literal('git'),
      url: z.string().url(),
      commit: z.string().regex(/^[0-9a-f]{40}$/, 'must be a lowercase 40-hex commit SHA'),
      path: z.string().min(1).optional(),
    })
    .strict(),
]);

/** 许可判定的**输入事实**（包名/版本/许可原文）。裁决由 D11 计算，不在此处手写。 */
export const CatalogClosurePackageSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string().min(1),
    /** 许可值的来源，便于复核：`package.json` / LICENSE 文件名。 */
    source: z.string().min(1).optional(),
  })
  .strict();

export type CatalogClosurePackage = z.infer<typeof CatalogClosurePackageSchema>;

export const CatalogZhSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1),
    description: z.string().min(1),
    usage: z.string().min(1),
    risk: z.string().min(1),
  })
  .strict();

/** 官方的 `title`/`description` 必须含 `en`，所以英文不能拿中文顶替（那只是把校验骗过去）。 */
export const CatalogEnSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

export const CatalogSafetySchema = z
  .object({
    /** 加载/运行时的外联行为，例如「启动即向 q.qq.com 发起绑定请求」。 */
    network: z.array(z.string().min(1)),
    permissions: z.array(z.string().min(1)),
    requiresRestart: z.boolean(),
  })
  .strict();

export const CatalogEntrySchema = z
  .object({
    /** 稳定标识，不用包名（包名可能变）。 */
    id: z.string().regex(/^plg-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must look like plg-<slug>'),
    name: z.string().min(1),
    version: z.string().regex(EXACT_SEMVER, 'must be an exact SemVer version'),
    /** 与 registry `time[version]` 一致（Unix 秒），构建期比对。 */
    publishTimestamp: z.number().int().nonnegative(),
    source: CatalogSourceSchema,
    /**
     * 必须写成锁定形式 `=<compat.dsh>`：索引只宣称本机验证过的组合，
     * 不允许用宽范围把未验证的宿主版本也「看起来能用」。
     */
    enginesDsh: z.string().min(1),
    /** 指向 compat.json 的条目 id，且该条目必须是 `verified-local`。 */
    compat: z.string().min(1),
    license: CatalogLicenseSchema,
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/, 'must be a sha512 SRI string'),
    depsClosure: z.array(CatalogClosurePackageSchema).min(1),
    /** 可执行的验收方式（PRD 5.3），至少一条。 */
    acceptance: z.array(z.string().min(1)).min(1),
    en: CatalogEnSchema,
    zh: CatalogZhSchema,
    category: z.string().min(1),
    labels: z.array(z.string().min(1)).default([]),
    keywords: z.array(z.string().min(1)).default([]),
    safety: CatalogSafetySchema,
    installNotes: z.array(z.string().min(1)).default([]),
    status: z.enum(CATALOG_STATUSES),
    repository: z
      .object({ url: z.string().url(), directory: z.string().min(1).optional() })
      .strict()
      .optional(),
    homepage: z.string().url().optional(),
    author: z.string().min(1).optional(),
  })
  .strict();

export const CatalogSchema = z
  .object({ schemaVersion: z.literal(1), entries: z.array(CatalogEntrySchema).min(1) })
  .strict();

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/** overlay 条目 = catalog 条目里官方格式装不下的部分 + D11 计算出的许可裁决。 */
export const CatalogOverlayEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    compat: z.string().min(1),
    license: CatalogLicenseSchema,
    integrity: z.string().min(1),
    depsClosure: z.array(DepsClosureEntrySchema).min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    zh: CatalogZhSchema,
    category: z.string().min(1),
    labels: z.array(z.string()),
    keywords: z.array(z.string()),
    safety: CatalogSafetySchema,
    installNotes: z.array(z.string()),
    status: z.enum(CATALOG_STATUSES),
  })
  .strict();

export const CatalogOverlaySchema = z
  .object({
    schemaVersion: z.literal(1),
    /** 生成它的 catalog 版本；用于判断 overlay 是否与索引同批产出。 */
    generatedFrom: z.string().min(1),
    plugins: z.array(CatalogOverlayEntrySchema).min(1),
  })
  .strict();

export type CatalogOverlay = z.infer<typeof CatalogOverlaySchema>;
export type CatalogOverlayEntry = z.infer<typeof CatalogOverlayEntrySchema>;
