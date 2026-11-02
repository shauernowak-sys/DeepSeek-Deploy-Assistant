export const APP_NAME = 'DeepSeekDeployAssistant';

/** Locked M1 baseline (see docs/M0-技术验证报告.md and docs/04-最终决策清单.md). */
export const BASELINE = {
  node: { version: '22.23.4' },
  pnpm: { version: '11.28.5' },
  dsh: { version: '0.2.0-rc.2', profile: 'web' },
  qqbot: { version: '0.5.5' },
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
