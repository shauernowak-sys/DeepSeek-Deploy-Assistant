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

/**
 * 验收方式必须**可执行**（PRD §10.2）：一条验收 = 用户做的一步 + 可观测到的证据。
 * 只写「功能正常」这类无法判定的描述会被 schema 拒绝（step/evidence 都要有实质内容）。
 */
export const CatalogAcceptanceSchema = z
  .object({
    id: z.string().regex(/^acc-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must look like acc-<slug>'),
    step: z.string().min(6).max(200),
    evidence: z.string().min(6).max(200),
  })
  .strict();

export type CatalogAcceptance = z.infer<typeof CatalogAcceptanceSchema>;

/** 项目形态：插件、独立桥接程序、扩展工具、仅供参考的项目。 */
export const CANDIDATE_PROJECT_KINDS = ['plugin', 'bridge', 'tool', 'reference'] as const;
export type CandidateProjectKind = (typeof CANDIDATE_PROJECT_KINDS)[number];

/** 适用路线：官方 QQ 机器人、个人 QQ（OneBot/SnowLuma）、尚未确认。 */
export const CANDIDATE_ROUTES = ['official-qq', 'personal-qq', 'unconfirmed'] as const;
export type CandidateRoute = (typeof CANDIDATE_ROUTES)[number];

export const CANDIDATE_INSTALL_METHODS = ['npm', 'github', 'manual', 'none'] as const;
export type CandidateInstallMethod = (typeof CANDIDATE_INSTALL_METHODS)[number];

/**
 * 公开关注度。星标只表示公开关注度，**不是**真实用户量或安装量；
 * `queriedAt` 是取数日期，过期后应重新查询而不是继续引用。
 */
export const CatalogAttentionSchema = z
  .object({
    source: z.literal('github'),
    stars: z.number().int().nonnegative(),
    queriedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
      .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a real date'),
    url: z.string().url(),
  })
  .strict();

/**
 * 面向用户的发现信息。与 `review` 分开：
 * `review` 是"为什么不能装"的审核结论，`market` 是"它是什么、要走哪条路、缺什么"的说明。
 */
export const CATALOG_SUPPORT_LEVELS = ['verified', 'declared', 'unverified', 'unsupported'] as const;
export type CatalogSupportLevel = (typeof CATALOG_SUPPORT_LEVELS)[number];

/** 平台/基线支持情况：`declared` = 项目文档声明但本产品未实测。 */
export const CatalogCandidateSupportSchema = z
  .object({
    windowsX64: z.enum(CATALOG_SUPPORT_LEVELS),
    lockedDsh: z.enum(CATALOG_SUPPORT_LEVELS),
    webProfile: z.enum(CATALOG_SUPPORT_LEVELS),
    note: z.string().min(1).optional(),
  })
  .strict();

export const CatalogCandidateMarketSchema = z
  .object({
    kind: z.enum(CANDIDATE_PROJECT_KINDS),
    route: z.enum(CANDIDATE_ROUTES),
    installMethod: z.enum(CANDIDATE_INSTALL_METHODS),
    /** 安装/运行前需要用户另行准备的外部组件（SnowLuma、Python、QQ 小号等）。 */
    requires: z.array(z.string().min(1)).default([]),
    /** 与其他插件同时启用时已知的冲突或重复处理风险。 */
    conflicts: z.array(z.string().min(1)).default([]),
    attention: CatalogAttentionSchema.optional(),
    /** 体积无法从 registry 取得时的可读说明；不要用猜测值填 `facts.unpackedSizeBytes`。 */
    sizeNote: z.string().min(1).optional(),
    /** 兼容性结论的出处或范围说明。 */
    compatibilityNote: z.string().min(1).optional(),
    /** Windows x64 / 锁定宿主 / web profile 的支持情况。 */
    support: CatalogCandidateSupportSchema.optional(),
  })
  .strict();

export type CatalogCandidateMarket = z.infer<typeof CatalogCandidateMarketSchema>;

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
    acceptance: z.array(CatalogAcceptanceSchema).min(1),
    en: CatalogEnSchema,
    zh: CatalogZhSchema,
    category: z.string().min(1),
    labels: z.array(z.string().min(1)).default([]),
    keywords: z.array(z.string().min(1)).default([]),
    safety: CatalogSafetySchema,
    installNotes: z.array(z.string().min(1)).default([]),
    market: CatalogCandidateMarketSchema.optional(),
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
    acceptance: z.array(CatalogAcceptanceSchema).min(1),
    zh: CatalogZhSchema,
    category: z.string().min(1),
    labels: z.array(z.string()),
    keywords: z.array(z.string()),
    safety: CatalogSafetySchema,
    installNotes: z.array(z.string()),
    market: CatalogCandidateMarketSchema.optional(),
    status: z.enum(CATALOG_STATUSES),
  })
  .strict();

/**
 * 候选条目：评估过、但**没有**被允许安装的插件。
 *
 * 与 `CatalogEntry` 的区别是刻意的：
 * - 候选**不得**出现在 `index.json` 里（索引等于对外宣称"这个组合能装"）；
 * - 候选**不要求** compat / 完整依赖闭包 / 验收项——那需要真实验证，没验证就不能编；
 * - 候选**必须**带 `review`：拒绝理由要结构化（code + detail），否则"为什么不能装"无法复核。
 */
export const CANDIDATE_STATUSES = ['needs-review', 'blocked'] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * 拒绝理由的受控词表。自由文本无法被测试断言，也无法在 UI 里分门别类，
 * 因此每条第原因都必须是下面之一；具体说明放 `detail`。
 */
export const CANDIDATE_BLOCKER_CODES = [
  /** 声明或实测不支持锁定的宿主版本。 */
  'host-version-incompatible',
  /** 没有声明 `dsh.bundle.patch`，装上也只是一个普通 npm 包，不能作为插件挂载。 */
  'not-a-bundle',
  /** 发布者无法追溯（个人账号 / 无仓库 / 无主页）。 */
  'unverified-publisher',
  /** 许可不明或禁止再分发。 */
  'license-restricted',
  /** 安装期会执行脚本（preinstall/install/postinstall/prepare）。 */
  'install-script',
  /** 未做传递依赖闭包许可审计。 */
  'closure-not-audited',
  /** 与产品策展职责重复（例如第三方插件市场），引入后会绕过我方门禁。 */
  'duplicates-product-scope',
  /** PRD CR-1：宿主已有原生能力，不应引入插件。 */
  'native-capability-preferred',
  /** 体积过大（仅作提示，单独出现不构成阻断）。 */
  'size-excessive',
  /** 未声明与本宿主的兼容性，需要人工验证。 */
  'no-declared-compatibility',
  /** 闭包已审计，但含法务需复核的许可（如 GPL/MPL）：不得随我方产物分发。 */
  'closure-needs-review',
  /** 真实安装探测失败（peer 冲突、需要构建脚本授权、registry 拒绝等）。 */
  'install-failed',
  /** 项目本体使用禁止商业用途/分发的许可（如 PolyForm Noncommercial）。 */
  'noncommercial-license',
  /** 代码许可允许，但角色/图片/模型等素材另有非商业或署名限制。 */
  'asset-license-restricted',
] as const;

export type CandidateBlockerCode = (typeof CANDIDATE_BLOCKER_CODES)[number];

/** 这些理由一旦出现，条目必须是 `blocked`（不是"再看看"，而是明确不建议用）。 */
export const CANDIDATE_BLOCKING_CODES: readonly CandidateBlockerCode[] = [
  'host-version-incompatible',
  'not-a-bundle',
  'license-restricted',
  'duplicates-product-scope',
  'native-capability-preferred',
  'install-failed',
  'noncommercial-license',
];

export const CatalogCandidateBlockerSchema = z
  .object({
    code: z.enum(CANDIDATE_BLOCKER_CODES),
    detail: z.string().min(6).max(300),
  })
  .strict();



/** 评估时从 registry 取到的事实，入库以便复核"当时凭什么这样判"。 */
export const CatalogCandidateFactsSchema = z
  .object({
    license: z.string().min(1),
    unpackedSizeBytes: z.number().int().nonnegative(),
    dependencyCount: z.number().int().nonnegative(),
    peerDependencyCount: z.number().int().nonnegative(),
    hasBundlePatch: z.boolean(),
    /** 包自己声明的 dsh 兼容版本（`dsh.compatibility.dshReleases` 的键）；空数组表示没声明。 */
    declaredDshReleases: z.array(z.string().min(1)),
    hasInstallScript: z.boolean(),
    maintainers: z.number().int().nonnegative(),
  })
  .strict();

/**
 * D11 闭包审计的结果（真实安装后解析，不是估算）。
 * `verdict` 由门禁计算，入库是为了让 UI/文档能引用同一次审计的结论。
 */
export const CatalogCandidateClosureAuditSchema = z
  .object({
    auditedAt: z.string().datetime({ offset: true }),
    /** 审计方式说明，便于复核（当前固定为"隔离目录 + 真实 pnpm 安装 + 遍历 node_modules"）。 */
    method: z.string().min(10),
    verdict: z.enum(['allowed', 'needs-review', 'denied']),
    packageCount: z.number().int().positive(),
    byLicense: z.array(z.object({ license: z.string().min(1), count: z.number().int().positive() }).strict()),
    denied: z.array(DepsClosureEntrySchema),
    needsReview: z.array(DepsClosureEntrySchema),
  })
  .strict();

/** D03 侧的真实安装探测结果（用锁定版 dsh 在隔离 profile 里 `plugin add`）。 */
export const CatalogCandidateInstallProbeSchema = z
  .object({
    hostDsh: z.string().min(1),
    probedAt: z.string().datetime({ offset: true }),
    /** 是否成功装进 profile（`dsh plugin add` 退出码 0）。 */
    installed: z.boolean(),
    /** `dsh plugin list` 是否列出该精确版本（装进去 ≠ 能挂载）。 */
    listed: z.boolean(),
    elapsedMs: z.number().int().nonnegative(),
    /** 失败时的可读原因（截断的原始输出）。 */
    failure: z.string().min(1).optional(),
  })
  .strict();

export const CatalogCandidateReviewSchema = z
  .object({
    /** 一句话结论（给用户看）。 */
    reason: z.string().min(10).max(300),
    blockers: z.array(CatalogCandidateBlockerSchema).min(1),
    /** 评估日期（YYYY-MM-DD），与 registry 取数同一天。 */
    evaluatedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
      .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a real date'),
    facts: CatalogCandidateFactsSchema,
    /** 取数来源（registry 或项目仓库 URL），便于重放。 */
    source: z.string().url(),
    /** D11 闭包审计（做了才有；没做时 blockers 必须含 closure-not-audited）。 */
    closureAudit: CatalogCandidateClosureAuditSchema.optional(),
    /** D03 安装探测（做了才有）。 */
    installProbe: CatalogCandidateInstallProbeSchema.optional(),
  })
  .strict();

export const CatalogCandidateZhSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1),
    description: z.string().min(1),
    risk: z.string().min(1).optional(),
  })
  .strict();

export const CatalogCandidateSchema = z
  .object({
    id: z.string().regex(/^plg-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must look like plg-<slug>'),
    name: z.string().min(1),
    version: z.string().regex(EXACT_SEMVER, 'must be an exact SemVer version'),
    publishTimestamp: z.number().int().nonnegative(),
    source: CatalogSourceSchema,
    license: CatalogLicenseSchema,
    /** npm 包才有 dist.integrity；GitHub 源候选没有可核对的 tarball SRI 时必须留空，不能编造。 */
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/, 'must be a sha512 SRI string').optional(),
    en: CatalogEnSchema,
    zh: CatalogCandidateZhSchema,
    category: z.string().min(1),
    labels: z.array(z.string().min(1)).default([]),
    keywords: z.array(z.string().min(1)).default([]),
    status: z.enum(CANDIDATE_STATUSES),
    market: CatalogCandidateMarketSchema,
    review: CatalogCandidateReviewSchema,
    /** 已审计的完整闭包（逐包裁决）；与 `review.closureAudit` 同时出现。 */
    depsClosure: z.array(DepsClosureEntrySchema).default([]),
    installNotes: z.array(z.string().min(1)).default([]),
    repository: z
      .object({ url: z.string().url(), directory: z.string().min(1).optional() })
      .strict()
      .optional(),
    homepage: z.string().url().optional(),
    author: z.string().min(1).optional(),
  })
  .strict();

export type CatalogCandidate = z.infer<typeof CatalogCandidateSchema>;
export type CatalogCandidateReview = z.infer<typeof CatalogCandidateReviewSchema>;

/**
 * 一个候选的审计证据（闭包 + 闭包结论 + 安装探测）。
 * 单独成类型，便于 `catalog/data/candidate-audits.ts` 由审计脚本生成后按 id 引用。
 */
export const CatalogCandidateAuditSchema = z
  .object({
    depsClosure: z.array(DepsClosureEntrySchema).min(1),
    closureAudit: CatalogCandidateClosureAuditSchema,
    installProbe: CatalogCandidateInstallProbeSchema.optional(),
  })
  .strict();

export type CatalogCandidateAudit = z.infer<typeof CatalogCandidateAuditSchema>;

/** overlay 里的候选形态：UI 需要展示的字段 + 结构化拒绝理由。 */
export const CatalogOverlayCandidateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    status: z.enum(CANDIDATE_STATUSES),
    license: CatalogLicenseSchema,
    integrity: z.string().min(1).optional(),
    depsClosure: z.array(DepsClosureEntrySchema).default([]),
    zh: CatalogCandidateZhSchema,
    category: z.string().min(1),
    labels: z.array(z.string()),
    keywords: z.array(z.string()),
    installNotes: z.array(z.string()),
    market: CatalogCandidateMarketSchema,
    review: CatalogCandidateReviewSchema,
  })
  .strict();

export type CatalogOverlayCandidate = z.infer<typeof CatalogOverlayCandidateSchema>;

export const CatalogOverlaySchema = z
  .object({
    schemaVersion: z.literal(1),
    /** 生成它的 catalog 版本；用于判断 overlay 是否与索引同批产出。 */
    generatedFrom: z.string().min(1),
    plugins: z.array(CatalogOverlayEntrySchema).min(1),
    /** 评估过但未通过的候选（D09 完整策展）。它们不进 index.json，只在本地展示。 */
    candidates: z.array(CatalogOverlayCandidateSchema).default([]),
  })
  .strict();

export type CatalogOverlay = z.infer<typeof CatalogOverlaySchema>;
export type CatalogOverlayEntry = z.infer<typeof CatalogOverlayEntrySchema>;

/**
 * 安装过程中的真实进度事件（主进程 → 渲染层）。
 *
 * 只暴露步骤序号、名称、状态与实际使用的源；**不携带**命令输出、令牌或聊天内容。
 * `source` 只会在真正开始/结束一次源尝试时出现，不用来宣称"一定可达"。
 */
export type MarketInstallProgressEvent = {
  phase: 'starting' | 'step' | 'source' | 'done' | 'failed';
  message: string;
  step?: {
    index: number;
    id: string;
    title: string;
    status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'unverified';
  };
  source?: {
    label: string;
    url?: string;
    attempt?: number;
    total?: number;
    ok?: boolean;
  };
};

