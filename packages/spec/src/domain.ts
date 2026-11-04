export const APP_NAME = 'DeepSeekDeployAssistant';

/** Locked M1 baseline (see docs/M0-技术验证报告.md and docs/04-最终决策清单.md). */
export const BASELINE = {
  node: { version: '22.23.4' },
  pnpm: { version: '11.28.5' },
  dsh: { version: '0.2.0-rc.2', profile: 'web' },
  /** `connector` 是官方 QQ 插件的运行时依赖，其许可为 UNLICENSED（2026-11-04 实测确认）。 */
  qqbot: { version: '0.5.5', connector: '1.2.0' },
} as const;

export type RuntimeId = 'node' | 'pnpm' | 'dsh';

export type RouteKind = 'cli' | 'desktop' | 'none' | 'multiple' | 'unknown';

/** Liveness / auth / business are deliberately separate: HTTP 401 means "alive", not "usable". */
export type HealthLevel = 'down' | 'alive' | 'authorized' | 'usable';

export interface Evidence {
  signal: string;
  ok: boolean;
  raw: string;
}

export interface RuntimeInfo {
  id: RuntimeId;
  installed: boolean;
  version?: string;
  path?: string;
}

export interface EnvReport {
  os: { caption: string; build: string; arch: string; admin: boolean };
  diskFreeBytes: number;
  runtimes: RuntimeInfo[];
  route: RouteReport;
  checkedAt: string;
}

export interface RouteReport {
  kind: RouteKind;
  evidence: Evidence[];
  desktopInstallDir?: string;
  dshHome?: string;
}

export interface TaskSummary {
  taskId: string;
  status: 'pending' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'rolled-back';
  steps: StepState[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** true when the pause/cancel came from the user rather than from a failure. */
  pausedByUser?: boolean;
}

export interface StepState {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';
  attempts: number;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskEvent {
  taskId: string;
  stepId: string;
  status: StepState['status'];
  progress: number;
  message?: string;
}

/** One path recorded in the task journal, judged against the managed install roots. */
export interface RollbackTarget {
  path: string;
  exists: boolean;
  /** false when the path is outside the managed roots, a symlink or otherwise unverified. */
  deletable: boolean;
  /** Set only when `deletable` is false, so the UI can explain why nothing was deleted. */
  reason?: string;
}

export interface RollbackPreview {
  taskId: string;
  entries: RollbackTarget[];
  /** Paths that would really be deleted (exists && deletable). */
  deletableCount: number;
  existingCount: number;
  roots: string[];
}

export interface RollbackResult {
  ok: boolean;
  message: string;
  summary?: TaskSummary;
  deleted: string[];
  refused: RollbackTarget[];
}

/** §21.10「回到上一可用」：一个 profile 备份的可展示摘要（D08 接线）。 */
export interface ProfileBackupSummary {
  /** 由备份目录名派生的稳定 id，渲染层回传它来选择备份。 */
  id: string;
  createdAt: string;
  files: string[];
  missing: string[];
  isLatest: boolean;
}

/**
 * 恢复前的只读预览。UI 必须先展示这些信息再让用户确认（R5：高风险动作需说明后果）。
 */
export interface ProfileRecoveryPreview {
  available: boolean;
  backups: ProfileBackupSummary[];
  latestId?: string;
  currentPlugins: Array<{ name: string; version?: string }>;
  /** 文件还原后必须按备份的 lockfile 重建依赖；pnpm 缺失时只能告知用户手工执行。 */
  rebuild: { willRun: boolean; command: string };
  warnings: string[];
  dataDir: string;
}

export interface ProfileRecoveryResult {
  ok: boolean;
  message: string;
  restored: string[];
  /** 恢复前自动打的保险备份：恢复本身失败/反悔时用它回到恢复前状态。 */
  safetyBackup?: string;
  plugins: Array<{ name: string; version?: string }>;
}

export interface HealthReport {
  level: HealthLevel;
  url: string;
  port: number;
  pid?: number;
  httpStatus?: number;
  detail: string;
  checkedAt: string;
}

export interface PluginState {
  name: string;
  version?: string;
  installed: boolean;
  listedAt?: string;
}

export interface DownloadProgress {
  url: string;
  receivedBytes: number;
  totalBytes?: number;
  attempt: number;
  mirrorIndex: number;
}
