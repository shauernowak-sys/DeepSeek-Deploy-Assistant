import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SetupIllustration } from './SetupIllustration';

import type {
  InstallVerification,
  PersonalQqGuide,
  PersonalQqStatus,
  SnowLumaConfigInspection,
  SnowLumaDeploySnapshot,
  SnowLumaInstallDiscovery,
  SnowLumaProcessStatus,
  SnowLumaStepId,
  SnowLumaStepState,
  SnowLumaStepStatus,
} from '@dda/spec';

/**
 * 个人 QQ（SnowLuma）引导。
 *
 * 三步，和软件实际会做的事对齐：
 *  1 从官方发布页下载、校验、安装并启动 SnowLuma
 *  2 用户本人扫码登录
 *  3 安装连接插件并打开 DeepSeek 助手
 *
 * 界面只读主进程快照。OneBot 令牌不进入渲染层，初始口令只在用户点击后展示。
 */

interface ActionResult {
  ok: boolean;
  message?: string;
  nextStep?: string;
}

interface DdaApi {
  personalStatus(): Promise<PersonalQqStatus>;
  personalGuide(): Promise<PersonalQqGuide>;
  personalInstallAdapter(): Promise<ActionResult>;
  personalPushBridge(): Promise<ActionResult>;
  personalBindPrivate(sessionId: string, uin: string): Promise<ActionResult>;
  personalAutoBind(): Promise<ActionResult>;
  personalOpen(target: 'project' | 'releases' | 'license' | 'eula' | 'webui'): Promise<{ ok: boolean }>;
  personalPickInstallDir(): Promise<{ ok: boolean; installDir?: string }>;
  deployStatus(): Promise<SnowLumaDeploySnapshot>;
  deployProcess(): Promise<SnowLumaProcessStatus>;
  deployOutput(): Promise<string[]>;
  installDiscovery(): Promise<SnowLumaInstallDiscovery>;
  installVerify(installDir?: string): Promise<InstallVerification>;
  installUse(
    installDir: string,
  ): Promise<{ ok: boolean; verification: InstallVerification; message: string }>;
  deployStart(input?: { repair?: boolean }): Promise<SnowLumaDeploySnapshot>;
  deployStep(stepId: string): Promise<SnowLumaDeploySnapshot>;
  launchHarness(port?: number): Promise<{ running: boolean; url?: string }>;
  openHarness(): Promise<{ ok: boolean; reason?: string }>;
  deployCancel(): Promise<SnowLumaDeploySnapshot>;
  deployStop(): Promise<{ ok: boolean; message: string }>;
  deployCredentials(): Promise<{ user: string; password: string } | undefined>;
  deployConfig(): Promise<SnowLumaConfigInspection>;
  deployConfigBackups(): Promise<{ name: string; path: string }[]>;
  deployConfigRestore(name: string): Promise<{ ok: boolean; evidence: string[] }>;
  personalUninstall(input: unknown): Promise<{ ok: boolean; actions: string[]; refusedReason?: string }>;
  personalOpenInstallDir(): Promise<{ ok: boolean; path: string }>;
  onDeployEvent(handler: (snapshot: unknown) => void): () => void;
}

const api = (window as unknown as { dda: DdaApi }).dda;

const PHASE_LABEL: Record<string, { text: string; cls: string }> = {
  'qq-missing': { text: '缺少 QQ 客户端', cls: 'warn' },
  'qq-not-running': { text: 'QQ 未启动', cls: 'warn' },
  'snowluma-not-installed': { text: 'SnowLuma 未安装', cls: '' },
  'snowluma-installed': { text: '已安装，未运行', cls: '' },
  'snowluma-running': { text: '运行中，待登录', cls: 'warn' },
  'snowluma-logged-in': { text: '已登录，待联通', cls: 'warn' },
  'harness-linked': { text: '已联通助手', cls: 'ok' },
  'message-verified': { text: '消息链路已验证', cls: 'ok' },
  failed: { text: '检测失败', cls: 'warn' },
};

const STEP_STATUS_LABEL: Record<SnowLumaStepStatus, { text: string; cls: string }> = {
  idle: { text: '未开始', cls: '' },
  running: { text: '进行中', cls: 'warn' },
  waiting: { text: '等待操作', cls: 'warn' },
  done: { text: '已完成', cls: 'ok' },
  failed: { text: '失败', cls: 'bad' },
  blocked: { text: '未执行', cls: 'bad' },
  cancelled: { text: '已取消', cls: '' },
  skipped: { text: '已跳过', cls: '' },
};

const WIZARD = [
  { key: 'install', title: '安装 SnowLuma' },
  { key: 'login', title: '登录 QQ' },
  { key: 'link', title: '打开助手' },
] as const;

type WizardKey = (typeof WIZARD)[number]['key'];

const PIPELINE: { id: SnowLumaStepId; title: string }[] = [
  { id: 'precheck', title: '检查电脑 QQ' },
  { id: 'release', title: '核对官方版本' },
  { id: 'download', title: '下载安装包' },
  { id: 'install', title: '解压安装' },
  { id: 'configure', title: '写入连接配置' },
  { id: 'start', title: '启动 SnowLuma' },
];

function Flag({ ok, yes = '是', no = '否' }: { ok: boolean; yes?: string; no?: string }): JSX.Element {
  return <span className={ok ? 'badge ok' : 'badge warn'}>{ok ? yes : no}</span>;
}

function bytes(value?: number): string {
  if (value === undefined) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function progressLine(step?: SnowLumaStepState): string | undefined {
  const progress = step?.progress;
  if (!progress) return undefined;
  if (progress.percent !== undefined) return `${Math.round(progress.percent)}%`;
  if (progress.totalBytes) return `${bytes(progress.receivedBytes)} / ${bytes(progress.totalBytes)}`;
  if (progress.receivedBytes > 0) return `已接收 ${bytes(progress.receivedBytes)}`;
  return undefined;
}

export function PersonalQqPanel(): JSX.Element {
  const [status, setStatus] = useState<PersonalQqStatus>();
  const [guide, setGuide] = useState<PersonalQqGuide>();
  const [snapshot, setSnapshot] = useState<SnowLumaDeploySnapshot>();
  const [processInfo, setProcessInfo] = useState<SnowLumaProcessStatus>();
  const [discovery, setDiscovery] = useState<SnowLumaInstallDiscovery>();
  const [verification, setVerification] = useState<InstallVerification>();
  const [config, setConfig] = useState<SnowLumaConfigInspection>();
  const [backups, setBackups] = useState<{ name: string; path: string }[]>([]);
  const [output, setOutput] = useState<string[]>([]);
  const [credentials, setCredentials] = useState<{ user: string; password: string }>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [tab, setTab] = useState<WizardKey>('install');
  const [sessionId, setSessionId] = useState('');
  const [uin, setUin] = useState('');
  const [uninstall, setUninstall] = useState({
    removeOurState: true,
    removeComponent: false,
    removeConfig: false,
    removeUserData: false,
    confirm: false,
  });
  const sawRunning = useRef(false);

  const refresh = useCallback(async () => {
    const [next, g, deploy, proc, disc] = await Promise.all([
      api.personalStatus(),
      api.personalGuide(),
      api.deployStatus(),
      api.deployProcess(),
      api.installDiscovery(),
    ]);
    setStatus(next);
    setGuide(g);
    setSnapshot(deploy);
    setProcessInfo(proc);
    setDiscovery(disc);
    setVerification(disc.selected ?? (await api.installVerify(deploy.installDir)));
    if (next.service.loginUin) setUin((prev) => prev || next.service.loginUin!);
    if (next.bridge?.sessionIds?.length === 1) setSessionId((prev) => prev || next.bridge!.sessionIds![0]!);
  }, []);

  const loadAdvanced = useCallback(async () => {
    const [cfg, files, tail] = await Promise.all([
      api.deployConfig(),
      api.deployConfigBackups(),
      api.deployOutput(),
    ]);
    setConfig(cfg);
    setBackups(files);
    setOutput(tail);
  }, []);

  const load = useCallback(async () => {
    setBusy('refresh');
    try {
      await refresh();
    } catch (error) {
      setNotice(`读取状态失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  useEffect(() => {
    void load();
    const off = api.onDeployEvent((payload) => {
      setSnapshot(payload as SnowLumaDeploySnapshot);
      void api.deployProcess().then(setProcessInfo).catch(() => undefined);
    });
    return off;
  }, [load]);

  useEffect(() => {
    if (snapshot?.status === 'running') {
      sawRunning.current = true;
      return;
    }
    if (!sawRunning.current || tab !== 'install' || !snapshot) return;
    const start = snapshot.steps.find((step) => step.id === 'start');
    const stopped = snapshot.steps.some((step) => step.status === 'failed' || step.status === 'cancelled');
    sawRunning.current = false;
    if (start?.status === 'done' && !stopped) setTab('login');
  }, [snapshot, tab]);

  useEffect(() => {
    if (tab !== 'login') return;
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [tab, refresh]);

  const run = async (key: string, action: () => Promise<unknown>, message?: string) => {
    setBusy(key);
    setNotice(undefined);
    try {
      const result = (await action()) as ActionResult | undefined;
      if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
        setNotice([result.message, result.nextStep].filter(Boolean).join(' '));
      } else if (message) {
        setNotice(message);
      } else if (result && typeof result === 'object' && result.message) {
        setNotice(result.message);
      }
      await refresh();
    } catch (error) {
      setNotice(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(undefined);
    }
  };

  const stepOf = useCallback(
    (id: string): SnowLumaStepState | undefined => snapshot?.steps.find((step) => step.id === id),
    [snapshot],
  );

  const phase = status ? PHASE_LABEL[status.phase] ?? { text: status.phase, cls: '' } : undefined;
  const open = (target: 'project' | 'releases' | 'license' | 'eula' | 'webui') => void api.personalOpen(target);
  const installed = Boolean(verification?.valid || status?.component.installed);
  const running = Boolean(processInfo?.running);
  const loggedIn = Boolean(status?.service.onebotResponsive && status?.service.loginUin);
  const deploying = snapshot?.status === 'running';
  const tabIndex = WIZARD.findIndex((item) => item.key === tab);

  const wizardState = useMemo(() => {
    return WIZARD.map((item) => {
      if (item.key === 'install') {
        const steps = PIPELINE.map((entry) => stepOf(entry.id)).filter((step): step is SnowLumaStepState => Boolean(step));
        let state: SnowLumaStepStatus = 'idle';
        if (steps.some((step) => step.status === 'failed')) state = 'failed';
        else if (deploying) state = 'running';
        else if (installed || stepOf('start')?.status === 'done') state = 'done';
        else if (verification?.exists) state = 'waiting';
        return { ...item, status: state };
      }
      if (item.key === 'login') {
        const state: SnowLumaStepStatus = loggedIn ? 'done' : running || status?.service.webuiReachable ? 'waiting' : 'idle';
        return { ...item, status: state };
      }
      const linked = status?.phase === 'harness-linked' || status?.phase === 'message-verified' || stepOf('link')?.status === 'done';
      const state: SnowLumaStepStatus = linked
        ? 'done'
        : stepOf('link')?.status === 'failed'
          ? 'failed'
          : status?.adapter.installed
            ? 'waiting'
            : 'idle';
      return { ...item, status: state };
    });
  }, [deploying, installed, loggedIn, running, status, stepOf, verification?.exists]);

  const recheckInstall = async () => {
    await run('install-recheck', async () => {
      const disc = await api.installDiscovery();
      setDiscovery(disc);
      if (disc.selected) {
        setVerification(disc.selected);
        return {
          ok: disc.selected.valid,
          message: disc.selected.valid
            ? `已找到并校验通过：${disc.selected.installDir}（v${disc.selected.version}）`
            : `已找到 ${disc.selected.installDir}，但校验未通过：${disc.selected.problems[0] ?? '未知问题'}`,
        } as ActionResult;
      }
      const single = await api.installVerify();
      setVerification(single);
      return {
        ok: false,
        message: single.exists
          ? `已找到 ${single.installDir}，但校验未通过：${single.problems[0] ?? '未知问题'}`
          : '没有在常见位置找到 SnowLuma。请点「选择文件夹」，选到含 release.json 的那一层。',
      } as ActionResult;
    });
  };

  const pickInstallDir = async () => {
    const picked = await api.personalPickInstallDir();
    if (!picked.ok || !picked.installDir) return;
    await run('install-use', async () => {
      const result = await api.installUse(picked.installDir!);
      setVerification(result.verification);
      return { ok: result.ok, message: result.message } as ActionResult;
    });
  };

  const useCandidate = (dir: string) =>
    void run('install-use', async () => {
      const result = await api.installUse(dir);
      setVerification(result.verification);
      return { ok: result.ok, message: result.message } as ActionResult;
    });

  const download = () => void run('download', () => api.deployStart({ repair: false }));

  const openAssistant = () =>
    void run('assistant', async () => {
      if (!status?.adapter.installed) {
        const installedAdapter = await api.personalInstallAdapter();
        if (!installedAdapter.ok) return installedAdapter;
      }
      const launched = await api.launchHarness(0);
      if (!launched.running) return { ok: false, message: '助手没有启动。请到故障诊断查看原因。' } as ActionResult;
      const pushed = await api.personalPushBridge();
      const opened = await api.openHarness();
      if (!pushed.ok) return pushed;
      const bound = await api.personalAutoBind();
      if (!bound.ok) return bound;
      if (!opened.ok) return { ok: false, message: opened.reason ?? '助手窗口没有打开。', nextStep: bound.message } as ActionResult;
      return bound;
    });

  const runningPipeline = PIPELINE.map((entry) => stepOf(entry.id)).find((step) => step?.status === 'running');

  return (
    <div className="qq-route">
      <div className="route-status">
        <div>
          <span className="route-kicker">个人 QQ</span>
          <h3>连接你的 QQ</h3>
          <p>先下载并启动 SnowLuma，再用手机 QQ 扫码。最后打开 DeepSeek 助手。扫码必须由你本人完成。</p>
        </div>
        <span className={`badge ${phase?.cls ?? ''}`}>{phase?.text ?? '读取中…'}</span>
      </div>
      {status?.message && <p className="route-message">{status.message}</p>}
      {notice && <div className="banner warn">{notice}</div>}
      <div className="sr-only" role="status" aria-live="polite">
        {runningPipeline ? `${PIPELINE.find((entry) => entry.id === runningPipeline.id)?.title ?? runningPipeline.label}，${runningPipeline.detail ?? '进行中'}` : ''}
      </div>
      <div className="route-steps" aria-label="个人 QQ 接入步骤">
        {wizardState.map((item, index) => (
          <button
            key={item.key}
            className={`route-step ${tab === item.key ? 'active' : ''}`}
            aria-current={tab === item.key ? 'step' : undefined}
            onClick={() => setTab(item.key)}
          >
            <span className="route-step-number">{index + 1}</span>
            <span className="route-step-label">{item.title}</span>
            <span className="route-step-state">{STEP_STATUS_LABEL[item.status].text}</span>
          </button>
        ))}
      </div>

      {tab === 'install' && (
        <div className="card">
          <h3>下载并安装 SnowLuma</h3>
          <p>点下面的按钮即可。软件会从官方发布页下载完整版、核对校验值、解压并启动。请先打开并登录电脑上的 QQ。</p>
          <ul className="pq-ready">
            <li>
              <span>电脑版 QQ</span>
              <Flag ok={Boolean(status?.client.installed)} yes="已安装" no={status ? '未检测到' : '读取中'} />
            </li>
            <li>
              <span>QQ 是否已打开</span>
              <Flag ok={Boolean(status?.client.running)} yes="已打开" no={status ? '未打开' : '读取中'} />
            </li>
            <li>
              <span>SnowLuma</span>
              <Flag ok={installed} yes={running ? '已安装并在运行' : '已安装'} no={status ? '未安装' : '读取中'} />
            </li>
          </ul>
          {status && !status.client.installed && (
            <div className="banner warn">没有检测到电脑版 QQ。请先安装并登录 QQ，再下载 SnowLuma。</div>
          )}
          {status?.client.installed && !status.client.running && !deploying && (
            <div className="banner warn">请先打开并登录电脑上的 QQ。下载前会检查 QQ 是否正在运行。</div>
          )}
          <div className="row">
            {deploying ? (
              <button className="primary" type="button" disabled>正在下载并安装…</button>
            ) : installed && running ? (
              <button className="primary" type="button" onClick={() => setTab('login')}>去登录</button>
            ) : installed ? (
              <button className="primary" type="button" onClick={() => void run('start', () => api.deployStep('start'))} disabled={Boolean(busy)}>启动 SnowLuma</button>
            ) : (
              <button className="primary" type="button" onClick={download} disabled={Boolean(busy)}>下载并安装 SnowLuma</button>
            )}
            {deploying && (
              <button type="button" onClick={() => void run('cancel', () => api.deployCancel(), '已取消')} disabled={Boolean(busy) && busy !== 'download'}>取消</button>
            )}
            {!deploying && installed && (
              <button type="button" onClick={download} disabled={Boolean(busy)}>重新下载并安装</button>
            )}
            {!deploying && !installed && (
              <button type="button" onClick={() => void run('precheck', () => api.deployStep('precheck'))} disabled={Boolean(busy)}>先检查能不能安装</button>
            )}
          </div>
          <p className="muted">文件是 <b>{guide?.asset.fileName ?? '官方完整版压缩包'}</b>{guide?.asset ? `，约 ${bytes(guide.asset.sizeBytes)}` : ''}。不会使用 lite 版。</p>
          {snapshot?.message && snapshot.status !== 'idle' && <p>{snapshot.message}</p>}
          <ol className="pq-progress">
            {PIPELINE.map((entry, index) => {
              const step = stepOf(entry.id);
              const state = step?.status ?? 'idle';
              const extra = progressLine(step);
              const detail = [step?.detail, extra, step?.error].filter(Boolean).join(' · ');
              return (
                <li key={entry.id} className={state === 'done' || state === 'running' || state === 'failed' ? state : undefined}>
                  <span className="pq-mark">{index + 1}</span>
                  <div>
                    <strong>{entry.title}</strong>
                    {detail ? <p>{detail}</p> : null}
                  </div>
                  <span className={`badge ${STEP_STATUS_LABEL[state].cls}`}>{STEP_STATUS_LABEL[state].text}</span>
                </li>
              );
            })}
          </ol>

          <details className="advanced-settings">
            <summary>已经自己安装过</summary>
            <p>可以不重复下载。找到含 <code>release.json</code> 的目录后，直接启动。</p>
            <div className="row">
              <button type="button" onClick={() => void recheckInstall()} disabled={Boolean(busy)}>{busy === 'install-recheck' ? '正在查找…' : '自动查找'}</button>
              <button type="button" onClick={() => void pickInstallDir()} disabled={Boolean(busy)}>选择文件夹</button>
              <button type="button" onClick={() => void run('start', () => api.deployStep('start'))} disabled={Boolean(busy)}>启动已安装的 SnowLuma</button>
            </div>
            {discovery && discovery.candidates.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {discovery.candidates.map((candidate) => (
                  <div key={candidate.dir} className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                    <span>
                      <Flag ok={candidate.verification.valid} yes="可用" no="需处理" />
                      <span style={{ marginLeft: 8 }}>{candidate.verification.installDir ?? candidate.dir}</span>
                      <span className="muted">{candidate.verification.version ? ` v${candidate.verification.version}` : ''}</span>
                    </span>
                    <button type="button" onClick={() => useCandidate(candidate.verification.installDir ?? candidate.dir)} disabled={Boolean(busy) || !candidate.verification.exists}>使用此目录</button>
                  </div>
                ))}
              </div>
            )}
          </details>

          <details className="personal-install-details">
            <summary>下载信息与校验详情</summary>
            <p>推荐版本：v{guide?.version ?? '2.4.0'}；文件：<code>{guide?.asset.fileName ?? '读取中'}</code></p>
            <p>SHA-256：<code className="hash">{guide?.asset.sha256 ?? '读取中'}</code></p>
            <p className="muted">校验值由本项目锁定，并与官方发布信息核对。协议由你本人阅读和接受。</p>
            <div className="row">
              <button type="button" onClick={() => open('releases')}>打开官方下载页</button>
              <button type="button" onClick={() => open('eula')}>查看 EULA</button>
              <button type="button" onClick={() => open('license')}>查看 LICENSE</button>
              <button type="button" onClick={() => void api.personalOpenInstallDir()}>打开安装目录</button>
            </div>
            {!verification && <div className="empty">尚未检测。</div>}
            {verification && (
              <>
                <div className="pq-facts">
                  <span className="muted">安装目录</span>
                  <span>
                    {verification.installDir ?? '（未识别）'}
                    {verification.resolvedFromChild && <span className="muted">（已定位到含 release.json 的子目录）</span>}
                  </span>
                  <span className="muted">版本</span>
                  <span>
                    {verification.version ?? '未知'}{' '}
                    {verification.version ? <Flag ok={verification.versionMatches} yes="与推荐版本一致" no={`推荐 v${verification.expectedVersion}`} /> : null}
                  </span>
                  <span className="muted">综合结论</span>
                  <span><Flag ok={verification.valid} yes="校验通过" no="尚未通过校验" /></span>
                </div>
                {verification.checks.length > 0 && (
                  <table>
                    <thead>
                      <tr><th>检查项</th><th>结果</th><th>说明</th></tr>
                    </thead>
                    <tbody>
                      {verification.checks.map((check) => (
                        <tr key={check.id}>
                          <td>{check.label}</td>
                          <td><Flag ok={check.ok} yes="通过" no="缺失" /></td>
                          <td className="muted">{check.detail ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {verification.problems.length > 0 && (
                  <div className="failure">
                    <div>
                      <b>需要你处理</b>
                      {verification.problems.map((problem) => <div key={problem} className="error">· {problem}</div>)}
                    </div>
                  </div>
                )}
              </>
            )}
            <h4>常见问题</h4>
            <ul className="muted">
              <li><b>提示没有 release.json</b>：多半解压成了两层。选到真正含 <code>release.json</code> 的那一层。</li>
              <li><b>版本不一致</b>：可以继续，但端口和配置可能不同。建议用推荐版本 v{guide?.version ?? '2.4.0'}。</li>
              <li><b>缺 node.exe</b>：那是 lite 版。请改用完整版 <code>{guide?.asset.fileName ?? 'SnowLuma-v2.4.0-win-x64.zip'}</code>。</li>
              <li><b>窗口一闪就没了</b>：通常是解压不完整或被安全软件拦截。确认 <code>node.exe</code> 还在，必要时重新下载。</li>
            </ul>
          </details>
        </div>
      )}

      {tab === 'login' && (
        <div className="card">
          <h3>扫码登录 QQ</h3>
          {!installed ? (
            <>
              <p>还没有可用的 SnowLuma。请先完成下载安装。</p>
              <button className="primary" type="button" onClick={() => setTab('install')}>返回安装</button>
            </>
          ) : (
            <>
              <p>SnowLuma 启动后，打开登录页，输入初始口令，再用手机 QQ 扫码。协议由你本人决定是否接受。</p>
              <div className="login-guide">
                <SetupIllustration scene="login" />
                <ol className="pq-actions">
                  <li>
                    <span className="pq-mark">1</span>
                    <div>
                      <strong>保持 SnowLuma 运行</strong>
                      <p>{running ? '当前已在运行。登录完成前不要关掉它的窗口。' : '还没启动。先启动，才能打开登录页。'}</p>
                      {!running && (
                        <button className="primary" type="button" onClick={() => void run('start', () => api.deployStep('start'))} disabled={Boolean(busy)}>启动 SnowLuma</button>
                      )}
                    </div>
                  </li>
                  <li>
                    <span className="pq-mark">2</span>
                    <div>
                      <strong>打开登录页并扫码</strong>
                      <p>初始口令只在本软件启动 SnowLuma 时捕获，点下面的按钮才会显示给你。</p>
                      <div className="row">
                        <button className={running ? 'primary' : ''} type="button" onClick={() => open('webui')} disabled={Boolean(busy) || !running}>打开登录页</button>
                        <button
                          type="button"
                          onClick={() =>
                            void run('credentials', async () => {
                              const value = await api.deployCredentials();
                              setCredentials(value);
                              if (!value) setNotice('还没有初始口令。请先点「启动 SnowLuma」，等它启动后再显示。');
                              return { ok: true } as ActionResult;
                            })
                          }
                          disabled={Boolean(busy)}
                        >
                          显示初始口令
                        </button>
                      </div>
                    </div>
                  </li>
                  <li>
                    <span className="pq-mark">3</span>
                    <div>
                      <strong>回到这里确认</strong>
                      <p>当前：<Flag ok={loggedIn} yes="已检测到登录" no="尚未检测到登录" /></p>
                      <button type="button" onClick={() => void load()} disabled={Boolean(busy)}>重新检测</button>
                    </div>
                  </li>
                </ol>
              </div>
              {credentials && (
                <div className="banner warn">
                  初始口令：<b>{credentials.user}</b> / <b>{credentials.password}</b>
                  <div className="muted">只显示给你本人，不写入日志。登录后请立刻修改。</div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'link' && (
        <div className="card">
          <h3>打开 DeepSeek 助手</h3>
          <p>点下面的按钮就会打开助手，并自动把最近和这个小号说过话的 QQ 接上。不用查看或填写会话编号。助手打开后，再发一条新消息才会有回复。</p>
          {!loggedIn && <div className="banner warn">还没有检测到 QQ 登录。可以先打开助手，但消息要等扫码完成之后才会到。</div>}
          <ul className="pq-ready">
            <li>
              <span>连接插件</span>
              <Flag ok={Boolean(status?.adapter.installed)} yes={`已安装 ${status?.adapter.version ?? ''}`} no="未安装" />
            </li>
            <li>
              <span>本机连接</span>
              <Flag ok={Boolean(config?.httpServers?.length)} yes="已读到配置" no={config ? '尚未读到' : '未读取'} />
            </li>
            <li>
              <span>QQ 登录</span>
              <Flag ok={loggedIn} yes="已登录" no="未登录" />
            </li>
          </ul>
          <div className="row">
            <button className="primary" type="button" onClick={openAssistant} disabled={Boolean(busy)}>
              {busy === 'assistant' ? '正在打开…' : '启动并打开助手'}
            </button>
          </div>
          {stepOf('link')?.error && <div className="error">{stepOf('link')!.error}</div>}
          <details className="advanced-settings">
            <summary>连接没有生效时，逐项重试</summary>
            <div className="row">
              <button type="button" onClick={() => void run('adapter', () => api.personalInstallAdapter())} disabled={Boolean(busy)}>安装 / 修复适配插件</button>
              <button type="button" onClick={() => void run('push', () => api.personalPushBridge())} disabled={Boolean(busy)}>写入端点与令牌</button>
              <button type="button" onClick={() => void run('link', () => api.deployStep('link'))} disabled={Boolean(busy)}>重新联通</button>
              <button type="button" onClick={() => void api.deployConfig().then(setConfig)} disabled={Boolean(busy)}>读取配置</button>
            </div>
            <p className="muted">上面的按钮会自动接上。只有自动没接上时，才需要在这里手动指定。会话编号在助手窗口里不显示。</p>
            <div className="row">
              <input placeholder="助手会话" value={sessionId} onChange={(event) => setSessionId(event.target.value)} style={{ minWidth: 220 }} />
              <input placeholder="QQ 号" value={uin} onChange={(event) => setUin(event.target.value)} style={{ width: 140 }} />
              <button type="button" onClick={() => void run('bind', () => api.personalBindPrivate(sessionId, uin))} disabled={Boolean(busy) || !sessionId || !uin}>绑定私聊到会话</button>
            </div>
          </details>
        </div>
      )}

      <div className="route-actions personal-route-actions">
        <button type="button" onClick={() => setTab(WIZARD[Math.max(0, tabIndex - 1)]!.key)} disabled={tabIndex <= 0}>上一步</button>
        <button className="primary" type="button" onClick={() => setTab(WIZARD[Math.min(WIZARD.length - 1, tabIndex + 1)]!.key)} disabled={tabIndex >= WIZARD.length - 1}>下一步 →</button>
      </div>

      <details className="card">
        <summary>日志、配置备份与卸载</summary>
        <div className="row" style={{ marginTop: 10 }}>
          {deploying && <button type="button" onClick={() => void run('cancel', () => api.deployCancel(), '已取消')} disabled={Boolean(busy)}>取消下载</button>}
          {running && <button type="button" onClick={() => void run('stop', () => api.deployStop(), '已停止 SnowLuma')} disabled={Boolean(busy)}>停止 SnowLuma</button>}
          <button type="button" onClick={() => void loadAdvanced()}>刷新日志和备份</button>
        </div>
        <h4>SnowLuma 配置现状</h4>
        <pre className="log">{config ? JSON.stringify(config, null, 2) : '（点击刷新日志和备份）'}</pre>
        <h4>配置备份与恢复</h4>
        {backups.length === 0 && <div className="empty">还没有备份。写入配置前会自动备份。</div>}
        {backups.map((item) => (
          <div key={item.name} className="row" style={{ marginBottom: 6 }}>
            <span className="muted">{item.name}</span>
            <button
              type="button"
              onClick={() => {
                void run('restore', async () => {
                  const result = await api.deployConfigRestore(item.name);
                  setNotice(result.evidence.join(' '));
                  return { ok: result.ok } as ActionResult;
                });
              }}
              disabled={Boolean(busy)}
            >
              恢复此备份
            </button>
          </div>
        ))}
        <h4>SnowLuma 输出（最近 40 行）</h4>
        <pre className="log">{output.join('\n') || '（没有输出）'}</pre>
        <h4>卸载</h4>
        <div className="muted">默认只删除本软件自己的状态。程序文件、配置和 QQ 登录数据必须逐项勾选。</div>
        <label className="row"><input type="checkbox" checked={uninstall.removeOurState} onChange={(e) => setUninstall({ ...uninstall, removeOurState: e.target.checked })} />删除本软件的 SnowLuma 状态（安装记录、暂存、部署记录）</label>
        <label className="row"><input type="checkbox" checked={uninstall.removeComponent} onChange={(e) => setUninstall({ ...uninstall, removeComponent: e.target.checked })} />删除 SnowLuma 程序文件（只删包内条目）</label>
        <label className="row"><input type="checkbox" checked={uninstall.removeConfig} onChange={(e) => setUninstall({ ...uninstall, removeConfig: e.target.checked })} />删除 SnowLuma 配置（删除前备份）</label>
        <label className="row"><input type="checkbox" checked={uninstall.removeUserData} onChange={(e) => setUninstall({ ...uninstall, removeUserData: e.target.checked })} />删除 QQ 登录数据与消息库（不可恢复）</label>
        <label className="row"><input type="checkbox" checked={uninstall.confirm} onChange={(e) => setUninstall({ ...uninstall, confirm: e.target.checked })} />我确认以上选择</label>
        <button
          type="button"
          onClick={() =>
            void run('uninstall', async () => {
              const result = await api.personalUninstall(uninstall);
              setNotice(result.ok ? result.actions.join('；') : result.refusedReason ?? '未执行');
              return { ok: result.ok, message: result.actions.join('；') || result.refusedReason };
            })
          }
          disabled={Boolean(busy) || !uninstall.confirm}
        >
          执行卸载
        </button>
        <h4>检测证据</h4>
        <pre className="log">{(status?.evidence ?? []).map((item) => `[${item.source}] ${item.line}`).join('\n') || '（无）'}</pre>
      </details>
    </div>
  );
}
