import { useCallback, useEffect, useMemo, useState } from 'react';

import { QQ_PLUGIN_DISTRIBUTION } from '@dda/spec';

import { PersonalQqPanel } from './components/PersonalQqPanel';

interface StepState {
  id: string;
  title: string;
  status: string;
  message?: string;
  attempts?: number;
}

interface TaskSummary {
  taskId: string;
  status: string;
  steps: StepState[];
  error?: string;
  startedAt?: string;
  pausedByUser?: boolean;
}

interface ComponentCheckView {
  id: string;
  label: string;
  required: string;
  state: string;
  diagnosis: string;
  version?: string;
  path?: string;
  detail: string;
  checkedAt: string;
  candidates: { path: string; version?: string; runnable: boolean; stable: boolean; onPathOrder?: number; error?: string }[];
  evidence: { signal: string; ok: boolean; raw: string }[];
}

interface PrerequisiteView {
  id: string;
  label: string;
  ok: boolean;
  state: string;
  detail: string;
  evidence: { signal: string; ok: boolean; raw: string }[];
}

interface EnvReport {
  os: { caption: string; arch: string; admin: boolean; build?: string };
  diskFreeBytes: number;
  runtimes: { id: string; installed: boolean; version?: string; path?: string }[];
  route: { kind: string; evidence: { signal: string; ok: boolean; raw: string }[]; dshHome?: string };
  checkedAt: string;
  scanId: string;
  components: ComponentCheckView[];
  prerequisites: PrerequisiteView[];
  probeErrors: { probe: string; message: string }[];
  resolution: {
    pathNode?: { path: string; version?: string };
    reusableSystemNode?: { path: string; version: string };
    managedNode?: { path: string; version?: string };
    reusableSystemHarness?: { path: string; binPath: string; version: string };
    profiles: { home: string; homeExists: boolean; webExists: boolean; desktopExists: boolean };
  };
}

interface ComponentDecisionView {
  component: string;
  label: string;
  action: string;
  state: string;
  current?: { version?: string; path?: string };
  target?: { version?: string; path?: string };
  reason: string;
  impacts: string[];
  requiresNetwork: boolean;
  requiresAdmin: boolean;
  recovery: string;
}

interface DecisionOptionView {
  id: string;
  label: string;
  description: string;
  preferences: Record<string, unknown>;
}

interface DecisionView {
  planId: string;
  generatedAt: string;
  overall: string;
  deployable: boolean;
  blocked: boolean;
  needsChoice: boolean;
  requiresAdmin: boolean;
  requiresNetwork: boolean;
  install: string[];
  reuse: string[];
  modify: string[];
  untouched: string[];
  blockers: string[];
  warnings: string[];
  recovery: string;
  options: DecisionOptionView[];
  components: ComponentDecisionView[];
  runtime: {
    node: { mode: string; exe: string; version?: string };
    harness: { mode: string; bin?: string; version?: string };
  } | null;
}

interface InspectionView {
  environment: EnvReport;
  decision: DecisionView;
}

interface HealthReport {
  level: 'down' | 'alive' | 'authorized' | 'usable';
  url: string;
  port: number;
  detail: string;
  httpStatus?: number;
}

interface Plugin {
  name: string;
  version?: string;
  installed?: boolean;
}

interface HarnessInfo {
  dshVersion?: string;
  nodeVersion?: string;
  profile: string;
  profileExists: boolean;
  plugins: Plugin[];
  task?: TaskSummary;
}

interface Bootstrap {
  appVersion: string;
  baseline: {
    node: { version: string };
    pnpm: { version: string };
    dsh: { version: string; profile: string };
    qqbot: { version: string };
  };
  qqGate: { id: string; status: string; verified: string[]; notVerified: string[]; note: string };
  dataDir: string;
  registry: string;
  lastTask?: TaskSummary;
  apiTemplate: ApiProviderView;
  apiModels: { id: string; name: string; contextWindow: number }[];
  apiStatus: ApiStatusView;
  qqSettings: QqSettingsPayloadView;
}

/** Mirrors `ApiProviderConfig` in the main process (already validated there). */
interface ApiProviderView {
  template: 'deepseek' | 'openai-compatible';
  label: string;
  protocol: 'anthropic-messages' | 'openai-completions';
  baseUrl: string;
  model: string;
  credentialRef: string;
  contextWindow?: number;
}

interface ApiStatusView {
  configured: boolean;
  config?: ApiProviderView;
  keyMask?: string;
  patchPath: string;
  harnessInstalled: boolean;
}

interface ProbeStepView {
  stage: string;
  ok: boolean;
  detail: string;
  millis: number;
}

interface ConnectionView {
  verdict: string;
  message: string;
  nextStep: string;
  httpStatus?: number;
  millis: number;
  model?: string;
  steps: ProbeStepView[];
  harness?: { ok: boolean; problems: string[]; method: string };
}

interface SaveView {
  ok: boolean;
  problems: string[];
  applied?: boolean;
  message: string;
  status?: ApiStatusView;
}

interface CancelPreview {
  paths: string[];
  existing: string[];
  count: number;
}

/** Mirrors `RollbackTarget` in @dda/spec — only the fields this view renders. */
interface RollbackTargetView {
  path: string;
  exists: boolean;
  deletable: boolean;
  reason?: string;
}

interface RollbackPreviewView {
  taskId: string;
  entries: RollbackTargetView[];
  deletableCount: number;
  existingCount: number;
  roots: string[];
}

interface RollbackResultView {
  ok: boolean;
  message: string;
  summary?: TaskSummary;
  deleted: string[];
  refused: RollbackTargetView[];
}

interface DiagPreview {
  entries: string[];
  totalBytes: number;
  targetDir: string;
  warning: string;
}

type QqPhaseView =
  | 'not-deployed'
  | 'not-installed'
  | 'version-mismatch'
  | 'installed'
  | 'unbound'
  | 'binding'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

interface QqStatusView {
  phase: QqPhaseView;
  message: string;
  nextStep: string;
  harnessInstalled: boolean;
  harnessRunning: boolean;
  pluginInstalled: boolean;
  pluginVersion?: string;
  expectedVersion: string;
  credentialSource: 'none' | 'dpapi' | 'profile';
  appId?: string;
  bindUrl?: string;
  bindQr?: string[];
  bindingStartedAt?: string;
  bindingTimeoutMs?: number;
  bindingAttempts?: number;
  evidence: { at: string; source: string; line: string }[];
  checkedAt: string;
}

interface QqSettingsView {
  requireMention: boolean;
  groupPrompt?: string;
  directPrompt?: string;
  streaming: boolean;
  textChunkLimit: number;
  historyLimit: number;
  access: {
    c2cMode: 'open' | 'allowlist' | 'disabled';
    c2cAllow: string[];
    groupMode: 'open' | 'allowlist' | 'disabled';
    groupAllow: string[];
  };
  mediaEnabled: boolean;
  sendFileRestrictPaths: boolean;
}

interface QqSettingsPayloadView {
  settings: QqSettingsView;
  mode: 'env' | 'qr';
  credentialSource: 'none' | 'dpapi' | 'profile';
  appId?: string;
  appSecretMask?: string;
  plaintextInProfile: boolean;
  bindingMode: boolean;
  outputTail: string[];
}

interface QqSaveView {
  ok: boolean;
  message: string;
  problems: string[];
  restarted?: boolean;
  status?: QqStatusView;
}

const QQ_PHASE_LABEL: Record<QqPhaseView, { text: string; cls: string }> = {
  'not-deployed': { text: '未部署', cls: 'bad' },
  'not-installed': { text: '插件未安装', cls: 'bad' },
  'version-mismatch': { text: '版本不匹配', cls: 'bad' },
  installed: { text: '已安装（未运行）', cls: 'warn' },
  unbound: { text: '未授权', cls: 'warn' },
  binding: { text: '等待扫码授权', cls: 'warn' },
  connecting: { text: '连接中', cls: 'warn' },
  connected: { text: '已连接', cls: 'ok' },
  reconnecting: { text: '重连中', cls: 'warn' },
  failed: { text: '连接失败', cls: 'bad' },
};

type Api = {
  bootstrap: () => Promise<Bootstrap>;
  inspectEnv: (preferences?: Record<string, unknown>) => Promise<InspectionView>;
  decideEnv: (preferences?: Record<string, unknown>) => Promise<DecisionView>;
  startDeploy: (input: { planId: string; confirmed: boolean; fresh?: boolean }) => Promise<{ taskId: string }>;
  resumeDeploy: (taskId: string) => Promise<{ taskId: string }>;
  taskStatus: (taskId: string) => Promise<TaskSummary | undefined>;
  pauseDeploy: (taskId: string) => Promise<TaskSummary | undefined>;
  cancelPreview: (taskId: string) => Promise<CancelPreview>;
  cancelDeploy: (
    taskId: string,
    cleanup: boolean,
  ) => Promise<{ summary?: TaskSummary; cleaned: string[]; cleanupSkipped: boolean }>;
  rollbackPreview: (taskId: string) => Promise<RollbackPreviewView>;
  rollback: (taskId: string, confirmed: boolean) => Promise<RollbackResultView>;
  launchHarness: (port?: number) => Promise<{ running: boolean; url?: string; health?: HealthReport }>;
  stopHarness: () => Promise<{ ok: boolean }>;
  harnessStatus: () => Promise<{ running: boolean; url?: string; health?: HealthReport }>;
  harnessInfo: () => Promise<HarnessInfo>;
  openHarness: () => Promise<{ ok: boolean; reason?: string }>;
  apiTest: (payload: { config: ApiProviderView; apiKey?: string }) => Promise<ConnectionView>;
  apiSave: (payload: { config: ApiProviderView; apiKey?: string }) => Promise<SaveView>;
  apiDelete: () => Promise<ApiStatusView>;
  qqStatus: (refresh?: boolean) => Promise<QqStatusView>;
  qqSettings: () => Promise<QqSettingsPayloadView>;
  qqOutput: () => Promise<string[]>;
  qqSaveCredentials: (payload: { appId: string; appSecret: string }) => Promise<QqSaveView>;
  qqDeleteCredentials: () => Promise<QqSaveView>;
  qqSaveSettings: (payload: { settings: QqSettingsView; mode: 'env' | 'qr' }) => Promise<QqSaveView>;
  qqStartBinding: (regenerate?: boolean) => Promise<QqSaveView>;
  qqCancelBinding: () => Promise<QqSaveView>;
  qqMigrate: (confirm: boolean) => Promise<QqSaveView>;
  qqRepairPlugin: () => Promise<QqSaveView>;
  qqOpenBind: () => Promise<{ ok: boolean; reason?: string }>;
  openLogs: () => Promise<{ path: string }>;
  diagPreview: () => Promise<DiagPreview>;
  diagExport: (confirmed: boolean) => Promise<{ cancelled: boolean; zipPath?: string; bytes?: number; entries?: number }>;
  onTaskEvent: (handler: (event: { stepId: string; status: string; progress: number; message?: string }) => void) => () => void;
};

declare global {
  interface Window {
    dda: Api;
  }
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  running: '进行中',
  succeeded: '已完成',
  skipped: '已跳过',
  failed: '失败',
  cancelled: '已取消',
};

const TASK_LABEL: Record<string, string> = {
  pending: '待开始',
  running: '进行中',
  paused: '已暂停（可继续）',
  succeeded: '已完成',
  failed: '部署失败',
  cancelled: '已取消',
  'rolled-back': '已回滚',
};

const HEALTH_LABEL: Record<HealthReport['level'], { text: string; cls: string; hint: string }> = {
  down: { text: '不可达', cls: 'bad', hint: '进程未启动或端口未监听' },
  alive: { text: '存活（未鉴权）', cls: 'warn', hint: 'HTTP 401 说明服务在线，但还不能证明可用' },
  authorized: { text: '鉴权通过', cls: 'warn', hint: 'token 已被接受，但业务就绪未证实' },
  usable: { text: '可用', cls: 'ok', hint: '已返回应用外壳' },
};

const STATE_LABEL: Record<string, { text: string; cls: string }> = {
  installed: { text: '已安装', cls: 'ok' },
  missing: { text: '未安装', cls: 'warn' },
  'version-mismatch': { text: '版本不符', cls: 'bad' },
  'upgrade-required': { text: '需升级', cls: 'warn' },
  'probe-failed': { text: '检测失败', cls: 'bad' },
};

const DECISION_LABEL: Record<string, { text: string; cls: string }> = {
  INSTALL: { text: '需要安装', cls: 'warn' },
  REUSE: { text: '可以复用', cls: 'ok' },
  UPGRADE: { text: '需要升级', cls: 'warn' },
  REPAIR: { text: '需要修复', cls: 'bad' },
  BLOCKED: { text: '禁止继续', cls: 'bad' },
  CONFIRM_REQUIRED: { text: '需要你确认', cls: 'warn' },
};

const PREREQ_LABEL: Record<string, string> = {
  supported: '支持',
  unsupported: '不支持',
  sufficient: '充足',
  insufficient: '不足',
  standard: '普通用户（正常）',
  elevated: '管理员（本软件不需要）',
  writable: '可写',
  unwritable: '不可写',
  'primary-available': '主源可用',
  'mirror-only': '仅镜像可用',
  unavailable: '均不可用',
};

function decisionHeadline(decision: DecisionView): string {
  if (decision.blocked) return '暂时不能自动部署：请先处理下面的阻塞项。';
  if (decision.needsChoice) return '检测已完成，需要你先选择使用哪一套运行环境。';
  if (decision.install.length === 0 && decision.modify.length === 0) return '当前环境已满足要求，无需重复安装。';
  if (decision.install.length > 0) return `可以开始部署：将安装 ${decision.install.join('、')}。`;
  return '可以开始部署：将修复/升级本软件自己的组件。';
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Maps engine error text to a user-facing failure category. */
function failureCategory(message?: string): { label: string; hint: string; cls: string } | undefined {
  if (!message) return undefined;
  const m = message.toLowerCase();
  if (m.includes('sha256') || m.includes('哈希')) {
    return { label: '校验失败', hint: '下载内容与清单不一致，已丢弃坏文件；点击“继续”会自动换源重试。', cls: 'bad' };
  }
  if (m.includes('http') || m.includes('etimedout') || m.includes('econn') || m.includes('network') || m.includes('下载')) {
    return { label: '下载失败', hint: '网络或镜像不可达；已保留已下载部分，恢复网络后点“继续”。', cls: 'bad' };
  }
  if (m.includes('pnpm') || m.includes('依赖') || m.includes('npm')) {
    return { label: '依赖安装失败', hint: '包安装未完成；可重试，或查看日志确认是否被网络/权限拦截。', cls: 'bad' };
  }
  if (m.includes('dsh web') || m.includes('启动') || m.includes('健康') || m.includes('probe')) {
    return { label: '启动失败', hint: '运行时未就绪；先确认部署成功，再点“启动 Harness”并查看日志。', cls: 'bad' };
  }
  if (m.includes('磁盘') || m.includes('enospc')) {
    return { label: '磁盘不足', hint: '清理出至少 2 GB 后重试。', cls: 'bad' };
  }
  return { label: '未分类失败', hint: '可展开下方详情或导出诊断报告。', cls: 'warn' };
}

/** Electron prefixes IPC rejections with the channel name and the error class; both are noise for an end user. */
function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '');
}

export function App(): JSX.Element {
  const api = window.dda;
  const [page, setPage] = useState<'home' | 'environment' | 'deploy' | 'model' | 'qq' | 'status' | 'diagnostics' | 'finish'>('home');
  const [boot, setBoot] = useState<Bootstrap>();
  const [env, setEnv] = useState<EnvReport>();
  const [decision, setDecision] = useState<DecisionView>();
  const [deployPlan, setDeployPlan] = useState<DecisionView>();
  const [qqTab, setQqTab] = useState<'official' | 'personal'>('official');
  const [task, setTask] = useState<TaskSummary>();
  const [info, setInfo] = useState<HarnessInfo>();
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState<string>();
  const [health, setHealth] = useState<HealthReport>();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [apiKey, setApiKey] = useState('');
  const [keyMask, setKeyMask] = useState<string>();
  const [apiForm, setApiForm] = useState<ApiProviderView>();
  const [apiStatusView, setApiStatusView] = useState<ApiStatusView>();
  const [testResult, setTestResult] = useState<ConnectionView>();
  const [saveMessage, setSaveMessage] = useState<string>();
  const [confirmApiDelete, setConfirmApiDelete] = useState(false);
  const [stepOverrides, setStepOverrides] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<'cancel' | 'diag' | 'rollback' | 'deploy' | null>(null);
  const [cancelPreview, setCancelPreview] = useState<CancelPreview>();
  const [rollbackPreview, setRollbackPreview] = useState<RollbackPreviewView>();
  const [cleanupOnCancel, setCleanupOnCancel] = useState(true);
  const [diagPreview, setDiagPreview] = useState<DiagPreview>();
  const [diagResult, setDiagResult] = useState<string>();
  const [qqStatus, setQqStatus] = useState<QqStatusView>();
  const [qqForm, setQqForm] = useState<QqSettingsView>();
  const [qqMeta, setQqMeta] = useState<QqSettingsPayloadView>();
  const [qqAppId, setQqAppId] = useState('');
  const [qqAppSecret, setQqAppSecret] = useState('');
  const [qqMessage, setQqMessage] = useState<string>();
  const [qqTail, setQqTail] = useState<string[]>([]);
  const [confirmQqUnbind, setConfirmQqUnbind] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const b = await api.bootstrap();
        setBoot(b);
        if (b.lastTask) setTask(b.lastTask);
        setKeyMask(b.apiStatus.keyMask);
        setApiStatusView(b.apiStatus);
        setApiForm(b.apiStatus.config ?? b.apiTemplate);
        setQqMeta(b.qqSettings);
        setQqForm(b.qqSettings.settings);
        setQqAppId(b.qqSettings.appId ?? '');
        setQqStatus(await api.qqStatus());
        const i = await api.harnessInfo();
        setInfo(i);
        setPlugins(i.plugins);
        // 只读检测放到后台，避免网络探测拖慢首屏；结果回来后立即刷新。
        void api
          .inspectEnv()
          .then((inspection) => {
            setEnv(inspection.environment);
            setDecision(inspection.decision);
          })
          .catch((e: unknown) => setError(readableError(e)));
      } catch (e) {
        setError(String(e));
      }
    })();
    return api.onTaskEvent((event) => {
      setStepOverrides((prev) => ({ ...prev, [event.stepId]: event.status }));
      setProgress(event.progress);
      if (event.status === 'running') setCurrentStep(event.message);
    });
  }, [api]);

  const mergeTask = useCallback((next?: TaskSummary) => {
    if (!next) return;
    setTask(next);
    setStepOverrides(Object.fromEntries(next.steps.map((s) => [s.id, s.status])));
  }, []);

  const refreshInfo = useCallback(async () => {
    const i = await api.harnessInfo();
    setInfo(i);
    setPlugins(i.plugins);
    if (i.task) mergeTask(i.task);
  }, [api, mergeTask]);

  /** QQ 状态依赖运行时证据，启动后按 4 秒轮询（状态本身走缓存，不会每次执行 plugin list）。
   *  只在「官方 QQ」页签可见时轮询：个人 QQ 面板有自己的快照推送，两套轮询不再同时运行。 */
  useEffect(() => {
    if (qqTab !== 'official') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [status, tail] = await Promise.all([api.qqStatus(), api.qqOutput()]);
        if (!cancelled) {
          setQqStatus(status);
          setQqTail(tail);
        }
      } catch {
        /* 轮询失败不打断界面 */
      }
    };
    void tick();
    const timer = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, qqTab]);

  const refreshQq = useCallback(
    async (refreshPlugins = false) => {
      const [status, meta] = await Promise.all([api.qqStatus(refreshPlugins), api.qqSettings()]);
      setQqStatus(status);
      setQqMeta(meta);
      setQqForm(meta.settings);
      if (meta.appId) setQqAppId(meta.appId);
      setQqTail(await api.qqOutput());
    },
    [api],
  );

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(undefined);
    }
  }, []);

  const scan = () =>
    run('scan', async () => {
      const inspection = await api.inspectEnv();
      setEnv(inspection.environment);
      setDecision(inspection.decision);
    });

  const openDeploy = () =>
    run('plan', async () => {
      const inspection = await api.inspectEnv();
      setEnv(inspection.environment);
      setDecision(inspection.decision);
      if (inspection.decision.blocked) {
        setError(`暂时不能部署：${inspection.decision.blockers.join('；')}`);
        return;
      }
      setDeployPlan(inspection.decision);
      setModal('deploy');
    });

  const choosePlan = (option: DecisionOptionView) =>
    run('choose', async () => {
      const next = await api.decideEnv(option.preferences);
      setDecision(next);
      if (next.blocked) {
        setError(`暂时不能部署：${next.blockers.join('；')}`);
        return;
      }
      setDeployPlan(next);
    });

  const cancelDeployPlan = () => {
    setModal(null);
    setDeployPlan(undefined);
    setNotice('已取消；没有执行任何安装、下载或修改。');
  };

  const waitForSettled = async (taskId: string) => {
    let current = await api.taskStatus(taskId);
    mergeTask(current);
    while (current && ['pending', 'running'].includes(current.status)) {
      await new Promise((r) => setTimeout(r, 800));
      current = await api.taskStatus(taskId);
      mergeTask(current);
    }
    await refreshInfo();
  };

  const deploy = () =>
    run('deploy', async () => {
      if (!deployPlan) {
        setError('没有可执行的安装方案，请先完成环境检测。');
        return;
      }
      setProgress(0);
      setNotice(undefined);
      const { taskId } = await api.startDeploy({
        planId: deployPlan.planId,
        confirmed: true,
        fresh: task?.status === 'succeeded',
      });
      setModal(null);
      setDeployPlan(undefined);
      void waitForSettled(taskId).then(async () => {
        const inspection = await api.inspectEnv();
        setEnv(inspection.environment);
        setDecision(inspection.decision);
      }).catch((e: unknown) => setError(readableError(e)));
    });

  const resume = () =>
    run('resume', async () => {
      if (!task) return;
      await api.resumeDeploy(task.taskId);
      void waitForSettled(task.taskId).catch((e: unknown) => setError(readableError(e)));
    });

  const pause = () =>
    run('pause', async () => {
      if (!task) return;
      const next = await api.pauseDeploy(task.taskId);
      mergeTask(next);
      // Only report a pause the main process actually performed: pausing a task that already
      // failed (or was left behind by a crash) does nothing, and saying "已暂停" would be a lie.
      if (next?.status === 'paused') {
        setNotice('已暂停。已完成的步骤会保留，点“继续”从下一步开始。');
        return;
      }
      setNotice(undefined);
      setError(`任务当前不在运行，无法暂停；实际状态：${TASK_LABEL[next?.status ?? ''] ?? '未知'}`);
    });

  const openCancel = () =>
    run('cancel-preview', async () => {
      if (!task) return;
      const preview = await api.cancelPreview(task.taskId);
      setCancelPreview(preview);
      setCleanupOnCancel(true);
      setModal('cancel');
    });

  const confirmCancel = () =>
    run('cancel', async () => {
      if (!task) return;
      const result = await api.cancelDeploy(task.taskId, cleanupOnCancel);
      mergeTask(result.summary);
      setModal(null);
      setNotice(
        result.cleanupSkipped
          ? '已取消，未清理任何文件（已完成的下载与运行时仍保留）。'
          : `已取消，并清理了本次任务创建的 ${result.cleaned.length} 个路径。你的其他数据未被改动；下载与包缓存会保留，以便下次安装更快。`,
      );
      await refreshInfo();
    });

  /** 危险操作：先取只读预览，弹窗确认后才真正删除。 */
  const openRollback = () =>
    run('rollback-preview', async () => {
      if (!task) return;
      const preview = await api.rollbackPreview(task.taskId);
      setRollbackPreview(preview);
      setModal('rollback');
    });

  const confirmRollback = () =>
    run('rollback', async () => {
      if (!task) return;
      const result = await api.rollback(task.taskId, true);
      mergeTask(result.summary);
      setModal(null);
      setNotice(result.message);
      if (!result.ok && result.refused.length > 0) {
        setError(`${result.refused.length} 个路径无法确认归属，已保留：\n${result.refused.map((r) => `${r.path}（${r.reason ?? '未知原因'}）`).join('\n')}`);
      }
      // 回滚会改变磁盘上的真实状态，必须重新读取环境与部署信息，而不是只改文案。
      const inspection = await api.inspectEnv();
      setEnv(inspection.environment);
      setDecision(inspection.decision);
      await refreshInfo();
    });

  const launch = () =>
    run('launch', async () => {
      const s = await api.launchHarness(0);
      setHealth(s.health);
      await refreshInfo();
      await refreshQq();
    });

  const qqSaveCredentials = () =>
    run('qq-save', async () => {
      setQqMessage(undefined);
      const result = await api.qqSaveCredentials({ appId: qqAppId, appSecret: qqAppSecret });
      setQqMessage([result.message, ...result.problems].filter(Boolean).join('；'));
      if (result.ok) {
        setQqAppSecret('');
        setConfirmQqUnbind(false);
      }
      await refreshQq(true);
      await refreshInfo();
    });

  const qqDeleteCredentials = () =>
    run('qq-unbind', async () => {
      const result = await api.qqDeleteCredentials();
      setQqMessage([result.message, ...result.problems].filter(Boolean).join('；'));
      setConfirmQqUnbind(false);
      setQqAppSecret('');
      await refreshQq(true);
      await refreshInfo();
    });

  const qqSaveSettings = () =>
    run('qq-settings', async () => {
      if (!qqForm) return;
      setQqMessage(undefined);
      const result = await api.qqSaveSettings({ settings: qqForm, mode: qqMeta?.credentialSource === 'profile' ? 'qr' : 'env' });
      setQqMessage([result.message, ...result.problems].filter(Boolean).join('；'));
      await refreshQq();
      await refreshInfo();
    });

  const qqStartBinding = (regenerate = false) =>
    run(regenerate ? 'qq-regen' : 'qq-bind', async () => {
      setQqMessage(undefined);
      const result = await api.qqStartBinding(regenerate);
      setQqMessage([result.message, ...result.problems].filter(Boolean).join('；'));
      await refreshQq();
      await refreshInfo();
    });

  const qqCancelBinding = () =>
    run('qq-cancel', async () => {
      const result = await api.qqCancelBinding();
      setQqMessage([result.message, ...result.problems].filter(Boolean).join('；'));
      await refreshQq(true);
      await refreshInfo();
    });

  const qqMigrate = () =>
    run('qq-migrate', async () => {
      const result = await api.qqMigrate(true);
      setQqMessage([result.message, ...result.problems].filter(Boolean).join('；'));
      await refreshQq(true);
    });

  const qqRepair = () =>
    run('qq-repair', async () => {
      setQqMessage(undefined);
      const result = await api.qqRepairPlugin();
      setQqMessage([result.message, ...result.problems].filter(Boolean).join('；'));
      await refreshQq(true);
      await refreshInfo();
    });

  const openDiag = () =>
    run('diag-preview', async () => {
      setDiagResult(undefined);
      setDiagPreview(await api.diagPreview());
      setModal('diag');
    });

  const confirmDiag = () =>
    run('diag-export', async () => {
      const r = await api.diagExport(true);
      setModal(null);
      if (!r.cancelled && r.zipPath) {
        setDiagResult(`已导出：${r.zipPath}（${r.entries ?? 0} 个文件，${((r.bytes ?? 0) / 1024).toFixed(1)} KB）`);
      }
    });

  const steps = useMemo(
    () => (task?.steps ?? []).map((s) => ({ ...s, status: stepOverrides[s.id] ?? s.status })),
    [task, stepOverrides],
  );

  const running = task?.status === 'running';
  const paused = task?.status === 'paused';
  const failed = task?.status === 'failed';
  const completedSteps = steps.filter((s) => s.status === 'succeeded' || s.status === 'skipped').length;
  const failure = failureCategory(task?.error);
  const stage = running ? currentStep ?? '准备中' : undefined;
  const routeClass =
    env?.route.kind === 'none' ? 'warn' : env?.route.kind === 'multiple' || env?.route.kind === 'unknown' ? 'bad' : 'ok';

  return (
    <div className="app">
      <header><h1>DeepSeek Deploy Assistant</h1><span className="muted">部署与配置助手</span></header>
      <nav className="navigation" aria-label="主导航">{([['home','首页'],['environment','环境检查'],['deploy','部署'],['model','模型配置'],['qq','QQ 接入'],['status','运行状态'],['finish','使用指南'],['diagnostics','故障诊断']] as const).map(([id,label]) => <button key={id} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{label}</button>)}</nav>
      {page === 'home' && <section className="card home"><h2>让 AI 助手准备就绪</h2><p>检查环境、部署助手，然后配置模型和 QQ。</p><div className="overview">
        <div><span>运行环境</span><strong>{!env ? '检测中' : decision?.blocked ? '需要处理' : '已检测'}</strong></div>
        <div><span>AI 助手程序</span><strong>{!info ? '未验证' : info.dshVersion ? '已安装' : '未安装'}</strong></div>
        <div><span>模型配置</span><strong>{!apiStatusView ? '未验证' : apiStatusView.configured ? '已配置，连接待验证' : '未配置'}</strong></div>
        <div><span>官方 QQ</span><strong>{!qqStatus ? '未验证' : QQ_PHASE_LABEL[qqStatus.phase].text}</strong></div>
        <div><span>插件资源</span><strong>尚未提供</strong></div></div>
        <div className="row"><button className="primary" onClick={() => setPage(task && ['paused','failed'].includes(task.status) ? 'deploy' : 'environment')}>{task && ['paused','failed'].includes(task.status) ? '继续未完成任务' : '开始部署'}</button><button onClick={() => setPage('diagnostics')}>故障诊断</button></div></section>}
      {page === 'finish' && <section className="card"><h2>开始使用</h2><p>真实 QQ 消息仍需自行验证。</p><div className="overview">
        <div><span>运行环境</span><strong>{!env ? '未验证' : decision?.blocked ? '需要处理' : '已检测'}</strong></div>
        <div><span>助手程序</span><strong>{!info ? '未验证' : info.dshVersion ? '已安装' : '未安装'}</strong></div>
        <div><span>模型</span><strong>{!apiStatusView ? '未验证' : apiStatusView.configured ? '已配置，连接待验证' : '未配置'}</strong></div>
        <div><span>官方 QQ</span><strong>{qqStatus ? QQ_PHASE_LABEL[qqStatus.phase].text : '未验证'}</strong></div>
        <div><span>官方 QQ 插件</span><strong>{!qqStatus ? '未验证' : qqStatus.pluginInstalled ? '已安装，加载待验证' : '未安装'}</strong></div>
      </div><h3>预制提示词</h3>{([
        ['初次使用引导','我是第一次使用 AI 助手。请用简单的中文介绍你能帮我做什么，并给我三个可以直接尝试的例子。'],
        ['AI 助手角色设置','请担任我的中文 AI 助手。先确认我的目标，再给出清晰、可执行的建议；不确定的信息请说明。'],
        ['日常办公助手','请帮助我处理日常办公任务。先了解背景和目标，再整理重点、提出下一步行动。'],
        ['文件处理助手','请帮助我整理文件。操作前先说明计划和涉及的文件，删除或覆盖内容前请征求我的确认。'],
        ['故障自查助手','我遇到了问题。请先询问现象和错误信息，再从安全、可撤销的检查开始逐步排查。']
      ] as const).map(([title,prompt]) => <div className="prompt" key={title}><div><strong>{title}</strong><p>{prompt}</p></div><button onClick={() => run('copy', async () => { await navigator.clipboard.writeText(prompt); setNotice('已复制：' + title); })}>复制</button></div>)}<div className="row"><button onClick={() => setPage('status')}>打开助手</button><button onClick={() => setPage('diagnostics')}>故障诊断</button><button onClick={() => setPage('home')}>返回首页</button></div></section>}

      {paused && (
        <div className="banner warn">
          已暂停（你主动暂停）。已完成 {completedSteps} / {steps.length} 步，点“继续”从下一步开始，已完成的步骤不会重跑。
        </div>
      )}
      {failed && (
        <div className="banner bad">
          部署失败：{task?.error ?? '未知原因'}。已完成 {completedSteps} / {steps.length} 步。失败不等于暂停：可以点“重试失败步骤”
          从失败的那一步继续，或先点“回滚本次创建…”清理本次部署产物。
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}

      {error && (
        <div className="card">
          <h2>错误</h2>
          <div className="error">{error}</div>
          <p>请检查错误信息后重试；如果问题持续，可导出脱敏诊断报告联系支持人员。</p><button onClick={() => setPage('diagnostics')}>打开故障诊断</button>
        </div>
      )}

      <div className="page-group">
        <section className="card" hidden={page !== 'environment'}>
          <h2>环境检查</h2><p>检查完成后，查看部署方案并确认。</p><div className="row"><button className="primary" onClick={() => setPage('deploy')}>下一步：部署</button></div>
          <div className="row">
            <button onClick={scan} disabled={Boolean(busy)}>
              {busy === 'scan' ? '检测中…' : '重新检测'}
            </button>
            {decision && (
              <span className={`badge ${DECISION_LABEL[decision.overall]?.cls ?? ''}`}>
                结论：{DECISION_LABEL[decision.overall]?.text ?? decision.overall}
              </span>
            )}
            {env && <span className={`badge ${routeClass}`}>路线：{env.route.kind}</span>}
            {env && <span className="muted">磁盘可用 {(env.diskFreeBytes / 1024 ** 3).toFixed(1)} GB</span>}
          </div>
          <p className="muted">这一步只读，不会修改你的电脑，也不会安装任何软件。</p>
          {decision && <p><b>{decisionHeadline(decision)}</b></p>}
          {decision && decision.blockers.length > 0 && (
            <div className="banner bad">
              {decision.blockers.map((b) => (
                <div key={b}>{b}</div>
              ))}
            </div>
          )}
          {decision && decision.warnings.length > 0 && (
            <div className="banner warn">
              {decision.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
          {env ? (
            <>
              <table>
                <thead>
                  <tr>
                    <th>组件</th>
                    <th>状态</th>
                    <th>版本</th>
                    <th>要求</th>
                  </tr>
                </thead>
                <tbody>
                  {env.components.map((c) => (
                    <tr key={c.id}>
                      <td>{c.label}</td>
                      <td>
                        <span className={`badge ${STATE_LABEL[c.state]?.cls ?? ''}`}>
                          {STATE_LABEL[c.state]?.text ?? c.state}
                        </span>
                      </td>
                      <td>{c.version ?? '—'}</td>
                      <td className="muted">{c.required}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="row wrap">
                {env.prerequisites.map((p) => (
                  <span key={p.id} className={`badge ${p.ok ? 'ok' : 'bad'}`} title={p.detail}>
                    {p.label}：{PREREQ_LABEL[p.state] ?? p.state}
                  </span>
                ))}
              </div>

              <details className="details">
                <summary>检测详情与证据（版本 / 路径 / 时间 / 原因）</summary>
                <table>
                  <thead>
                    <tr>
                      <th>组件</th>
                      <th>实际版本</th>
                      <th>安装路径</th>
                      <th>检测时间</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {env.components.map((c) => (
                      <tr key={c.id}>
                        <td>{c.label}</td>
                        <td>{c.version ?? '—'}</td>
                        <td className="path">{c.path ?? '—'}</td>
                        <td>{formatTime(c.checkedAt)}</td>
                        <td>{c.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {env.probeErrors.length > 0 && (
                  <div className="banner warn">
                    以下检测未能完成（不会被当作「未安装」）：
                    {env.probeErrors.map((e) => `${e.probe}: ${e.message}`).join('；')}
                  </div>
                )}
                <p className="muted">
                  Harness 配置目录：{env.resolution.profiles.home || '—'}（其存在：
                  {env.resolution.profiles.homeExists ? '是' : '否'}；web profile：
                  {env.resolution.profiles.webExists ? '已创建' : '未创建'}；desktop profile：
                  {env.resolution.profiles.desktopExists ? '存在（不修改）' : '不存在'}）
                </p>
                <pre className="evidence">
                  {env.components
                    .map((c) => `# ${c.label}\n${c.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.signal} = ${e.raw}`).join('\n')}`)
                    .join('\n\n')}
                </pre>
                <pre className="evidence">
                  {env.route.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.signal} = ${e.raw}`).join('\n')}
                </pre>
              </details>

              {decision && (
                <div className="decision-list">
                  <h3>安装建议</h3>
                  {decision.components
                    .filter((c) => c.component !== 'route' && !c.component.startsWith('prerequisite:') && c.action !== 'REUSE')
                    .map((c) => (
                      <p key={c.component}>
                        <span className={`badge ${DECISION_LABEL[c.action]?.cls ?? ''}`}>
                          {DECISION_LABEL[c.action]?.text ?? c.action}
                        </span>{' '}
                        <b>{c.label}</b>：{c.reason}
                      </p>
                    ))}
                  {decision.install.length === 0 && decision.modify.length === 0 && (
                    <p className="muted">已满足要求，无需安装或修改本软件自己的组件。</p>
                  )}
                </div>
              )}

              <p className="muted">
                {env.os.caption} · {env.os.arch} · {env.os.admin ? '管理员' : '普通用户'} · 检测时间 {formatTime(env.checkedAt)}
              </p>
            </>
          ) : (
            <div className="empty">正在读取真实环境…（这一步只读，不会改动任何文件）</div>
          )}
        </section>

        <section className="card" hidden={page !== 'status'}>
          <h2>运行状态</h2>
          <div className="row">
            <button className="primary" onClick={launch} disabled={Boolean(busy) || !info?.dshVersion}>
              {busy === 'launch' ? '启动中…' : '启动 Harness'}
            </button>
            <button
              onClick={() =>
                run('stop', async () => {
                  await api.stopHarness();
                  setHealth(undefined);
                })
              }
              disabled={Boolean(busy)}
            >
              停止
            </button>
            <button
              onClick={() =>
                run('status', async () => {
                  const s = await api.harnessStatus();
                  setHealth(s.health);
                  await refreshInfo();
                })
              }
              disabled={Boolean(busy)}
            >
              刷新状态
            </button>
            <button
              onClick={() =>
                run('open', async () => {
                  const r = await api.openHarness();
                  if (!r.ok) setError(r.reason ?? '打开失败');
                })
              }
              disabled={Boolean(busy)}
            >
              在浏览器打开
            </button>
          </div>
          <p className="muted">
            实际 Harness：<b>{info?.dshVersion ?? '未安装'}</b> · Node：{info?.nodeVersion ?? '未安装'} · profile：
            {info?.profile}（{info?.profileExists ? '已就绪' : '未创建'}）
          </p>
          {!info?.dshVersion && (
            <p className="muted">
              还不能启动：Harness 本体尚未安装。请先在第 3 节点“开始部署”（需要联网，约几分钟），部署成功后再回到这里启动。
            </p>
          )}
          {health ? (
            <>
              <p>
                <span className={`badge ${HEALTH_LABEL[health.level].cls}`}>{HEALTH_LABEL[health.level].text}</span>{' '}
                <span className="muted">{HEALTH_LABEL[health.level].hint}</span>
              </p>
              <p className="muted">
                {health.url} · HTTP {health.httpStatus ?? 0} · {health.detail}
              </p>
            </>
          ) : (
            <div className="empty">未启动。启动后会显示 存活 / 鉴权 / 可用 三级判定。</div>
          )}
        </section>
      </div>

      <section className="card" hidden={page !== 'deploy'}>
        <h2>部署助手</h2><div className="row"><button onClick={() => setPage('environment')}>上一步</button><button onClick={() => setPage('model')}>下一步：模型配置</button></div>
        <div className="row">
          <button className="primary" onClick={openDeploy} disabled={Boolean(busy) || running}>
            {busy === 'plan' ? '正在生成安装方案…' : task?.status === 'succeeded' ? '重新部署（修复）' : '开始部署'}
          </button>
          <button onClick={pause} disabled={Boolean(busy) || !running}>
            {busy === 'pause' ? '暂停中…' : '暂停'}
          </button>
          <button onClick={resume} disabled={Boolean(busy) || !(paused || failed)}>
            {busy === 'resume' ? '重试中…' : failed ? '重试失败步骤' : '继续'}
          </button>
          <button
            onClick={openCancel}
            disabled={Boolean(busy) || !task || !['running', 'paused', 'pending', 'failed'].includes(task.status)}
          >
            取消…
          </button>
          <button onClick={openRollback} disabled={Boolean(busy) || !task || running}>
            回滚本次创建…
          </button>
          {task && (
            <span
              className={`badge ${
                task.status === 'succeeded'
                  ? 'ok'
                  : ['paused', 'cancelled'].includes(task.status)
                    ? 'warn'
                    : task.status === 'failed'
                      ? 'bad'
                      : ''
              }`}
            >
              任务：{TASK_LABEL[task.status] ?? task.status}
            </span>
          )}
        </div>

        <div className="progress" role="progressbar" aria-label="部署进度" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completedSteps}>
          <div style={{ width: `${steps.length ? Math.round(completedSteps / steps.length * 100) : Math.round(progress * 100)}%` }} />
        </div><p>已完成 {completedSteps} / {steps.length} 步</p>
        <p className="muted">{stage ? `当前阶段：${stage}` : task?.status === 'succeeded' ? '全部步骤已完成' : '尚未开始'}</p>
        {decision?.blocked && (
          <p className="muted">
            当前环境存在阻塞项，部署按钮不会执行任何操作。处理后点「重新检测」。
          </p>
        )}

        {failure && (
          <div className="failure">
            <span className={`badge ${failure.cls}`}>{failure.label}</span>
            <span>{failure.hint}</span>
          </div>
        )}

        {steps.length ? (
          <ol className="steps">
            {steps.map((s) => (
              <li key={s.id}>
                <span
                  className={`step-status badge ${
                    s.status === 'succeeded'
                      ? 'ok'
                      : s.status === 'failed' || s.status === 'cancelled'
                        ? 'bad'
                        : s.status === 'skipped'
                          ? ''
                          : 'warn'
                  }`}
                >
                  {STATUS_LABEL[s.status] ?? s.status}
                </span>
                <span>
                  {s.title}
                  {s.message && <div className="muted">{s.message}</div>}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty">尚未开始。安装位置：{boot?.dataDir}</div>
        )}
        {task?.error && <div className="error">{task.error}</div>}
      </section>

      <div className="page-group">
        <section className="card" hidden={page !== 'qq'}>
          <h2>QQ 接入</h2><div className="row"><button onClick={() => setPage('model')}>上一步</button><button onClick={() => setPage('finish')}>查看使用指南</button></div>
          <div className="row">
            <button className={qqTab === 'official' ? 'primary' : ''} onClick={() => setQqTab('official')}>
              官方 QQ Bot
            </button>
            <button className={qqTab === 'personal' ? 'primary' : ''} onClick={() => setQqTab('personal')}>
              个人 QQ（SnowLuma）
            </button>
          </div>
          {qqTab === 'personal' && <PersonalQqPanel />}
          {qqTab === 'official' && (
            <>
          <p className="muted">
            只使用腾讯官方插件与官方授权（QQ Bot API v2）。本软件不实现 QQ 协议、不代替你登录，也不会把凭据上传到任何第三方。
          </p>

          <p>
            <span className={`badge ${qqStatus ? QQ_PHASE_LABEL[qqStatus.phase].cls : ''}`}>
              {qqStatus ? QQ_PHASE_LABEL[qqStatus.phase].text : '读取中…'}
            </span>{' '}
            <span className="muted">{qqStatus?.message}</span>
          </p>
          {qqStatus?.nextStep && <p className="muted">下一步：{qqStatus.nextStep}</p>}
          <p className="muted">
            插件：
            {qqStatus ? (qqStatus.pluginInstalled ? `已安装 ${qqStatus.pluginVersion ?? ''}` : '未安装') : '读取中…'} ·
            基线 {qqStatus?.expectedVersion ?? boot?.baseline.qqbot.version ?? '—'} · 凭据来源：
            {qqStatus?.credentialSource === 'dpapi'
              ? '本机加密存储'
              : qqStatus?.credentialSource === 'profile'
                ? '插件写入 profile（明文）'
                : qqStatus
                  ? '无'
                  : '读取中…'}
            {(qqStatus?.appId || boot?.qqSettings.appId) ? ` · AppID ${qqStatus?.appId ?? boot?.qqSettings.appId}` : ''}
          </p>

          <div className="row">
            <button onClick={() => run('qq-refresh', async () => void (await refreshQq(true)))} disabled={Boolean(busy)}>
              {busy === 'qq-refresh' ? '刷新中…' : '刷新状态'}
            </button>
            <button className="primary" onClick={qqRepair} disabled={Boolean(busy)}>
              {busy === 'qq-repair' ? '安装中…' : '安装 / 修复 QQ 插件'}
            </button>
            <button
              onClick={() => qqStartBinding(false)}
              disabled={Boolean(busy) || !qqStatus?.harnessInstalled || Boolean(qqMeta?.bindingMode)}
            >
              {busy === 'qq-bind' ? '正在申请二维码…' : '用官方扫码绑定'}
            </button>
            {qqMeta?.bindingMode && (
              <button onClick={qqCancelBinding} disabled={Boolean(busy)}>
                {busy === 'qq-cancel' ? '取消中…' : '取消扫码（用已保存的 AppID）'}
              </button>
            )}
          </div>

          {(qqStatus?.phase === 'binding' || (qqStatus?.phase === 'failed' && qqMeta?.bindingMode)) && (
            <div className="banner warn">
              <b>官方扫码授权</b>
              <p className="muted">{qqStatus.message}</p>
              {qqStatus.bindQr?.length ? (
                <pre className="qr">{qqStatus.bindQr.join('\n')}</pre>
              ) : (
                <p className="muted">二维码正在生成（通常 1–5 秒）；浏览器也会自动打开官方授权页。</p>
              )}
              {qqStatus.bindUrl && (
                <p className="muted" style={{ wordBreak: 'break-all' }}>
                  官方链接：{qqStatus.bindUrl}
                </p>
              )}
              <div className="row">
                {qqStatus.bindUrl && (
                  <button
                    onClick={() =>
                      run('qq-open', async () => {
                        const r = await api.qqOpenBind();
                        if (!r.ok) setQqMessage(r.reason ?? '打开失败');
                      })
                    }
                    disabled={Boolean(busy)}
                  >
                    用浏览器打开官方授权页
                  </button>
                )}
                <button onClick={() => qqStartBinding(true)} disabled={Boolean(busy)}>
                  {busy === 'qq-regen' ? '重新申请中…' : '重新生成二维码'}
                </button>
                <button onClick={qqCancelBinding} disabled={Boolean(busy)}>
                  取消扫码
                </button>
                {qqStatus.bindingAttempts ? (
                  <span className="muted">已尝试 {qqStatus.bindingAttempts} 次</span>
                ) : null}
              </div>
              {qqStatus.phase === 'failed' && <p className="muted">{qqStatus.nextStep}</p>}
              <p className="muted">
                扫码成功后，插件会把凭据写进它自己的配置文件（明文）；届时这里会出现「迁移到加密存储」按钮把它搬到 DPAPI。
                你的 AppID/AppSecret 不会被删除，点"取消扫码"即可回到原路径。
              </p>
            </div>
          )}

          <h3>授权（AppID / AppSecret）</h3>
          <div className="row">
            <input
              placeholder="AppID（QQ 开放平台 → 机器人 → 开发设置）"
              value={qqAppId}
              onChange={(e) => setQqAppId(e.target.value)}
              size={22}
            />
            <input
              placeholder={qqMeta?.appSecretMask ? `已保存（${qqMeta.appSecretMask}），留空则不变` : 'AppSecret'}
              value={qqAppSecret}
              type="password"
              onChange={(e) => setQqAppSecret(e.target.value)}
              size={24}
            />
            <button className="primary" onClick={qqSaveCredentials} disabled={Boolean(busy) || !qqAppId.trim()}>
              {busy === 'qq-save' ? '保存中…' : '保存并应用'}
            </button>
            {!confirmQqUnbind ? (
              <button onClick={() => setConfirmQqUnbind(true)} disabled={Boolean(busy) || qqStatus?.credentialSource === 'none'}>
                解绑…
              </button>
            ) : (
              <button className="danger" onClick={qqDeleteCredentials} disabled={Boolean(busy)}>
                确认解绑
              </button>
            )}
          </div>
          <p className="muted">
            凭据只以 Windows DPAPI 密文保存在本机，启动 Harness 时临时注入环境变量（<code>QQBOT_APPID</code>/
            <code>QQBOT_SECRET</code>），不写入任何明文配置文件，也不进日志与诊断包。
          </p>
          {qqMeta?.plaintextInProfile && (
            <div className="banner warn">
              <b>注意：</b>官方扫码流程成功后，插件会把 AppID/AppSecret <b>明文写入它自己的 profile 配置</b>
              （<code>{boot?.dataDir}\dsh-home\profiles\web\cordis.patch.yml</code>）。这是插件自身行为，不是本软件写入的。
              <div className="row">
                <button onClick={qqMigrate} disabled={Boolean(busy)}>
                  {busy === 'qq-migrate' ? '迁移中…' : '迁移到加密存储（清掉明文）'}
                </button>
              </div>
            </div>
          )}

          {qqForm && (
            <>
              <h3>消息与访问控制（插件真实支持的字段）</h3>
              <div className="row">
                <label>
                  <input
                    type="checkbox"
                    checked={qqForm.requireMention}
                    onChange={(e) => setQqForm({ ...qqForm, requireMention: e.target.checked })}
                  />{' '}
                  群聊需要 @机器人
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={qqForm.streaming}
                    onChange={(e) => setQqForm({ ...qqForm, streaming: e.target.checked })}
                  />{' '}
                  私聊流式回复（群聊始终不流式）
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={qqForm.mediaEnabled}
                    onChange={(e) => setQqForm({ ...qqForm, mediaEnabled: e.target.checked })}
                  />{' '}
                  接收图片/文件
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={qqForm.sendFileRestrictPaths}
                    onChange={(e) => setQqForm({ ...qqForm, sendFileRestrictPaths: e.target.checked })}
                  />{' '}
                  限制可发送文件路径
                </label>
              </div>
              <div className="row">
                <span className="muted">单条消息上限</span>
                <input
                  type="number"
                  min={100}
                  max={5000}
                  value={qqForm.textChunkLimit}
                  onChange={(e) => setQqForm({ ...qqForm, textChunkLimit: Number(e.target.value) })}
                />
                <span className="muted">群历史条数</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={qqForm.historyLimit}
                  onChange={(e) => setQqForm({ ...qqForm, historyLimit: Number(e.target.value) })}
                />
                <span className="muted">私聊</span>
                <select
                  value={qqForm.access.c2cMode}
                  onChange={(e) =>
                    setQqForm({
                      ...qqForm,
                      access: { ...qqForm.access, c2cMode: e.target.value as QqSettingsView['access']['c2cMode'] },
                    })
                  }
                >
                  <option value="open">所有人</option>
                  <option value="allowlist">仅白名单</option>
                  <option value="disabled">禁用</option>
                </select>
                <span className="muted">群聊</span>
                <select
                  value={qqForm.access.groupMode}
                  onChange={(e) =>
                    setQqForm({
                      ...qqForm,
                      access: { ...qqForm.access, groupMode: e.target.value as QqSettingsView['access']['groupMode'] },
                    })
                  }
                >
                  <option value="open">所有群</option>
                  <option value="allowlist">仅白名单群</option>
                  <option value="disabled">禁用</option>
                </select>
              </div>
              {qqForm.access.c2cMode === 'allowlist' && (
                <p className="muted">
                  私聊白名单（OpenID，逗号分隔）：
                  <input
                    size={60}
                    value={qqForm.access.c2cAllow.join(',')}
                    onChange={(e) =>
                      setQqForm({
                        ...qqForm,
                        access: { ...qqForm.access, c2cAllow: e.target.value.split(',').map((v) => v.trim()) },
                      })
                    }
                  />
                </p>
              )}
              {qqForm.access.groupMode === 'allowlist' && (
                <p className="muted">
                  群白名单（群 OpenID，逗号分隔）：
                  <input
                    size={60}
                    value={qqForm.access.groupAllow.join(',')}
                    onChange={(e) =>
                      setQqForm({
                        ...qqForm,
                        access: { ...qqForm.access, groupAllow: e.target.value.split(',').map((v) => v.trim()) },
                      })
                    }
                  />
                </p>
              )}
              <p className="muted">
                群聊额外提示词：
                <input
                  size={60}
                  value={qqForm.groupPrompt ?? ''}
                  onChange={(e) => setQqForm({ ...qqForm, groupPrompt: e.target.value })}
                />
              </p>
              <p className="muted">
                私聊额外提示词：
                <input
                  size={60}
                  value={qqForm.directPrompt ?? ''}
                  onChange={(e) => setQqForm({ ...qqForm, directPrompt: e.target.value })}
                />
              </p>
              <div className="row">
                <button className="primary" onClick={qqSaveSettings} disabled={Boolean(busy)}>
                  {busy === 'qq-settings' ? '保存中…' : '保存消息配置'}
                </button>
                <span className="muted">
                  写入 profile 的受管块（<code>im-qqbot</code>），并回读 Harness 组合配置确认生效；失败自动回滚。
                </span>
              </div>
            </>
          )}

          {qqMessage && <p className="muted">{qqMessage}</p>}

          {qqStatus?.evidence?.length ? (
            <details>
              <summary className="muted">状态依据（{qqStatus.evidence.length} 条运行时证据）</summary>
              <ul className="muted">
                {qqStatus.evidence.map((item, index) => (
                  <li key={`${item.at}-${index}`}>
                    {new Date(item.at).toLocaleTimeString()} · {item.source} · {item.line}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {qqTail.length > 0 && (
            <details>
              <summary className="muted">插件输出（最近 {qqTail.length} 行，已去控制字符）</summary>
              <pre className="evidence">{qqTail.join('\n')}</pre>
            </details>
          )}

          <p className="muted">
            {QQ_PLUGIN_DISTRIBUTION.notice}真实 QQ 收发（QQ-GATE-01）尚未验收，
            未验证项一律不标记为通过。
          </p>
            </>
          )}
        </section>

        <section className="card" hidden={page !== 'diagnostics'}>
          <h2>故障诊断</h2>
          <p>
            <span className="badge warn">{boot?.qqGate.id}：未通过</span>
          </p>
          <p className="muted">已验证：{boot?.qqGate.verified.join('、')}</p>
          <p className="muted">未验证：{boot?.qqGate.notVerified.join('、')}</p>
          <div className="row">
            <button onClick={openDiag} disabled={Boolean(busy)}>
              {busy === 'diag-preview' ? '收集内容…' : '导出诊断报告…'}
            </button>
            <button onClick={() => run('logs', async () => void (await api.openLogs()))} disabled={Boolean(busy)}>
              打开日志目录
            </button>
          </div>
          {diagResult && <p className="muted">{diagResult}</p>}
          <p className="muted">注册表源：{boot?.registry}</p>
        </section>
      </div>

      <section className="card" hidden={page !== 'model'}>
        <h2>模型配置</h2><div className="row"><button onClick={() => setPage('deploy')}>上一步</button><button onClick={() => setPage('qq')}>下一步：QQ 接入</button></div>
        <p className="muted">
          软件本身不提供、也不代理模型服务。请用你自己的 API Key：打开服务商控制台（DeepSeek 为
          platform.deepseek.com →「API keys」），创建一个 Key 后粘贴到下面。费用由服务商按用量收取。
          密钥只保存在本机（Windows DPAPI 加密），不会上传，也不会出现在日志或诊断包里。
        </p>

        {apiForm && (
          <>
            <div className="row">
              <span className="muted">服务类型</span>
              <select
                value={apiForm.template}
                onChange={(e) => {
                  const template = e.target.value as ApiProviderView['template'];
                  if (template === 'deepseek' && boot) {
                    setApiForm(boot.apiTemplate);
                  } else {
                    setApiForm({
                      template: 'openai-compatible',
                      label: '我的模型服务',
                      protocol: 'openai-completions',
                      baseUrl: 'https://',
                      model: '',
                      credentialRef: 'DDA_GATEWAY_KEY',
                      contextWindow: 131072,
                    });
                  }
                  setTestResult(undefined);
                  setSaveMessage(undefined);
                }}
                disabled={Boolean(busy)}
              >
                <option value="deepseek">DeepSeek 官方（推荐，已预填）</option>
                <option value="openai-compatible">其它兼容 OpenAI 的服务</option>
              </select>
              <span className="muted">名称</span>
              <input
                value={apiForm.label}
                onChange={(e) => setApiForm({ ...apiForm, label: e.target.value })}
                disabled={Boolean(busy)}
              />
            </div>

            <div className="row">
              <span className="muted">接口地址</span>
              <input
                value={apiForm.baseUrl}
                onChange={(e) => setApiForm({ ...apiForm, baseUrl: e.target.value })}
                readOnly={apiForm.template === 'deepseek'}
                disabled={Boolean(busy)}
              />
              <span className="muted">模型</span>
              {apiForm.template === 'deepseek' && boot ? (
                <select
                  value={apiForm.model}
                  onChange={(e) => setApiForm({ ...apiForm, model: e.target.value })}
                  disabled={Boolean(busy)}
                >
                  {boot.apiModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}（{model.name}）
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  placeholder="例如 gpt-4o-mini 或 deepseek-chat"
                  value={apiForm.model}
                  onChange={(e) => setApiForm({ ...apiForm, model: e.target.value })}
                  disabled={Boolean(busy)}
                />
              )}
            </div>

            <div className="row">
              <input
                type="password"
                placeholder={keyMask ? `已保存：${keyMask}（留空表示不修改）` : '粘贴 API Key（通常以 sk- 开头）'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                disabled={Boolean(busy)}
              />
              <button
                onClick={() =>
                  run('api-test', async () => {
                    const result = await api.apiTest({ config: apiForm, apiKey: apiKey || undefined });
                    setTestResult(result);
                    setSaveMessage(undefined);
                  })
                }
                disabled={Boolean(busy)}
              >
                {busy === 'api-test' ? '测试中…' : '测试连接'}
              </button>
              <button
                className="primary"
                onClick={() =>
                  run('api-save', async () => {
                    const result = await api.apiSave({ config: apiForm, apiKey: apiKey || undefined });
                    setSaveMessage(result.message);
                    if (result.status) {
                      setApiStatusView(result.status);
                      setKeyMask(result.status.keyMask);
                      if (result.status.config) setApiForm(result.status.config);
                    }
                    if (result.ok) setApiKey('');
                    else setTestResult(undefined);
                  })
                }
                disabled={Boolean(busy) || (!apiKey && !keyMask)}
              >
                {busy === 'api-save' ? '保存中…' : '保存并应用'}
              </button>
              <button
                onClick={() => setConfirmApiDelete(true)}
                disabled={Boolean(busy) || !apiStatusView?.configured}
              >
                删除配置
              </button>
            </div>

            <p className="muted">
              保存后会自动写入 Harness 的模型配置并回读校验（只改软件自己的配置块，不会动你其它设置）。
              当前状态：
              {apiStatusView?.configured ? (
                <span className="badge ok">已配置 {keyMask ?? ''}</span>
              ) : (
                <span className="badge warn">未配置</span>
              )}
              {apiStatusView && !apiStatusView.harnessInstalled && (
                <span className="muted"> · 尚未部署 Harness，配置会在部署后生效</span>
              )}
            </p>

            {testResult && (
              <div className="modal-body">
                <p>
                  <span className={`badge ${testResult.verdict === 'ok' ? 'ok' : 'bad'}`}>
                    {testResult.verdict === 'ok' ? '连接成功' : '连接失败'}
                  </span>{' '}
                  {testResult.message}
                </p>
                {testResult.nextStep && <p className="muted">下一步：{testResult.nextStep}</p>}
                {testResult.harness && (
                  <p className="muted">
                    Harness 配置回读：
                    {testResult.harness.ok ? '已生效（模型与服务均被识别）' : `未通过 — ${testResult.harness.problems.join('；')}`}
                  </p>
                )}
                <pre className="evidence">
                  {testResult.steps
                    .map((step) => `${step.ok ? '✓' : '✗'} ${step.stage}  ${step.millis}ms  ${step.detail}`)
                    .join('\n')}
                </pre>
              </div>
            )}
            {saveMessage && <p className="muted">{saveMessage}</p>}
            <p className="muted">
              配置位置：<code>{apiStatusView?.patchPath}</code> · 密钥：仅本机 DPAPI 加密保存（启动 Harness 时临时注入，不写入任何明文文件）
            </p>
          </>
        )}

        {confirmApiDelete && (
          <div className="modal-backdrop">
            <div className="modal">
              <h2>删除 API 配置？</h2>
              <p>会删除本机加密保存的密钥，并移除软件写入 Harness 的模型配置块。你其它的 Harness 设置不会被改动。</p>
              <div className="row">
                <button
                  className="primary"
                  onClick={() =>
                    run('api-delete', async () => {
                      const next = await api.apiDelete();
                      setApiStatusView(next);
                      setKeyMask(undefined);
                      setApiKey('');
                      setTestResult(undefined);
                      setSaveMessage('已删除本机密钥与软件写入的模型配置');
                      setConfirmApiDelete(false);
                      if (boot) setApiForm(boot.apiTemplate);
                    })
                  }
                  disabled={Boolean(busy)}
                >
                  确认删除
                </button>
                <button onClick={() => setConfirmApiDelete(false)} disabled={Boolean(busy)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {modal === 'deploy' && deployPlan && (
        <div className="modal-backdrop">
          <div className="modal wide">
            <h2>{deployPlan.needsChoice ? '请选择使用哪一套运行环境' : '确认本次部署'}</h2>
            {deployPlan.needsChoice ? (
              <>
                <p>
                  检测到多种可行方案。请明确选择一项；在你选择之前，本软件不会执行任何安装或修改。
                </p>
                <div className="modal-body">
                  {deployPlan.options.map((option) => (
                    <div className="option" key={option.id}>
                      <div>
                        <b>{option.label}</b>
                        <p className="muted">{option.description}</p>
                      </div>
                      <button
                        className="primary"
                        onClick={() => choosePlan(option)}
                        disabled={Boolean(busy)}
                      >
                        {busy === 'choose' ? '处理中…' : '使用此方案'}
                      </button>
                    </div>
                  ))}
                </div>
                <div className="row">
                  <button onClick={cancelDeployPlan} disabled={Boolean(busy)}>
                    取消（不执行任何操作）
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>请确认以下内容。点「确认并开始部署」之前，不会下载或修改任何文件。</p>
                <div className="modal-body">
                  <p>
                    <b>本次会安装：</b>
                    {deployPlan.install.length ? deployPlan.install.join('、') : '无'}
                  </p>
                  <p>
                    <b>本次会复用：</b>
                    {deployPlan.reuse.length ? deployPlan.reuse.join('、') : '无'}
                  </p>
                  <p>
                    <b>本次会修改：</b>
                    {deployPlan.modify.length ? deployPlan.modify.join('、') : '无（只新增本软件自己的目录）'}
                  </p>
                  <p>
                    <b>本次不会修改：</b>
                  </p>
                  <ul>
                    {deployPlan.untouched.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p>
                    <b>安装位置：</b>
                    <code>{boot?.dataDir ?? '本软件数据目录'}</code>
                  </p>
                  <p>
                    <b>预计占用：</b>约 150–350 MB（下载约 50–150 MB；首次下载还取决于网络，通常几分钟）。
                  </p>
                  <p>
                    <b>管理员权限：</b>不需要（{deployPlan.requiresAdmin ? '本方案需要管理员，请勿继续' : '全程按当前用户安装'}）
                  </p>
                  <p>
                    <b>联网：</b>
                    {deployPlan.requiresNetwork
                      ? '需要（下载运行时与依赖）'
                      : '运行环境已复用；QQ 插件若尚未安装，最后一步仍会联网安装'}
                  </p>
                  {deployPlan.runtime && (
                    <p className="muted">
                      实际使用：Node {deployPlan.runtime.node.mode === 'system' ? '复用系统已有' : '本软件私有'}{' '}
                      {deployPlan.runtime.node.version ?? ''}；Harness{' '}
                      {deployPlan.runtime.harness.mode === 'system' ? '复用系统已有' : '本软件私有'}
                    </p>
                  )}
                  <p>
                    <b>失败后如何恢复：</b>
                    {deployPlan.recovery}
                  </p>
                </div>
                <div className="row">
                  <button className="primary" onClick={deploy} disabled={Boolean(busy) || deployPlan.requiresAdmin}>
                    {busy === 'deploy' ? '部署中…' : '确认并开始部署'}
                  </button>
                  <button onClick={cancelDeployPlan} disabled={Boolean(busy)}>
                    取消（不执行任何操作）
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {modal === 'cancel' && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>取消部署？</h2>
            <p>任务会立即停止（当前步骤完成后生效）。已完成的步骤会保留，可稍后“继续”。</p>
            <div className="modal-body">
              <label className="row">
                <input
                  type="checkbox"
                  checked={cleanupOnCancel}
                  onChange={(e) => setCleanupOnCancel(e.target.checked)}
                />
                同时清理本次任务创建的文件（推荐）
              </label>
              <p className="muted">
                只会删除本次任务记录下的 {cancelPreview?.count ?? 0} 个路径（当前存在 {cancelPreview?.existing.length ?? 0} 个）。
                你原有的 Harness、profile、API 配置与其他数据不会被改动。
              </p>
              <pre className="evidence">
                {(cancelPreview?.paths.slice(0, 12) ?? []).join('\n') || '（本次任务尚未创建任何文件）'}
                {(cancelPreview?.paths.length ?? 0) > 12 ? '\n…' : ''}
              </pre>
            </div>
            <div className="row">
              <button className="primary" onClick={confirmCancel} disabled={Boolean(busy)}>
                {busy === 'cancel' ? '取消中…' : '确认取消'}
              </button>
              <button onClick={() => setModal(null)} disabled={Boolean(busy)}>
                继续部署
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === 'rollback' && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>回滚本次部署创建的内容？</h2>
            <p>
              这会<strong>永久删除</strong>本次部署任务记录在案的产物（Node 运行时、pnpm、Harness 安装目录、下载缓存等）。
              删除后 Harness 将无法启动，需要重新部署。
            </p>
            <div className="modal-body">
              <p className="muted">
                将删除 <b>{rollbackPreview?.deletableCount ?? 0}</b> 个路径（共记录{' '}
                {rollbackPreview?.entries.length ?? 0} 个，当前存在 {rollbackPreview?.existingCount ?? 0} 个）。
              </p>
              <pre className="evidence">
                {(rollbackPreview?.entries ?? [])
                  .map((e) => `${e.deletable && e.exists ? '×' : '·'} ${e.path}${e.deletable ? '' : `（保留：${e.reason ?? '无法确认归属'}）`}`)
                  .join('\n') || '（本次任务没有记录任何产物）'}
              </pre>
              <p className="muted">
                只删除上面带 × 的路径，且必须位于本软件的管理目录内（{rollbackPreview?.roots.join('、')}）。
                你自己的 Harness profile、API 配置、QQ 凭据与其他数据不在删除范围内；无法确认归属的路径一律保留。
              </p>
            </div>
            <div className="row">
              <button
                className="primary"
                onClick={confirmRollback}
                disabled={Boolean(busy) || (rollbackPreview?.deletableCount ?? 0) === 0}
              >
                {busy === 'rollback' ? '回滚中…' : '确认回滚并删除'}
              </button>
              <button onClick={() => setModal(null)} disabled={Boolean(busy)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === 'diag' && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>导出诊断报告</h2>
            <p className="muted">{diagPreview?.warning}</p>
            <div className="modal-body">
              <p>
                将包含以下 {diagPreview?.entries.length ?? 0} 个文件（合计约{' '}
                {((diagPreview?.totalBytes ?? 0) / 1024).toFixed(1)} KB），保存到：
                <br />
                <code>{diagPreview?.targetDir}</code>
              </p>
              <pre className="evidence">{(diagPreview?.entries ?? []).join('\n')}</pre>
            </div>
            <div className="row">
              <button className="primary" onClick={confirmDiag} disabled={Boolean(busy)}>
                {busy === 'diag-export' ? '导出中…' : '确认导出'}
              </button>
              <button onClick={() => setModal(null)} disabled={Boolean(busy)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
