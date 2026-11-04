import type { Evidence, EnvReport, RouteReport } from './domain';

/**
 * PRD §7.1 / ENV-5STATE 的五态。顺序与文档一致，不得自行增删：
 * 已安装 / 未安装 / 版本不符 / 需升级 / 检测失败
 */
export const COMPONENT_STATES = [
  'installed',
  'missing',
  'version-mismatch',
  'upgrade-required',
  'probe-failed',
] as const;

export type ComponentState = (typeof COMPONENT_STATES)[number];

export type ComponentId =
  | 'node-system'
  | 'node-managed'
  | 'pnpm-managed'
  | 'harness-managed'
  | 'harness-system'
  | 'harness-desktop';

/** 稳定的诊断码：状态只有五态，但决策需要区分「为什么」是这个状态。 */
export type ComponentDiagnosis =
  | 'ok'
  | 'not-found'
  | 'not-executable'
  | 'version-too-low'
  | 'version-different'
  | 'unstable-path'
  | 'multiple-versions'
  | 'ambiguous'
  | 'probe-error';

export type CandidateSource = 'path' | 'common' | 'version-manager' | 'managed' | 'registry';

export interface ComponentCandidate {
  path: string;
  version?: string;
  source: CandidateSource;
  /** `node -v` / `dsh --version` 是否真的执行成功。 */
  runnable: boolean;
  /** D-6 ③：路径稳定（非临时目录 / 非版本管理器临时切换）。 */
  stable: boolean;
  /** PATH 中的命中顺序（0 = 第一个），未命中 PATH 时省略。 */
  onPathOrder?: number;
  /** 该 Node 是否自带 npm（安装私有 pnpm 时需要）。 */
  hasNpm?: boolean;
  error?: string;
}

export interface ComponentCheck {
  id: ComponentId;
  label: string;
  /** 人类可读的版本要求，例如 `>= 20.3.0` 或 `= 0.2.0-rc.2`。 */
  required: string;
  state: ComponentState;
  diagnosis: ComponentDiagnosis;
  version?: string;
  path?: string;
  candidates: ComponentCandidate[];
  evidence: Evidence[];
  /** 面向普通用户的一句话说明（「为什么」）。 */
  detail: string;
  checkedAt: string;
}

export type PrerequisiteId = 'os' | 'disk' | 'permissions' | 'network' | 'directories';

/**
 * PRD §7.1 对非组件项的独立状态枚举。
 * 网络：主源可用 / 仅镜像可用 / 均不可用；权限：普通用户（正常） / 管理员（提示不需要）。
 */
export type PrerequisiteState =
  | 'supported'
  | 'unsupported'
  | 'sufficient'
  | 'insufficient'
  | 'standard'
  | 'elevated'
  | 'writable'
  | 'unwritable'
  | 'primary-available'
  | 'mirror-only'
  | 'unavailable';

export interface PrerequisiteCheck {
  id: PrerequisiteId;
  label: string;
  ok: boolean;
  state: PrerequisiteState;
  detail: string;
  evidence: Evidence[];
  checkedAt: string;
}

export type RuntimeMode = 'system' | 'managed';

export interface EnvironmentResolution {
  /** PATH 第一个命中的 Node（仅当能执行时才有版本）。 */
  pathNode?: { path: string; version?: string };
  /** 满足 D-6 且可用于复用的系统 Node 候选（稳定路径优先）。 */
  reusableSystemNode?: { path: string; version: string };
  managedNode?: { path: string; version?: string };
  managedHarness?: { path: string; version?: string };
  reusableSystemHarness?: { path: string; binPath: string; version: string };
  desktopProfileExists: boolean;
  profiles: { home: string; homeExists: boolean; webExists: boolean; desktopExists: boolean };
  activeNode: { mode: RuntimeMode | 'none'; path?: string; version?: string };
  activeHarness: { mode: RuntimeMode | 'none'; path?: string; version?: string };
}

/** 扩展报告：保留 M1/M2 的 `EnvReport` 字段（诊断包仍可使用），并增加真实检测结果。 */
export interface EnvironmentReport extends EnvReport {
  schemaVersion: 2;
  scanId: string;
  components: ComponentCheck[];
  prerequisites: PrerequisiteCheck[];
  resolution: EnvironmentResolution;
  probeErrors: { probe: string; message: string }[];
  route: RouteReport;
  checkedAt: string;
}

/** 内部决策动作，**不是**环境状态；UI 不得把二者混用。 */
export const DECISION_ACTIONS = [
  'INSTALL',
  'REUSE',
  'UPGRADE',
  'REPAIR',
  'BLOCKED',
  'CONFIRM_REQUIRED',
] as const;

export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export interface DecisionPreferences {
  node?: 'auto' | 'system' | 'private';
  harness?: 'auto' | 'system' | 'private';
  /** 显式指定要复用的系统 Node（多个版本并存时必须）。 */
  nodePath?: string;
  /** 显式指定要复用的系统 Harness CLI（多个安装位置并存时必须）。 */
  harnessPath?: string;
  /** 「CLI 与 Desktop 并存」的知悉确认。 */
  routeAcknowledged?: boolean;
}

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  preferences: DecisionPreferences;
}

export interface ComponentDecision {
  component: string;
  label: string;
  action: DecisionAction;
  state: ComponentState;
  current?: { version?: string; path?: string };
  target?: { version?: string; path?: string };
  reason: string;
  evidence: string[];
  /** 可能影响的用户数据；空数组表示只读/不触碰。 */
  impacts: string[];
  requiresAdmin: boolean;
  requiresNetwork: boolean;
  requiresConfirmation: boolean;
  recovery: string;
}

/**
 * 执行部署时实际使用的运行时。
 * `managed` 路径永远位于本软件数据目录内；`system` 只读复用，绝不修改。
 */
export interface RuntimeSelection {
  node: { mode: RuntimeMode; exe: string; version?: string; dir: string };
  harness: { mode: RuntimeMode; bin?: string; version?: string };
}

export interface InstallationDecision {
  planId: string;
  generatedAt: string;
  environmentCheckedAt: string;
  overall: DecisionAction;
  /** 有 BLOCKED 或仍需要用户选择时不可执行。 */
  deployable: boolean;
  blocked: boolean;
  needsChoice: boolean;
  requiresConfirmation: boolean;
  requiresAdmin: boolean;
  requiresNetwork: boolean;
  components: ComponentDecision[];
  /** 确认页的四组清单。 */
  install: string[];
  reuse: string[];
  modify: string[];
  untouched: string[];
  blockers: string[];
  warnings: string[];
  recovery: string;
  options: DecisionOption[];
  preferences: DecisionPreferences;
  /** 仅在 `deployable === true` 时给出。 */
  runtime: RuntimeSelection | null;
}

export interface EnvironmentInspection {
  environment: EnvironmentReport;
  decision: InstallationDecision;
}

/** 门禁通过后交给执行器的唯一凭据。 */
export interface DeploymentDecisionAuthorization {
  decision: InstallationDecision;
  environment: EnvironmentReport;
  runtime: RuntimeSelection;
}
