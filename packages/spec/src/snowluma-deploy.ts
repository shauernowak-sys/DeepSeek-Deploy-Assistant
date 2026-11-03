import { z } from 'zod';

/**
 * M3.3 个人 QQ（SnowLuma）自动化部署契约。
 *
 * 关键约束（见 docs/M3.3-实施报告.md §2）：SnowLuma EULA §5.4 把"通过自动化脚本部署"列为
 * 需事先取得著作权人书面授权的事项，因此本契约里的自动化步骤**只有在清单登记了
 * `authorizationRef` 时才允许执行**；否则一律 `blocked`，并给出可继续完成的部分。
 *
 * 本文件只描述数据形状，不含任何凭据字段：OneBot 令牌永远只在主进程内存里流转。
 */

/** 部署步骤：顺序即执行顺序，也与 UI 的"部署"阶段一一对应。 */
export const SNOWLUMA_STEP_IDS = [
  'precheck',
  'release',
  'download',
  'install',
  'configure',
  'start',
  'link',
  'verify',
] as const;

export type SnowLumaStepId = (typeof SNOWLUMA_STEP_IDS)[number];

export const SNOWLUMA_STEP_LABEL: Record<SnowLumaStepId, string> = {
  precheck: '环境检查',
  release: '获取官方版本',
  download: '下载安装包',
  install: '解压安装',
  configure: '写入 OneBot 配置',
  start: '启动 SnowLuma',
  link: '联通 Harness',
  verify: '双向消息验收',
};

export type SnowLumaStepStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'skipped';

export interface SnowLumaStepProgress {
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
  /** 字节/秒（主进程按时间窗口计算，不用瞬时值）。 */
  speedBps?: number;
  /** 预计剩余秒数。 */
  etaSeconds?: number;
}

/**
 * SnowLuma 进程状态（主进程 → 渲染层）。
 * 只描述"我们观察到的事实"，不含命令行与令牌。
 */
export interface SnowLumaProcessStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  exited?: { code: number | null; signal: string | null; at: string };
}

/** 安装目录逐项校验结果（只读）。 */
export interface InstallCheck {
  id: string;
  label: string;
  ok: boolean;
  /** 缺失/异常时的说明（不含任何路径以外的敏感信息）。 */
  detail?: string;
}

/** 安装目录校验结果（`verifyInstallDir` 的返回值，也是 IPC 载荷）。 */
export interface InstallVerification {
  /** 用户选择/我们猜测的目录。 */
  requestedDir: string;
  /** 实际生效目录（若用户选的是上一级，会自动下钻一层）。 */
  installDir?: string;
  /** 是否从子目录解析出来的（用户选了包含解压目录的父目录）。 */
  resolvedFromChild: boolean;
  exists: boolean;
  valid: boolean;
  version?: string;
  target?: string;
  expectedVersion: string;
  versionMatches: boolean;
  checks: InstallCheck[];
  problems: string[];
  hasConfig: boolean;
  hasData: boolean;
}

/** 自动发现的一个候选安装目录。 */
export interface LocateCandidate {
  dir: string;
  source: 'settings' | 'managed' | 'common' | 'profile-scan';
  verification: InstallVerification;
}

/** 「我已完成安装」后返回的完整发现结果。 */
export interface SnowLumaInstallDiscovery {
  expectedVersion: string;
  candidates: LocateCandidate[];
  selected?: InstallVerification;
}

/** OneBot 配置里一个 HTTP 服务的摘要（不含令牌本身）。 */
export interface SnowLumaConfigHttpServer {
  name?: string;
  host?: string;
  port?: number;
  hasToken: boolean;
}

/** SnowLuma 配置现状（只读，令牌不外泄）。 */
export interface SnowLumaConfigInspection {
  configDir: string;
  exists: boolean;
  files: string[];
  httpServers: SnowLumaConfigHttpServer[];
  /** 实际会被使用的配置文件（快照优先）。 */
  sourceFile?: string;
  problem?: string;
}

export interface SnowLumaStepState {
  id: SnowLumaStepId;
  label: string;
  status: SnowLumaStepStatus;
  /** 面向普通用户的一句话说明（当前进展或结论）。 */
  detail?: string;
  /** 失败原因（已脱敏）。 */
  error?: string;
  /** 可操作的建议。 */
  hint?: string;
  startedAt?: string;
  finishedAt?: string;
  /** 该步骤产生的证据行（已脱敏，可折叠展示）。 */
  evidence: string[];
  progress?: SnowLumaStepProgress;
  /** 该步骤是否可以单独重跑。 */
  retryable: boolean;
}

export type SnowLumaDeployStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'blocked';

export interface SnowLumaDeployAuthorization {
  allowed: boolean;
  mode: 'auto' | 'guided';
  /** 给用户看的依据（含 EULA 条款与授权文号是否已登记）。 */
  reason: string;
  /** 清单里登记的授权文号（脱敏后展示，通常为空）。 */
  authorizationRef?: string;
}

export interface SnowLumaDeploySnapshot {
  id: string;
  status: SnowLumaDeployStatus;
  authorization: SnowLumaDeployAuthorization;
  steps: SnowLumaStepState[];
  installDir: string;
  startedAt?: string;
  finishedAt?: string;
  /** 整体结论（面向用户）。 */
  message: string;
  productVersion: string;
}

export const SnowLumaStepIdSchema = z.enum(SNOWLUMA_STEP_IDS);

export const SnowLumaStartDeploySchema = z
  .object({
    /** 用户选择的安装目录；缺省用受管目录。 */
    installDir: z.string().min(3).max(4096).optional(),
    /** 修复模式：即使版本一致也重新解压（保留 config/ 与 data/）。 */
    repair: z.boolean().default(false),
  })
  .strict();

export const SnowLumaRunStepSchema = z.object({ stepId: SnowLumaStepIdSchema }).strict();

export const SnowLumaEmptySchema = z.object({}).strict();

/** 校验某个目录是否是 SnowLuma 安装目录（只读）。不传目录时用当前已保存/自动发现的目录。 */
export const SnowLumaVerifyInstallSchema = z
  .object({ installDir: z.string().min(3).max(4096).optional() })
  .strict();

/** 用户确认"就用这个目录"（我们会记到设置里，后续检测与启动都用它）。 */
export const SnowLumaUseInstallSchema = z
  .object({ installDir: z.string().min(3).max(4096) })
  .strict();

/** 配置备份名由我们生成（`config-<ISO 时间戳>`），这里只做形状校验。 */
export const SnowLumaRestoreConfigSchema = z
  .object({ name: z.string().min(1).max(120).regex(/^config-[0-9A-Za-z:.+-]+$/, '备份名不合法') })
  .strict();

/**
 * 卸载契约：必须逐类确认。
 * 默认只在用户勾选时删除对应类别 —— 默认不动任何用户数据。
 */
export const SnowLumaUninstallSchema = z
  .object({
    /** 删除我们自己的安装记录与暂存目录（不动 SnowLuma 本体）。 */
    removeOurState: z.boolean().default(true),
    /** 删除 SnowLuma 程序文件（安装目录里的包内条目）。 */
    removeComponent: z.boolean().default(false),
    /** 删除 SnowLuma 的 config/（OneBot 配置、WebUI 口令、协议接受记录）。 */
    removeConfig: z.boolean().default(false),
    /** 删除 SnowLuma 的 data/（QQ 登录态、消息库）。 */
    removeUserData: z.boolean().default(false),
    /** 用户明确确认。 */
    confirm: z.boolean().default(false),
  })
  .strict();

export type SnowLumaStartDeployInput = z.infer<typeof SnowLumaStartDeploySchema>;
export type SnowLumaUninstallInput = z.infer<typeof SnowLumaUninstallSchema>;
