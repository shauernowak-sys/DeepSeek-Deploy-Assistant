import { z } from 'zod';

import type { SnowLumaManifest } from './snowluma';

/**
 * 双路线（官方 / 个人）的共享契约。
 *
 * 与 `qq.ts` 的分工：
 *  - `qq.ts` 只描述**官方 QQ Bot**（`im-qqbot` 插件、AppID/AppSecret、10 相位）；
 *  - 本文件描述**路线维度**与**个人 QQ**（SnowLuma + dsh-qq-link，八相位）。
 * 两者互不影响：个人路线的任何操作都不得触碰 `secrets.bin` 的 `qq.*` 与 `dda:managed:qq` 受管块。
 */

export const QQ_ROUTES = ['official', 'personal'] as const;
export type QqRoute = (typeof QQ_ROUTES)[number];

/**
 * 个人 QQ 相位。顺序即"用户旅程"，任一相位未达成时给出该相位对应的下一步。
 *
 * 判据原则（PRD §10.4 / §9.4 PQ-8）：未安装 / 已装未运行 / 运行但未联通 / 已联通未验证
 * 必须分开，禁止"进程在 = 已连接"。
 */
export const PERSONAL_QQ_PHASES = [
  'qq-missing',
  'qq-not-running',
  'snowluma-not-installed',
  'snowluma-installed',
  'snowluma-running',
  'snowluma-logged-in',
  'harness-linked',
  'message-verified',
  'failed',
] as const;

export type PersonalQqPhase = (typeof PERSONAL_QQ_PHASES)[number];

export const PERSONAL_QQ_PHASE_LABEL: Record<PersonalQqPhase, { text: string; cls: string }> = {
  'qq-missing': { text: '缺少 QQ 客户端', cls: 'warn' },
  'qq-not-running': { text: 'QQ 未启动', cls: 'warn' },
  'snowluma-not-installed': { text: 'SnowLuma 未安装', cls: '' },
  'snowluma-installed': { text: '已安装，未运行', cls: '' },
  'snowluma-running': { text: '运行中，待登录', cls: 'warn' },
  'snowluma-logged-in': { text: '已登录，待联通 Harness', cls: 'warn' },
  'harness-linked': { text: '已联通', cls: 'ok' },
  'message-verified': { text: '消息链路已验证', cls: 'ok' },
  failed: { text: '检测失败', cls: 'warn' },
};

export type PersonalQqEvidenceSource =
  | 'manifest'
  | 'fs'
  | 'process'
  | 'port'
  | 'http'
  | 'bridge'
  | 'user'
  | 'license';

/** 每条证据都必须能被用户理解："为什么是这个状态"。 */
export interface PersonalQqEvidence {
  at: string;
  source: PersonalQqEvidenceSource;
  line: string;
}

export interface PersonalQqComponentState {
  id: string;
  displayName: string;
  /** 清单锁定的版本（我们期望的）。 */
  expectedVersion: string;
  /** 实际检测到的版本（未安装时为空）。 */
  installedVersion?: string;
  installed: boolean;
  installDir?: string;
  /** 版本与清单不一致时的原因（用于 UI 提示"请升级/重装"）。 */
  versionProblem?: string;
}

export interface PersonalQqClientState {
  /** 桌面版 QQ（NTQQ）是否安装。 */
  installed: boolean;
  path?: string;
  /** 是否有 QQ.exe 在运行（SnowLuma 注入的是运行中的进程）。 */
  running: boolean;
  pids: number[];
}

export interface PersonalQqServiceState {
  /** WebUI 端口是否可连（TCP）。 */
  webuiReachable: boolean;
  /** OneBot HTTP 是否可连（TCP）。 */
  onebotReachable: boolean;
  /** OneBot `get_login_info` 是否返回真实 QQ 号。 */
  onebotResponsive: boolean;
  /** 该 OneBot 实例登录的账号（脱敏展示由 UI 负责，这里只给已确认的值）。 */
  loginUin?: string;
  nickname?: string;
  /** OneBot 探测失败原因（已脱敏，不含令牌）。 */
  error?: string;
}

export interface PersonalQqBridgeState {
  /** dsh-qq-link 的 `/dsh-qq-bridge/state` 是否返回 ok。 */
  ok: boolean;
  adapterVersion?: string;
  /** 插件对后端连通性的自述结论（字段名沿用上游的 "NapCat状态"，实质是 OneBot 后端）。 */
  backendOk: boolean;
  backendError?: string;
  /** 插件认为"活着的 Harness 会话"（可绑定给 QQ 私聊）。 */
  sessionIds?: string[];
  /** 当前绑定（非机密）。 */
  bindings?: { 类型: string; 号码: string; 会话: string }[];
}

/** 适配插件（dsh-qq-link）的安装/加载状态。 */
export interface PersonalQqAdapterState {
  installed: boolean;
  version?: string;
  /** 我们锁定并验证过的版本。 */
  expectedVersion: string;
}

export interface PersonalQqAutomation {
  /** 是否允许自动下载/安装/启动（由清单的授权文号与许可结论共同决定）。 */
  allowed: boolean;
  /** 不允许时给用户看的一句话（含依据）。 */
  reason: string;
}

export interface PersonalQqStatus {
  phase: PersonalQqPhase;
  message: string;
  nextStep: string;
  component: PersonalQqComponentState;
  client: PersonalQqClientState;
  service: PersonalQqServiceState;
  adapter: PersonalQqAdapterState;
  bridge?: PersonalQqBridgeState;
  automation: PersonalQqAutomation;
  evidence: PersonalQqEvidence[];
  checkedAt: string;
}

/** 个人 QQ 页面所需的组件信息与官方入口（IPC `personal:guide` 的载荷）。 */
export interface PersonalQqGuide {
  displayName: string;
  version: string;
  projectUrl: string;
  releasesUrl: string;
  license: SnowLumaManifest['license'];
  ports: SnowLumaManifest['ports'];
  launcher: string;
  installDir?: string;
  webuiUrl: string;
  /** 官方 Windows x64 发布包事实（文件名/大小/哈希/下载地址），用于"下载与安装"引导页。 */
  asset: { fileName: string; sizeBytes: number; sha256: string; url: string };
}

/** 用户的个人路线偏好（只影响首屏与端口选择，不影响官方路线）。 */
export interface PersonalQqSettings {
  route: QqRoute;
  /** 组件选择：当前固定 snowluma（多候选时再扩展）。 */
  componentId: string;
  /** 用户在本地自行安装的 SnowLuma 目录（本软件只读检测，不安装）。 */
  installDir?: string;
  onebotHttpPort: number;
  /** SnowLuma WebUI 端口（只在用户改过时保存）。 */
  webuiPort?: number;
  /** 用户是否已确认许可与 EULA（本软件不得代按）。 */
  /**
   * @deprecated 旧流程（本软件代装）遗留字段，仅为兼容早期 settings 文件而保留解析；
   * EULA 现在由用户本人在 SnowLuma WebUI 里接受，本软件不再写入该字段。
   */
  consent?: { acceptedAt: string; licenseVersion: string };
  /** 人工确认"已真实往返过一次"的时间（只由用户点击产生，不由自动探测推断）。 */
  messageVerifiedAt?: string;
}

export const DEFAULT_PERSONAL_QQ_SETTINGS: PersonalQqSettings = {
  route: 'personal',
  componentId: 'snowluma',
  onebotHttpPort: 3000,
};

export const RouteSchema = z.enum(QQ_ROUTES);

export const PersonalQqSettingsSchema = z
  .object({
    route: RouteSchema,
    componentId: z.string().min(1).max(64),
    installDir: z.string().min(1).max(4096).optional(),
    onebotHttpPort: z.number().int().min(1).max(65535),
    webuiPort: z.number().int().min(1).max(65535).optional(),
    consent: z
      .object({ acceptedAt: z.string().min(1), licenseVersion: z.string().min(1) })
      .strict()
      .optional(),
    messageVerifiedAt: z.string().min(1).optional(),
  })
  .strict();

export const PERSONAL_QQ_OPEN_TARGETS = ['project', 'releases', 'license', 'eula', 'webui'] as const;
export type PersonalQqOpenTarget = (typeof PERSONAL_QQ_OPEN_TARGETS)[number];

export const PersonalQqOpenSchema = z.object({ target: z.enum(PERSONAL_QQ_OPEN_TARGETS) }).strict();


/** 人工确认"已真实收到 QQ 回复"。必须由用户点击，不接受自动推断。 */
export const PersonalQqVerifyMessageSchema = z
  .object({ verified: z.boolean(), note: z.string().max(500).optional() })
  .strict();

/** 把某个 QQ 私聊绑定到指定 Harness 会话。 */
export const PersonalQqBindSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    uin: z
      .string()
      .min(5)
      .max(20)
      .regex(/^\d+$/, 'QQ 号只能是数字'),
  })
  .strict();
