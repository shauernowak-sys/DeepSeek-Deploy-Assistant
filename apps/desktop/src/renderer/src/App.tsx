import { useCallback, useEffect, useMemo, useState } from 'react';

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

interface EnvReport {
  os: { caption: string; arch: string; admin: boolean };
  diskFreeBytes: number;
  runtimes: { id: string; installed: boolean; version?: string; path?: string }[];
  route: { kind: string; evidence: { signal: string; ok: boolean; raw: string }[]; dshHome?: string };
  checkedAt: string;
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
}

interface CancelPreview {
  paths: string[];
  existing: string[];
  count: number;
}

interface DiagPreview {
  entries: string[];
  totalBytes: number;
  targetDir: string;
  warning: string;
}

type Api = {
  bootstrap: () => Promise<Bootstrap>;
  scanEnv: () => Promise<EnvReport>;
  startDeploy: (fresh?: boolean) => Promise<{ taskId: string }>;
  resumeDeploy: (taskId: string) => Promise<{ taskId: string }>;
  taskStatus: (taskId: string) => Promise<TaskSummary | undefined>;
  pauseDeploy: (taskId: string) => Promise<TaskSummary | undefined>;
  cancelPreview: (taskId: string) => Promise<CancelPreview>;
  cancelDeploy: (
    taskId: string,
    cleanup: boolean,
  ) => Promise<{ summary?: TaskSummary; cleaned: string[]; cleanupSkipped: boolean }>;
  rollback: (taskId: string) => Promise<TaskSummary>;
  launchHarness: (port?: number) => Promise<{ running: boolean; url?: string; health?: HealthReport }>;
  stopHarness: () => Promise<{ ok: boolean }>;
  harnessStatus: () => Promise<{ running: boolean; url?: string; health?: HealthReport }>;
  harnessInfo: () => Promise<HarnessInfo>;
  openHarness: () => Promise<{ ok: boolean; reason?: string }>;
  listPlugins: () => Promise<Plugin[]>;
  installQqPlugin: () => Promise<Plugin[]>;
  setApiKey: (value: string) => Promise<{ masked: string }>;
  secretStatus: () => Promise<{ deepseekApiKey?: string }>;
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
  failed: '失败',
  cancelled: '已取消',
  'rolled-back': '已回滚',
};

const HEALTH_LABEL: Record<HealthReport['level'], { text: string; cls: string; hint: string }> = {
  down: { text: '不可达', cls: 'bad', hint: '进程未启动或端口未监听' },
  alive: { text: '存活（未鉴权）', cls: 'warn', hint: 'HTTP 401 说明服务在线，但还不能证明可用' },
  authorized: { text: '鉴权通过', cls: 'warn', hint: 'token 已被接受，但业务就绪未证实' },
  usable: { text: '可用', cls: 'ok', hint: '已返回应用外壳' },
};

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

export function App(): JSX.Element {
  const api = window.dda;
  const [boot, setBoot] = useState<Bootstrap>();
  const [env, setEnv] = useState<EnvReport>();
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
  const [stepOverrides, setStepOverrides] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<'cancel' | 'diag' | null>(null);
  const [cancelPreview, setCancelPreview] = useState<CancelPreview>();
  const [cleanupOnCancel, setCleanupOnCancel] = useState(true);
  const [diagPreview, setDiagPreview] = useState<DiagPreview>();
  const [diagResult, setDiagResult] = useState<string>();

  useEffect(() => {
    void (async () => {
      try {
        const b = await api.bootstrap();
        setBoot(b);
        if (b.lastTask) setTask(b.lastTask);
        setKeyMask((await api.secretStatus()).deepseekApiKey);
        const i = await api.harnessInfo();
        setInfo(i);
        setPlugins(i.plugins);
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

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }, []);

  const scan = () =>
    run('scan', async () => {
      setEnv(await api.scanEnv());
    });

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
      setProgress(0);
      setNotice(undefined);
      const { taskId } = await api.startDeploy(task?.status === 'succeeded');
      await waitForSettled(taskId);
    });

  const resume = () =>
    run('resume', async () => {
      if (!task) return;
      await api.resumeDeploy(task.taskId);
      await waitForSettled(task.taskId);
    });

  const pause = () =>
    run('pause', async () => {
      if (!task) return;
      mergeTask(await api.pauseDeploy(task.taskId));
      setNotice('已暂停。已完成的步骤会保留，点“继续”从下一步开始。');
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

  const rollback = () =>
    run('rollback', async () => {
      if (!task) return;
      mergeTask(await api.rollback(task.taskId));
      setNotice('已回滚本次任务创建的内容。');
    });

  const launch = () =>
    run('launch', async () => {
      const s = await api.launchHarness(0);
      setHealth(s.health);
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
  const failure = failureCategory(task?.error);
  const stage = running ? currentStep ?? '准备中' : undefined;
  const routeClass =
    env?.route.kind === 'none' ? 'warn' : env?.route.kind === 'multiple' || env?.route.kind === 'unknown' ? 'bad' : 'ok';

  return (
    <div className="app">
      <header>
        <h1>DeepSeek Deploy Assistant</h1>
        <span className="badge">M2 原型 · {boot?.appVersion ?? '…'}</span>
        <span className="badge warn">QQ-GATE-01 未通过</span>
        <span className="muted">
          基线：Node {boot?.baseline.node.version} · pnpm {boot?.baseline.pnpm.version} · dsh{' '}
          {boot?.baseline.dsh.version} · profile {boot?.baseline.dsh.profile}
        </span>
      </header>

      {paused && (
        <div className="banner warn">
          有未完成的部署任务（{task?.pausedByUser ? '你已暂停' : '上次中断'}）。已完成 {steps.filter((s) => s.status === 'succeeded' || s.status === 'skipped').length} /{' '}
          {steps.length} 步，点“继续”即可从下一步开始。
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}

      {error && (
        <div className="card">
          <h2>错误</h2>
          <div className="error">{error}</div>
          <p className="muted">可点“导出诊断报告”把已脱敏的日志交给支持人员。</p>
        </div>
      )}

      <div className="grid">
        <section className="card">
          <h2>1. 环境检测</h2>
          <div className="row">
            <button onClick={scan} disabled={Boolean(busy)}>
              {busy === 'scan' ? '检测中…' : '检测环境'}
            </button>
            {env && <span className={`badge ${routeClass}`}>路线：{env.route.kind}</span>}
            {env && <span className="muted">磁盘可用 {(env.diskFreeBytes / 1024 ** 3).toFixed(1)} GB</span>}
          </div>
          {env ? (
            <>
              <table>
                <thead>
                  <tr>
                    <th>组件</th>
                    <th>状态</th>
                    <th>版本</th>
                  </tr>
                </thead>
                <tbody>
                  {env.runtimes.map((r) => (
                    <tr key={r.id}>
                      <td>{r.id}</td>
                      <td>{r.installed ? '已就绪' : '未安装'}</td>
                      <td>{r.version ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">
                {env.os.caption} · {env.os.arch} · {env.os.admin ? '管理员' : '普通用户'}
              </p>
              <pre className="evidence">
                {env.route.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.signal} = ${e.raw}`).join('\n')}
              </pre>
            </>
          ) : (
            <div className="empty">尚未检测。检测只读，不会改动任何文件。</div>
          )}
        </section>

        <section className="card">
          <h2>2. 运行状态</h2>
          <div className="row">
            <button className="primary" onClick={launch} disabled={Boolean(busy)}>
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

      <section className="card">
        <h2>3. 部署（Node → pnpm → Harness → web profile → QQ 插件）</h2>
        <div className="row">
          <button className="primary" onClick={deploy} disabled={Boolean(busy) || running}>
            {busy === 'deploy' ? '部署中…' : task?.status === 'succeeded' ? '重新部署（修复）' : '开始部署'}
          </button>
          <button onClick={pause} disabled={Boolean(busy) || !running}>
            {busy === 'pause' ? '暂停中…' : '暂停'}
          </button>
          <button onClick={resume} disabled={Boolean(busy) || !paused}>
            {busy === 'resume' ? '继续中…' : '继续'}
          </button>
          <button onClick={openCancel} disabled={Boolean(busy) || !task || !['running', 'paused', 'pending'].includes(task.status)}>
            取消…
          </button>
          <button onClick={rollback} disabled={Boolean(busy) || !task || running}>
            回滚本次创建
          </button>
          {task && (
            <span className={`badge ${task.status === 'succeeded' ? 'ok' : ['paused', 'cancelled'].includes(task.status) ? 'warn' : ''}`}>
              任务：{TASK_LABEL[task.status] ?? task.status}
            </span>
          )}
        </div>

        <div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="muted">{stage ? `当前阶段：${stage}` : task?.status === 'succeeded' ? '全部步骤已完成' : '尚未开始'}</p>

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

      <div className="grid">
        <section className="card">
          <h2>4. 插件</h2>
          <div className="row">
            <button
              onClick={() =>
                run('list', async () => {
                  setPlugins(await api.listPlugins());
                })
              }
              disabled={Boolean(busy)}
            >
              刷新列表
            </button>
            <button
              className="primary"
              onClick={() =>
                run('install', async () => {
                  setPlugins(await api.installQqPlugin());
                })
              }
              disabled={Boolean(busy)}
            >
              安装 QQ 插件
            </button>
          </div>
          {plugins.length ? (
            <table>
              <thead>
                <tr>
                  <th>插件</th>
                  <th>版本</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {plugins.map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td>{p.version ?? '—'}</td>
                    <td>{health?.level === 'usable' ? '已加载（连接未验证）' : '已安装'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">未读取到插件。</div>
          )}
          <p className="muted">
            QQ 插件的运行时依赖 qqbot-connector 为 UNLICENSED：仅在线安装，不打包、不镜像。真实收发未验证（QQ-GATE-01）。
          </p>
        </section>

        <section className="card">
          <h2>5. 验收门禁与诊断</h2>
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

      <section className="card">
        <h2>6. DeepSeek API Key（可选，仅存本机 DPAPI）</h2>
        <div className="row">
          <input
            type="password"
            placeholder="sk-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
          <button
            onClick={() =>
              run('secret', async () => {
                const r = await api.setApiKey(apiKey);
                setKeyMask(r.masked);
                setApiKey('');
              })
            }
            disabled={Boolean(busy) || apiKey.length < 8}
          >
            保存
          </button>
          <span className="muted">当前：{keyMask ?? '未设置'}</span>
        </div>
        <p className="muted">连接测试与写入 Harness 配置尚未实现（见 PRD §11），本原型不调用模型接口。</p>
      </section>

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
