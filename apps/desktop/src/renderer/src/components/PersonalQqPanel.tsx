import { useCallback, useEffect, useMemo, useState } from 'react';


import type {
  InstallVerification,
  PersonalQqGuide,
  PersonalQqSettings,
  PersonalQqStatus,
  SnowLumaConfigInspection,
  SnowLumaDeploySnapshot,
  SnowLumaInstallDiscovery,
  SnowLumaProcessStatus,
  SnowLumaStepState,
  SnowLumaStepStatus,
} from '@dda/spec';
/**
 * 个人 QQ（SnowLuma）部署向导。
 *
 * 五步与 `@dda/spec` 的部署步骤一一对应：
 *  1 环境检查 → precheck
 *  2 自动部署 → release / download / install / configure / start
 *  3 QQ 登录  → 用户扫码（人工）
 *  4 Harness 连接 → link
 *  5 连接验收 → verify（必须由用户确认真实收到回复）
 *
 * 界面只读主进程产出的快照，不执行任何下载/安装逻辑；
 * OneBot 令牌从不进入渲染层，WebUI 初始口令只在用户点击后展示。
 */

interface ActionResult {
  ok: boolean;
  message?: string;
  nextStep?: string;
}

interface DdaApi {
  personalStatus(): Promise<PersonalQqStatus>;
  personalGuide(): Promise<PersonalQqGuide>;
  personalSettings(): Promise<PersonalQqSettings>;
  personalInstallAdapter(): Promise<ActionResult>;
  personalPushBridge(): Promise<ActionResult>;
  personalBindPrivate(sessionId: string, uin: string): Promise<ActionResult>;
  personalVerifyMessage(verified: boolean): Promise<{ ok: boolean }>;
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
  deployStart(payload: { installDir?: string; repair?: boolean }): Promise<SnowLumaDeploySnapshot>;
  deployStep(stepId: string): Promise<SnowLumaDeploySnapshot>;
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
  'harness-linked': { text: '已联通 Harness', cls: 'ok' },
  'message-verified': { text: '消息链路已验证', cls: 'ok' },
  failed: { text: '检测失败', cls: 'warn' },
};

const STEP_STATUS_LABEL: Record<SnowLumaStepStatus, { text: string; cls: string }> = {
  idle: { text: '未开始', cls: '' },
  running: { text: '进行中', cls: 'warn' },
  waiting: { text: '等待操作', cls: 'warn' },
  done: { text: '已完成', cls: 'ok' },
  failed: { text: '失败', cls: 'bad' },
  blocked: { text: '受许可限制', cls: 'bad' },
  cancelled: { text: '已取消', cls: '' },
  skipped: { text: '已跳过', cls: '' },
};

const WIZARD = [
  { key: 'env', title: '1. 环境检查', steps: ['precheck'] as string[] },
  { key: 'install', title: '2. 下载与安装 SnowLuma', steps: [] as string[] },
  { key: 'login', title: '3. QQ 登录', steps: [] as string[] },
  { key: 'link', title: '4. 连接 Harness', steps: ['link'] as string[] },
  { key: 'verify', title: '5. 消息测试', steps: ['verify'] as string[] },
];

/** 安装引导的"示意图"（用文字框图，不伪造上游截图）。 */
const TUTORIAL = [
  {
    title: '① 从官方页面下载 zip',
    art: [
      'GitHub · SnowLuma/SnowLuma · Releases',
      '  v2.4.0  ─────────────────────────────',
      '  SnowLuma-v2.4.0-win-x64.zip   ⬇ 下载',
      '  SnowLuma-v2.4.0-win-x64-lite.zip',
      '  （linux 包与 lite 包都不要选）',
    ].join('\n'),
    text: '只认 github.com/SnowLuma/SnowLuma/releases 这一个来源。lite 版需要你自备 Node 24+，不要选。',
  },
  {
    title: '② 解压到固定目录',
    art: [
      '解压后应当是这一层：',
      '  SnowLuma\\',
      '   ├─ launcher.bat      ← 启动用',
      '   ├─ node.exe          ← 自带运行时',
      '   ├─ index.mjs',
      '   ├─ release.json      ← 我们靠它识别',
      '   ├─ client\\   native\\',
      '  （不要再套一层 SnowLuma-v2.4.0-win-x64\\）',
    ].join('\n'),
    text: '建议解压到 %LOCALAPPDATA%\\SnowLuma 或 D:\\SnowLuma。一定不要解压进 QQ 的安装目录，也不要放进系统目录。',
  },
  {
    title: '③ 启动一次并完成 QQ 登录',
    art: [
      '双击 launcher.bat 后会打开一个黑窗口：',
      '  ┌──────────────────────────────┐',
      '  │ SnowLuma runtime starting…   │',
      '  │ WebUI: http://127.0.0.1:5099 │',
      '  └──────────────────────────────┘',
      '窗口要一直开着；关掉窗口 = 关掉 SnowLuma。',
    ].join('\n'),
    text: '首次启动会打印 WebUI 初始口令（只打印一次）。打开 WebUI 里由你本人接受 EULA/PRIVACY，再用手机 QQ 扫码登录。',
  },
  {
    title: '④ 回到本页点"我已完成安装"',
    art: [
      '本软件接下来只做这些（都是只读或我们自己的配置）：',
      '  ✓ 识别安装目录并校验 release.json / node.exe',
      '  ✓ 读取 OneBot 端点与令牌（只在主进程）',
      '  ✓ 写入 dsh-qq-link 配置',
      '  ✓ 检查 get_login_info 与 bridge 状态',
      '  ✗ 不下载、不解压、不改 SnowLuma 文件',
    ].join('\n'),
    text: '如果自动没找到，点"选择 SnowLuma 目录"，选到含 release.json 的那一层即可。',
  },
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

function StepRow({
  step,
  onRetry,
  busy,
}: {
  step: SnowLumaStepState;
  onRetry: (id: string) => void;
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const status = STEP_STATUS_LABEL[step.status];
  const percent = step.progress?.percent;
  return (
    <div className="step-line">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <span className={`badge ${status.cls}`}>{status.text}</span>
          <b>{step.label}</b>
          {step.detail && <span className="muted">{step.detail}</span>}
        </div>
        <div className="row">
          {step.evidence.length > 0 && (
            <button className="link" onClick={() => setOpen((value) => !value)}>
              {open ? '收起证据' : `证据 ${step.evidence.length}`}
            </button>
          )}
          <button onClick={() => onRetry(step.id)} disabled={busy || !step.retryable}>
            重新执行
          </button>
        </div>
      </div>

      {percent !== undefined && percent < 100 && (
        <>
          <div className="progress">
            <div style={{ width: `${percent}%` }} />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {bytes(step.progress?.receivedBytes)} / {bytes(step.progress?.totalBytes)}（{percent}%）
            {step.progress?.speedBps ? ` · ${bytes(step.progress.speedBps)}/s` : ''}
            {step.progress?.etaSeconds ? ` · 剩余约 ${step.progress.etaSeconds} 秒` : ''}
          </div>
        </>
      )}

      {step.error && <div className="error">{step.error}</div>}
      {step.hint && <div className="muted">建议：{step.hint}</div>}
      {open && <pre className="log">{step.evidence.join('\n') || '（无）'}</pre>}
    </div>
  );
}

export function PersonalQqPanel(): JSX.Element {
  const [status, setStatus] = useState<PersonalQqStatus>();
  const [guide, setGuide] = useState<PersonalQqGuide>();
  const [settings, setSettings] = useState<PersonalQqSettings>();
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
  const [tab, setTab] = useState<string>('env');
  const [sessionId, setSessionId] = useState('');
  const [uin, setUin] = useState('');
  const [uninstall, setUninstall] = useState({
    removeOurState: true,
    removeComponent: false,
    removeConfig: false,
    removeUserData: false,
    confirm: false,
  });

  const refresh = useCallback(async () => {
    const [next, g, s, deploy, proc, disc] = await Promise.all([
      api.personalStatus(),
      api.personalGuide(),
      api.personalSettings(),
      api.deployStatus(),
      api.deployProcess(),
      api.installDiscovery(),
    ]);
    setStatus(next);
    setGuide(g);
    setSettings(s);
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
    if (tab !== 'login' && tab !== 'verify') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .deployStatus()
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch(() => undefined);
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tab]);

  const run = async (key: string, action: () => Promise<unknown>, message?: string) => {
    setBusy(key);
    setNotice(undefined);
    try {
      const result = (await action()) as ActionResult | undefined;
      if (result && typeof result === 'object' && 'ok' in result && !(result as ActionResult).ok) {
        setNotice([(result as ActionResult).message, (result as ActionResult).nextStep].filter(Boolean).join(' '));
      } else if (message) {
        setNotice(message);
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
  const gateway = snapshot?.authorization;
  const open = (target: 'project' | 'releases' | 'license' | 'eula' | 'webui') => void api.personalOpen(target);

  const wizardState = useMemo(() => {
    return WIZARD.map((item) => {
      if (item.key === 'login') {
        const state: SnowLumaStepStatus = status?.service.onebotResponsive
          ? 'done'
          : status?.service.webuiReachable
            ? 'waiting'
            : 'idle';
        return { ...item, status: state };
      }
      if (item.key === 'install') {
        // 第二步以"用户是否已装好"为准：装好且校验通过才算 done；装了但校验不过停在 waiting。
        const state: SnowLumaStepStatus = !verification?.exists
          ? 'idle'
          : verification.valid
            ? 'done'
            : 'waiting';
        return { ...item, status: state };
      }
      const steps = item.steps
        .map((id) => stepOf(id))
        .filter((step): step is SnowLumaStepState => Boolean(step));
      if (steps.length === 0) return { ...item, status: 'idle' as SnowLumaStepStatus };
      if (steps.some((step) => step.status === 'failed')) return { ...item, status: 'failed' as SnowLumaStepStatus };
      if (steps.some((step) => step.status === 'blocked')) return { ...item, status: 'blocked' as SnowLumaStepStatus };
      if (steps.every((step) => step.status === 'done' || step.status === 'skipped'))
        return { ...item, status: 'done' as SnowLumaStepStatus };
      if (steps.some((step) => step.status === 'running' || step.status === 'waiting'))
        return { ...item, status: 'running' as SnowLumaStepStatus };
      return { ...item, status: 'idle' as SnowLumaStepStatus };
    });
  }, [status, stepOf, verification]);

  /** 「我已完成安装」：重新扫描常见目录，并把结论如实写进界面。 */
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
          : '没有在常见位置找到 SnowLuma。请点「选择 SnowLuma 目录」，选到含 release.json 的那一层。',
      } as ActionResult;
    });
  };

  /** 选目录 → 校验 → 用户确认后写入设置。 */
  const pickInstallDir = async () => {
    const picked = await api.personalPickInstallDir();
    if (!picked.ok || !picked.installDir) return;
    await run(
      'install-use',
      async () => {
        const result = await api.installUse(picked.installDir!);
        setVerification(result.verification);
        return { ok: result.ok, message: result.message } as ActionResult;
      },
      '已更新安装目录',
    );
  };

  return (
    <div>
      <div className={gateway?.allowed ? 'banner ok' : 'banner warn'}>
        <b>
          {guide?.displayName ?? 'SnowLuma'} 接入方式：
          {gateway?.allowed ? '已获书面授权，可自动部署' : '官方下载 + 手动安装 + 自动检测'}
        </b>
        <div className="muted" style={{ marginTop: 4 }}>
          {gateway?.allowed
            ? gateway.reason
            : 'SnowLuma 的 EULA §5.4 要求"通过自动化脚本部署"须事先取得书面授权，因此下载与安装由你在官方渠道完成；本软件负责安装校验、Harness 配置、OneBot 检测与消息验收，不代下载、不代安装、不伪造成功。'}
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          许可：{guide?.license.name ?? '-'}（{guide?.license.spdx ?? '-'}）。协议必须由你本人在 SnowLuma WebUI
          里接受，本软件不会代按。
          <button className="link" onClick={() => open('eula')}>
            查看 EULA
          </button>
          <button className="link" onClick={() => open('releases')}>
            官方 Releases
          </button>
        </div>
      </div>

      <p>
        <span className={`badge ${phase?.cls ?? ''}`}>{phase?.text ?? '读取中…'}</span>{' '}
        <span className="muted">{status?.message}</span>
      </p>
      {snapshot?.message && snapshot.status !== 'idle' && <p className="muted">{snapshot.message}</p>}
      {notice && <div className="banner warn">{notice}</div>}

      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => open('releases')} disabled={Boolean(busy)}>
          前往 SnowLuma 官方下载
        </button>
        <button onClick={() => void load()} disabled={Boolean(busy)}>
          {busy === 'refresh' ? '检测中…' : '重新检测'}
        </button>
        <button onClick={() => void pickInstallDir()} disabled={Boolean(busy)}>
          选择 SnowLuma 目录
        </button>
        <button onClick={() => void api.personalOpenInstallDir()} disabled={Boolean(busy)}>
          打开安装目录
        </button>
      </div>

      <div className="stepper">
        {wizardState.map((item) => (
          <button key={item.key} className={`chip ${tab === item.key ? 'primary' : ''}`} onClick={() => setTab(item.key)}>
            <span>{item.title}</span>
            <span className={`badge ${STEP_STATUS_LABEL[item.status].cls}`}>{STEP_STATUS_LABEL[item.status].text}</span>
          </button>
        ))}
      </div>

      {tab === 'env' && (
        <div className="card">
          <h3>第一步：环境检查</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 6 }}>
            <span className="muted">操作系统</span>
            <span>Windows（本产品只支持 Windows x64）</span>
            <span className="muted">QQ 客户端</span>
            <span>
              <Flag ok={Boolean(status?.client.installed)} yes="已安装" no="未检测到" />
              {status?.client.path && <span className="muted"> {status.client.path}</span>}
            </span>
            <span className="muted">QQ 进程</span>
            <span>
              <Flag ok={Boolean(status?.client.running)} yes="运行中" no="未运行" />
              {status?.client.pids?.length ? <span className="muted"> pid {status.client.pids.join(', ')}</span> : null}
            </span>
            <span className="muted">SnowLuma</span>
            <span>
              <Flag
                ok={Boolean(status?.component.installed)}
                yes={`已安装 ${status?.component.installedVersion ?? ''}`}
                no="未安装"
              />
              {status?.component.versionProblem && <span className="muted"> {status.component.versionProblem}</span>}
            </span>
            <span className="muted">安装目录</span>
            <span>{snapshot?.installDir ?? status?.component.installDir ?? '-'}</span>
            <span className="muted">SnowLuma 进程</span>
            <span>
              <Flag ok={Boolean(processInfo?.running)} yes={`运行中 pid ${processInfo?.pid ?? '-'}`} no="未运行" />
            </span>
            <span className="muted">检查结论</span>
            <span>{stepOf('precheck')?.detail ?? '尚未执行环境检查'}</span>
          </div>
          {stepOf('precheck')?.error && <div className="error">{stepOf('precheck')!.error}</div>}
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => void run('precheck', () => api.deployStep('precheck'))} disabled={Boolean(busy)}>
              运行环境检查
            </button>
            <button onClick={() => open('releases')} disabled={Boolean(busy)}>
              打开官方下载页
            </button>
          </div>
          {!gateway?.allowed && (
            <div className="muted" style={{ marginTop: 10 }}>
              下一件事：去第二步，从官方 Releases 下载并解压 SnowLuma（我们不代下载/安装），回来点「我已完成安装」，
              我们会只读校验目录、读取 OneBot 端点、配置 Harness 适配层并做真实连通检测。
            </div>
          )}
        </div>
      )}

      {tab === 'install' && (
        <div className="card">
          <h3>第二步：下载与安装 SnowLuma</h3>
          <p className="muted">
            这一步由你本人完成：从<b>官方 GitHub Releases</b> 下载、解压、启动一次。本软件不代下载、不代安装、不改
            SnowLuma 的任何文件；装好之后，安装校验、Harness 配置、OneBot 检测与消息验收由我们负责。
          </p>

          <div className="install-card">
            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 6 }}>
              <span className="muted">来源</span>
              <span>
                GitHub · <code>SnowLuma/SnowLuma</code> · Releases
                <button className="link" onClick={() => open('releases')}>
                  打开
                </button>
              </span>
              <span className="muted">推荐版本</span>
              <span>
                <b>v{guide?.version ?? '2.4.0'}</b>（Windows x64 完整版，自带 Node 运行时，无需另装）
              </span>
              <span className="muted">文件名</span>
              <span>
                <code>{guide?.asset.fileName ?? '-'}</code>
                {guide?.asset ? <span className="muted">（{bytes(guide.asset.sizeBytes)}）</span> : null}
              </span>
              <span className="muted">SHA-256</span>
              <span>
                <code className="hash">{guide?.asset.sha256 ?? '-'}</code>
              </span>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              校验说明：官方 Releases 不附带校验和文件；上面的 SHA-256 是本产品对官方 v2.4.0 包实测并与 GitHub API
              的 <code>digest</code> 核对后锁定的值。你可以自行核对：
              <br />
              <code>
                certutil -hashfile "%USERPROFILE%\Downloads\{guide?.asset.fileName ?? 'SnowLuma-v2.4.0-win-x64.zip'}"
                SHA256
              </code>
            </div>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={() => open('releases')} disabled={Boolean(busy)}>
              前往 SnowLuma 官方下载
            </button>
            <button onClick={() => open('eula')} disabled={Boolean(busy)}>
              查看 EULA
            </button>
            <button onClick={() => open('license')} disabled={Boolean(busy)}>
              查看 LICENSE
            </button>
          </div>

          <h4>图文安装步骤（示意图）</h4>
          {TUTORIAL.map((item) => (
            <div key={item.title} className="tutorial-step">
              <div className="tutorial-art">
                <pre>{item.art}</pre>
              </div>
              <div>
                <b>{item.title}</b>
                <div className="muted" style={{ marginTop: 4 }}>
                  {item.text}
                </div>
              </div>
            </div>
          ))}

          <h4>装好了？</h4>
          <div className="row">
            <button className="primary" onClick={() => void recheckInstall()} disabled={Boolean(busy)}>
              {busy === 'install-recheck' ? '正在检测…' : '我已完成安装（重新检测）'}
            </button>
            <button onClick={() => void pickInstallDir()} disabled={Boolean(busy)}>
              选择 SnowLuma 目录
            </button>
            <button onClick={() => void api.personalOpenInstallDir()} disabled={Boolean(busy)}>
              打开安装目录
            </button>
          </div>

          <h4>安装检测结果（只读）</h4>
          {!verification && <div className="empty">尚未检测。</div>}
          {verification && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 6 }}>
                <span className="muted">安装目录</span>
                <span>
                  {verification.installDir ?? '（未识别）'}
                  {verification.resolvedFromChild && (
                    <span className="muted">（你选的是上一级，已自动定位到含 release.json 的子目录）</span>
                  )}
                </span>
                <span className="muted">版本</span>
                <span>
                  {verification.version ?? '未知'}{' '}
                  {verification.version ? (
                    <Flag ok={verification.versionMatches} yes="与推荐版本一致" no={`推荐 v${verification.expectedVersion}`} />
                  ) : null}
                </span>
                <span className="muted">综合结论</span>
                <span>
                  <Flag ok={verification.valid} yes="校验通过，可以继续" no="尚未通过校验" />
                </span>
                <span className="muted">用户数据</span>
                <span className="muted">
                  config/ {verification.hasConfig ? '已存在（我们只读，不覆盖）' : '未生成（首次启动后出现）'} · data/{' '}
                  {verification.hasData ? '已存在（QQ 登录态）' : '未生成'}
                </span>
              </div>
              {verification.checks.length > 0 && (
                <table style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>检查项</th>
                      <th>结果</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verification.checks.map((check) => (
                      <tr key={check.id}>
                        <td>{check.label}</td>
                        <td>
                          <Flag ok={check.ok} yes="通过" no="缺失" />
                        </td>
                        <td className="muted">{check.detail ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {verification.problems.length > 0 && (
                <div className="failure" style={{ marginTop: 10 }}>
                  <div>
                    <b>需要你处理</b>
                    {verification.problems.map((problem) => (
                      <div key={problem} className="error">
                        · {problem}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {discovery && discovery.candidates.length > 0 && (
            <>
              <h4>在常见位置找到的候选目录</h4>
              {discovery.candidates.map((candidate) => (
                <div key={candidate.dir} className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>
                    <Flag ok={candidate.verification.valid} yes="可用" no="需处理" />
                    <span style={{ marginLeft: 8 }}>{candidate.verification.installDir ?? candidate.dir}</span>
                    <span className="muted">
                      {candidate.verification.version ? ` v${candidate.verification.version}` : ''} · 来源：{candidate.source}
                    </span>
                  </span>
                  <button
                    onClick={() =>
                      void run(
                        'install-use',
                        async () => {
                          const result = await api.installUse(candidate.verification.installDir ?? candidate.dir);
                          setVerification(result.verification);
                          return { ok: result.ok, message: result.message } as ActionResult;
                        },
                        '已更新安装目录',
                      )
                    }
                    disabled={Boolean(busy) || !candidate.verification.exists}
                  >
                    使用此目录
                  </button>
                </div>
              ))}
            </>
          )}

          <details style={{ marginTop: 12 }}>
            <summary>常见问题</summary>
            <ul className="muted">
              <li>
                <b>选目录时提示没有 release.json</b>：多半是解压成了两层（<code>
                  …\SnowLuma-v2.4.0-win-x64\SnowLuma-v2.4.0-win-x64\
                </code>）。选到真正含 <code>release.json</code> 的那一层即可。
              </li>
              <li>
                <b>版本不一致</b>：可以继续，但 OneBot 配置结构与端口行为可能不同；建议用推荐版本 v
                {guide?.version ?? '2.4.0'}。
              </li>
              <li>
                <b>缺 node.exe</b>：你下载的是 lite 版（需要自备 Node 24+）。请改用完整版{' '}
                <code>{guide?.asset.fileName ?? 'SnowLuma-v2.4.0-win-x64.zip'}</code>。
              </li>
              <li>
                <b>黑窗口一闪就没了</b>：通常是解压不完整或被杀毒软件拦截；检查 <code>node.exe</code> 是否存在，必要时重新解压。
              </li>
              <li>
                <b>QQ 必须开着</b>：SnowLuma 依赖运行中的 QQ 客户端；先登录 QQ 桌面版，再启动 SnowLuma。
              </li>
            </ul>
          </details>

          <details style={{ marginTop: 8 }}>
            <summary>自动下载与安装（需著作权人书面授权，当前{gateway?.allowed ? '已放行' : '不可用'}）</summary>
            {!gateway?.allowed && (
              <div className="banner warn">
                受 SnowLuma EULA §5.4 限制，未登记书面授权时下列步骤不会执行；它们会显示为「受许可限制」，不会假装成功。
              </div>
            )}
            {(snapshot?.steps ?? [])
              .filter((step) => step.id !== 'precheck' && step.id !== 'link' && step.id !== 'verify')
              .map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  busy={Boolean(busy)}
                  onRetry={(id) => void run(id, () => api.deployStep(id))}
                />
              ))}
            <div className="row" style={{ marginTop: 10 }}>
              <button
                onClick={() => void run('start', () => api.deployStart({}))}
                disabled={Boolean(busy) || snapshot?.status === 'running'}
              >
                {snapshot?.status === 'running' ? '自动部署进行中…' : '开始自动部署'}
              </button>
              <button
                onClick={() => void run('repair', () => api.deployStart({ repair: true }))}
                disabled={Boolean(busy)}
              >
                修复安装（保留配置与登录态）
              </button>
              <button onClick={() => void run('cancel', () => api.deployCancel(), '已取消部署')} disabled={Boolean(busy)}>
                取消
              </button>
              <button onClick={() => void run('stop', () => api.deployStop(), '已停止 SnowLuma')} disabled={Boolean(busy)}>
                停止 SnowLuma
              </button>
            </div>
          </details>
        </div>
      )}

      {tab === 'login' && (
        <div className="card">
          <h3>第三步：QQ 登录</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 6 }}>
            <span className="muted">WebUI 地址</span>
            <span>
              {guide?.webuiUrl ?? '-'} <Flag ok={Boolean(status?.service.webuiReachable)} yes="可连接" no="未监听" />
            </span>
            <span className="muted">OneBot HTTP</span>
            <span>
              <Flag ok={Boolean(status?.service.onebotReachable)} yes="已监听" no="未监听" />
            </span>
            <span className="muted">QQ 登录状态</span>
            <span>
              <Flag
                ok={Boolean(status?.service.onebotResponsive)}
                yes={`已登录 ${status?.service.loginUin ?? ''}`}
                no="未登录"
              />
              {status?.service.error && <span className="muted"> {status.service.error}</span>}
            </span>
          </div>
          <ol className="muted" style={{ marginTop: 10 }}>
            <li>
              如果 SnowLuma 没在运行：到安装目录双击 <code>launcher.bat</code>（黑窗口要一直开着）。
            </li>
            <li>点「打开 SnowLuma WebUI」，用下面的初始口令登录（上游只打印一次，改密后不再显示）。</li>
            <li>
              在 WebUI 里阅读并<b>由你本人</b>接受 EULA / PRIVACY（本软件不会代按）。
            </li>
            <li>用手机 QQ 扫码登录。登录成功后返回本页点「重新检测」。</li>
          </ol>
          <div className="row">
            <button onClick={() => open('webui')} disabled={Boolean(busy)}>
              打开 SnowLuma WebUI
            </button>
            {gateway?.allowed && (
              <button
                onClick={() =>
                  void run(
                    'credentials',
                    async () => {
                      const value = await api.deployCredentials();
                      setCredentials(value);
                      if (!value) setNotice('还没有捕获到初始口令（可能不是首次启动，或口令已改）。');
                      return { ok: true } as ActionResult;
                    },
                  )
                }
                disabled={Boolean(busy)}
              >
                显示 WebUI 初始口令
              </button>
            )}
            <button onClick={() => void load()} disabled={Boolean(busy)}>
              重新检测
            </button>
          </div>
          <p className="muted">
            初始口令由 SnowLuma 在首次启动的黑窗口里打印一次；由于现在由你自己启动它，本软件看不到那段输出，
            请在那一步直接记下口令。{gateway?.allowed ? '（自动部署模式下本软件会代为捕获。）' : ''}
          </p>
          {credentials && (
            <div className="banner warn">
              初始口令：<b>{credentials.user}</b> / <b>{credentials.password}</b>
              <div className="muted">只显示给你本人；本软件不落盘、不写日志。登录后请立刻改密。</div>
            </div>
          )}
        </div>
      )}

      {tab === 'link' && (
        <div className="card">
          <h3>第四步：连接 Harness</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 6 }}>
            <span className="muted">适配插件</span>
            <span>
              <Flag ok={Boolean(status?.adapter.installed)} yes={`已安装 ${status?.adapter.version ?? ''}`} no="未安装" />
              <span className="muted">（要求 {status?.adapter.expectedVersion ?? '1.5.1'}）</span>
            </span>
            <span className="muted">OneBot 配置</span>
            <span>
              {config?.httpServers?.length
                ? config.httpServers
                    .map(
                      (server) =>
                        `${server.host ?? '127.0.0.1'}:${server.port ?? '-'}${server.hasToken ? '（带令牌）' : '（无令牌）'}`,
                    )
                    .join('；')
                : config?.problem ?? '尚未读取'}
            </span>
            <span className="muted">Bridge 状态</span>
            <span>
              <Flag ok={Boolean(status?.bridge?.ok)} yes="可读" no="不可读" />{' '}
              <Flag ok={Boolean(status?.bridge?.backendOk)} yes="后端可用" no="后端不可用" />
              {status?.bridge?.backendError && <span className="muted"> {status.bridge.backendError}</span>}
            </span>
            <span className="muted">会话</span>
            <span>{status?.bridge?.sessionIds?.length ? `${status.bridge.sessionIds.length} 个` : '暂无'}</span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => void run('adapter', () => api.personalInstallAdapter())} disabled={Boolean(busy)}>
              安装 / 修复适配插件
            </button>
            <button onClick={() => void run('push', () => api.personalPushBridge())} disabled={Boolean(busy)}>
              写入端点与令牌
            </button>
            <button onClick={() => void run('link', () => api.deployStep('link'))} disabled={Boolean(busy)}>
              重新联通
            </button>
            <button onClick={() => void api.deployConfig().then(setConfig)} disabled={Boolean(busy)}>
              读取配置
            </button>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input
              placeholder="Harness 会话 id"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              style={{ minWidth: 260 }}
            />
            <input
              placeholder="QQ 号"
              value={uin}
              onChange={(event) => setUin(event.target.value)}
              style={{ width: 140 }}
            />
            <button
              onClick={() => void run('bind', () => api.personalBindPrivate(sessionId, uin))}
              disabled={Boolean(busy) || !sessionId || !uin}
            >
              绑定私聊到会话
            </button>
          </div>
          {stepOf('link')?.error && <div className="error">{stepOf('link')!.error}</div>}
        </div>
      )}

      {tab === 'verify' && (
        <div className="card">
          <h3>第五步：消息测试</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 6 }}>
            <span className="muted">QQ 账号识别</span>
            <span>
              <Flag ok={Boolean(status?.service.onebotResponsive)} yes={status?.service.loginUin ?? ''} no="未识别" />
            </span>
            <span className="muted">适配层后端</span>
            <span>
              <Flag ok={Boolean(status?.bridge?.backendOk)} yes="可用" no="不可用" />
            </span>
            <span className="muted">用户确认</span>
            <span>{settings?.messageVerifiedAt ? `已于 ${settings.messageVerifiedAt} 确认真实收到回复` : '尚未确认'}</span>
            <span className="muted">验收结论</span>
            <span>
              {stepOf('verify')?.status === 'done'
                ? '双向消息链路已验证'
                : stepOf('verify')?.status === 'waiting'
                  ? '自动检查已通过，等待你确认真实收发'
                  : stepOf('verify')?.detail ?? '尚未执行'}
            </span>
          </div>
          {stepOf('verify')?.error && <div className="error">{stepOf('verify')!.error}</div>}
          <ol className="muted" style={{ marginTop: 10 }}>
            <li>用手机 QQ 给上面识别出的账号发一条私聊消息。</li>
            <li>Harness 里的模型会处理并回复；你应当在 QQ 里收到回复。</li>
            <li>确认收到后点下面的按钮 —— 这一步不会自动判定成功。</li>
          </ol>
          <div className="row">
            <button
              onClick={() =>
                void run(
                  'verify',
                  async () => {
                    await api.personalVerifyMessage(true);
                    return api.deployStep('verify');
                  },
                  '已记录你的确认',
                )
              }
              disabled={Boolean(busy)}
            >
              我已收到回复
            </button>
            <button onClick={() => void run('verify-recheck', () => api.deployStep('verify'))} disabled={Boolean(busy)}>
              重新执行自动检查
            </button>
            <button
              onClick={() =>
                void run(
                  'verify-clear',
                  async () => {
                    await api.personalVerifyMessage(false);
                    return { ok: true } as ActionResult;
                  },
                  '已撤销确认',
                )
              }
              disabled={Boolean(busy)}
            >
              撤销确认
            </button>
          </div>
        </div>
      )}

      <details className="card">
        <summary>高级信息（日志、配置备份、卸载）</summary>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => void loadAdvanced()}>刷新高级信息</button>
        </div>

        <h4>SnowLuma 配置现状</h4>
        <pre className="log">{config ? JSON.stringify(config, null, 2) : '（点击刷新高级信息）'}</pre>

        <h4>配置备份与恢复</h4>
        {backups.length === 0 && <div className="empty">还没有备份（写入配置前会自动备份）。</div>}
        {backups.map((item) => (
          <div key={item.name} className="row" style={{ marginBottom: 6 }}>
            <span className="muted">{item.name}</span>
            <button
              onClick={() => {
                void run(
                  'restore',
                  async () => {
                    const result = await api.deployConfigRestore(item.name);
                    setNotice(result.evidence.join(' '));
                    return { ok: result.ok } as ActionResult;
                  },
                );
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
        <div className="muted">默认只删除本软件自己的状态；程序文件、配置与 QQ 登录数据必须逐项勾选。</div>
        <label className="row">
          <input
            type="checkbox"
            checked={uninstall.removeOurState}
            onChange={(e) => setUninstall({ ...uninstall, removeOurState: e.target.checked })}
          />
          删除本软件的 SnowLuma 状态（安装记录/暂存/部署记录）
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={uninstall.removeComponent}
            onChange={(e) => setUninstall({ ...uninstall, removeComponent: e.target.checked })}
          />
          删除 SnowLuma 程序文件（只删包内条目）
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={uninstall.removeConfig}
            onChange={(e) => setUninstall({ ...uninstall, removeConfig: e.target.checked })}
          />
          删除 SnowLuma 配置（删除前备份）
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={uninstall.removeUserData}
            onChange={(e) => setUninstall({ ...uninstall, removeUserData: e.target.checked })}
          />
          删除 QQ 登录数据与消息库（不可恢复）
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={uninstall.confirm}
            onChange={(e) => setUninstall({ ...uninstall, confirm: e.target.checked })}
          />
          我确认以上选择
        </label>
        <button
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
        <pre className="log">
          {(status?.evidence ?? []).map((item) => `[${item.source}] ${item.line}`).join('\n') || '（无）'}
        </pre>
      </details>
    </div>
  );
}
