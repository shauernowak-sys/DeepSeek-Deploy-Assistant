import { z } from 'zod';

/**
 * QQ 机器人接入的共享契约（spec 层，渲染进程与主进程共用）。
 *
 * 状态判定必须基于运行时可核对证据（见 docs/M3.2-技术调查报告.md §5）：
 * 配置或凭据存在 ≠ 已连接。每个 phase 都带 evidence，UI 直接展示"为什么是这个状态"。
 */
export const QQ_PHASES = [
  'not-deployed',
  'not-installed',
  'version-mismatch',
  'installed',
  'unbound',
  'binding',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
] as const;

export type QqPhase = (typeof QQ_PHASES)[number];

/** 凭据来源：none=没有；dpapi=我们加密保存（环境变量注入）；profile=插件扫码后自行写入 profile。 */
export type QqCredentialSource = 'none' | 'dpapi' | 'profile';

export interface QqEvidence {
  at: string;
  source: 'plugin-list' | 'composed-config' | 'stdout' | 'process' | 'secrets' | 'profile';
  line: string;
}

export interface QqStatus {
  phase: QqPhase;
  /** 用户能直接执行的一句话。 */
  message: string;
  nextStep: string;
  harnessInstalled: boolean;
  harnessRunning: boolean;
  pluginInstalled: boolean;
  pluginVersion?: string;
  expectedVersion: string;
  credentialSource: QqCredentialSource;
  /** AppID 非机密（插件自己也把它回显在界面/日志里）；AppSecret 永远不出主进程。 */
  appId?: string;
  bindUrl?: string;
  /** 插件在终端呈现的 ASCII 二维码（供界面直接展示，避免只靠浏览器）。 */
  bindQr?: string[];
  /** 用户最近一次点击"扫码绑定/重新生成"的时间（用于超时判定与倒计时）。 */
  bindingStartedAt?: string;
  bindingTimeoutMs?: number;
  bindingAttempts?: number;
  evidence: QqEvidence[];
  checkedAt: string;
}

export const QQ_BINDING_TIMEOUT_MS = 25_000;

export const QQ_ACCESS_MODES = ['open', 'allowlist', 'disabled'] as const;

export const QqAccessSchema = z
  .object({
    c2cMode: z.enum(QQ_ACCESS_MODES),
    c2cAllow: z.array(z.string().min(1).max(128)).max(200),
    groupMode: z.enum(QQ_ACCESS_MODES),
    groupAllow: z.array(z.string().min(1).max(128)).max(200),
  })
  .strict();

/** 只包含插件真实存在的字段（见 docs/M3.2-技术调查报告.md §3），不虚构设置项。 */
export const QqSettingsSchema = z
  .object({
    requireMention: z.boolean(),
    groupPrompt: z.string().max(4000).optional(),
    directPrompt: z.string().max(4000).optional(),
    streaming: z.boolean(),
    textChunkLimit: z.number().int().min(100).max(5000),
    historyLimit: z.number().int().min(0).max(50),
    access: QqAccessSchema,
    mediaEnabled: z.boolean(),
    sendFileRestrictPaths: z.boolean(),
  })
  .strict();

export type QqAccess = z.infer<typeof QqAccessSchema>;
export type QqSettings = z.infer<typeof QqSettingsSchema>;

/** 凭据写入方式：env=我们的 DPAPI + 启动注入；qr=官方扫码（插件自行写入 profile）。 */
export const QQ_CREDENTIAL_MODES = ['env', 'qr'] as const;
export type QqCredentialMode = (typeof QQ_CREDENTIAL_MODES)[number];

export const QqCredentialsSchema = z
  .object({
    appId: z
      .string()
      .min(4)
      .max(64)
      .regex(/^[A-Za-z0-9]+$/, 'AppID 只包含字母和数字'),
    appSecret: z.string().min(8).max(200),
  })
  .strict();

export const QqSettingsSaveSchema = z
  .object({ settings: QqSettingsSchema, mode: z.enum(QQ_CREDENTIAL_MODES) })
  .strict();

export const QqConfirmSchema = z.object({ confirm: z.boolean() }).strict();

/** 扫码绑定：`regenerate` 表示"重新生成二维码"（会再重启一次 Harness）。 */
export const QqBindingSchema = z.object({ regenerate: z.boolean().default(false) }).strict();

/** 状态轮询：`refresh: true` 才重新执行 `dsh plugin list`（1–2 秒），默认读缓存。 */
export const QqStatusQuerySchema = z.object({ refresh: z.boolean().default(false) }).strict();

export const QqEmptySchema = z.object({}).strict();

export interface QqSaveResult {
  ok: boolean;
  message: string;
  problems: string[];
  status?: QqStatus;
  /** 是否触发了 Harness 重启以让新配置/凭据生效。 */
  restarted?: boolean;
}

export const DEFAULT_QQ_ACCESS: QqAccess = {
  c2cMode: 'open',
  c2cAllow: [],
  groupMode: 'open',
  groupAllow: [],
};

/** 与插件 schema 默认值一致（决策 D3：保持插件默认，UI 可改）。 */
export const DEFAULT_QQ_SETTINGS: QqSettings = {
  requireMention: true,
  streaming: true,
  textChunkLimit: 4500,
  historyLimit: 10,
  access: DEFAULT_QQ_ACCESS,
  mediaEnabled: true,
  sendFileRestrictPaths: true,
};
