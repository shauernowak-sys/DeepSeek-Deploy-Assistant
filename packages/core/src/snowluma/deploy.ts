import { join } from 'node:path';

import {
  SNOWLUMA_STEP_IDS,
  SNOWLUMA_STEP_LABEL,
  type SnowLumaDeployAuthorization,
  type SnowLumaDeploySnapshot,
  type SnowLumaManifest,
  type SnowLumaStepId,
  type SnowLumaStepState,
  type SnowLumaStepStatus,
} from '@dda/spec';

import { ensureOneBotHttpConfig, inspectConfig, readActiveEndpoint, type ConfigDeps } from './config';
import { ensurePackage, type PackageFsDeps } from './download';
import { checkOneBot, waitForTcp, type HealthDeps } from './health';
import {
  inspectExistingInstall,
  installPackage,
  type InstallFsDeps,
} from './install';
import type { SnowLumaProcessService } from './process';
import { resolveRelease, type ReleaseHttpDeps, type ResolvedRelease } from './release';

/**
 * 个人 QQ 部署编排（M3.3-05/06/07/08 的主干）。
 *
 * 编排器的职责只有一件：**按顺序执行步骤，并把每一步的真实结果写进快照**。
 * 它自己不做 IO，全部通过注入的依赖完成，因此可以脱离 Electron 单测；
 * 界面只读快照，不执行任何下载/安装逻辑。
 *
 * 授权闸门（fail-closed）：`release / download / install / configure / start`
 * 属于 EULA §5.4 需要书面授权的"通过自动化脚本部署"，未授权时一律标记 `blocked`；
 * `precheck / link / verify` 只读或只操作我们自己的插件，任何模式下都可执行。
 */

/** 需要著作权人书面授权的步骤（EULA §5.4："通过自动化脚本部署"）。供本模块内部的闸门判定使用。 */
const GATED_STEPS: readonly SnowLumaStepId[] = ['release', 'download', 'install', 'configure', 'start'];

interface DeployQqState {
  installed: boolean;
  running: boolean;
  path?: string;
}

interface LinkState {
  installed: boolean;
  version?: string;
  bridge?: { ok: boolean; backendOk: boolean; error?: string };
}

interface SnowLumaLinkDeps {
  state(): Promise<LinkState>;
  install(): Promise<void>;
  configure(input: { baseUrl: string; accessToken?: string }): Promise<{ ok: boolean; error?: string }>;
}

export interface SnowLumaDeployDeps {
  platform: NodeJS.Platform;
  release: ReleaseHttpDeps;
  package: PackageFsDeps;
  install: InstallFsDeps;
  config: ConfigDeps;
  process: SnowLumaProcessService;
  health: HealthDeps;
  detectQq(): Promise<DeployQqState>;
  link: SnowLumaLinkDeps;
  now(): Date;
  newId(): string;
  log(level: 'info' | 'warn' | 'error', message: string): Promise<void> | void;
}

export interface RunOptions {
  manifest: SnowLumaManifest;
  authorization: SnowLumaDeployAuthorization;
  installDir: string;
  stateDir: string;
  cacheDir: string;
  onebotPort?: number;
  repair?: boolean;
  /** 用户已确认"真实收到过 QQ 回复"的时间；为空则验收步骤停在"等待用户确认"。 */
  messageVerifiedAt?: string;
  signal?: AbortSignal;
  onUpdate?: (snapshot: SnowLumaDeploySnapshot) => void;
}

interface StepOutcome {
  status: SnowLumaStepStatus;
  detail?: string;
  error?: string;
  hint?: string;
  evidence?: string[];
}

const DEFAULT_WEBUI_TIMEOUT_MS = 60_000;
const DEFAULT_ONEBOT_TIMEOUT_MS = 30_000;

function isCancelled(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { cancelled?: boolean }).cancelled);
}

function createEmptySteps(): SnowLumaStepState[] {
  return SNOWLUMA_STEP_IDS.map((id) => ({
    id,
    label: SNOWLUMA_STEP_LABEL[id],
    status: 'idle' as const,
    evidence: [],
    retryable: true,
  }));
}

export class SnowLumaDeployRunner {
  private snapshot: SnowLumaDeploySnapshot;
  private release?: ResolvedRelease;
  private endpoint?: { baseUrl: string; accessToken?: string; sourceFile: string };
  private startedHere = false;

  constructor(
    private readonly deps: SnowLumaDeployDeps,
    private readonly options: RunOptions,
  ) {
    this.snapshot = {
      id: deps.newId(),
      status: 'idle',
      authorization: options.authorization,
      steps: createEmptySteps(),
      installDir: options.installDir,
      message: '',
      productVersion: options.manifest.version,
    };
  }

  get state(): SnowLumaDeploySnapshot {
    return this.snapshot;
  }

  private get statePaths() {
    return {
      staging: join(this.options.stateDir, 'staging'),
      backup: join(this.options.stateDir, 'backup'),
      configBackups: join(this.options.stateDir, 'config-backups'),
      record: join(this.options.stateDir, 'install.json'),
    };
  }

  private emit(): void {
    this.options.onUpdate?.(this.snapshot);
  }

  private step(id: SnowLumaStepId): SnowLumaStepState {
    const found = this.snapshot.steps.find((item) => item.id === id);
    if (!found) throw new Error(`unknown step ${id}`);
    return found;
  }

  private beginStep(id: SnowLumaStepId): void {
    const step = this.step(id);
    step.status = 'running';
    step.startedAt = this.deps.now().toISOString();
    step.error = undefined;
    step.hint = undefined;
    step.detail = undefined;
    step.evidence = [];
    step.progress = undefined;
    step.finishedAt = undefined;
    this.emit();
  }

  private endStep(id: SnowLumaStepId, outcome: StepOutcome): void {
    const step = this.step(id);
    step.status = outcome.status;
    step.detail = outcome.detail;
    step.error = outcome.error;
    step.hint = outcome.hint;
    step.finishedAt = this.deps.now().toISOString();
    if (outcome.evidence?.length) step.evidence.push(...outcome.evidence);
    this.emit();
  }

  private isGated(id: SnowLumaStepId): boolean {
    return GATED_STEPS.includes(id) && !this.options.authorization.allowed;
  }

  /** 依次执行所有步骤；被授权闸门拦住的步骤记为 blocked，其余步骤照常执行。 */
  async run(): Promise<SnowLumaDeploySnapshot> {
    this.snapshot.status = 'running';
    this.snapshot.startedAt = this.deps.now().toISOString();
    this.snapshot.finishedAt = undefined;
    this.emit();

    let failed = false;
    for (const id of SNOWLUMA_STEP_IDS) {
      if (this.options.signal?.aborted) {
        this.cancelRemaining(id);
        break;
      }
      if (this.isGated(id)) {
        this.markBlocked(id);
        continue;
      }
      if (failed) {
        this.markSkipped(id, '前一步未完成，已跳过');
        continue;
      }
      const outcome = await this.execute(id);
      if (outcome.status === 'failed' || outcome.status === 'cancelled') failed = true;
    }

    this.snapshot.finishedAt = this.deps.now().toISOString();
    this.snapshot.status = this.deriveStatus();
    this.snapshot.message = this.describe();
    this.emit();
    await this.deps.log('info', `snowluma deploy finished: ${this.snapshot.status}`);
    return this.snapshot;
  }

  /** 单步重跑（UI 的"重新执行"按钮）。前置步骤的结论会保留。 */
  async runStep(id: SnowLumaStepId): Promise<SnowLumaDeploySnapshot> {
    if (this.isGated(id)) {
      this.markBlocked(id);
      this.snapshot.status = this.deriveStatus();
      this.snapshot.message = this.describe();
      this.emit();
      return this.snapshot;
    }
    this.snapshot.status = 'running';
    this.snapshot.startedAt = this.snapshot.startedAt ?? this.deps.now().toISOString();
    const outcome = await this.execute(id);
    // 重跑某一步成功后，把它之后因失败被跳过的步骤恢复为 idle，允许继续点"继续部署"。
    if (outcome.status === 'done') {
      const index = SNOWLUMA_STEP_IDS.indexOf(id);
      for (const later of SNOWLUMA_STEP_IDS.slice(index + 1)) {
        const step = this.step(later);
        if (step.status === 'skipped' || step.status === 'failed') {
          step.status = 'idle';
          step.error = undefined;
          step.detail = undefined;
          step.evidence = [];
        }
      }
    }
    this.snapshot.finishedAt = this.deps.now().toISOString();
    this.snapshot.status = this.deriveStatus();
    this.snapshot.message = this.describe();
    this.emit();
    return this.snapshot;
  }

  async cancel(): Promise<void> {
    if (this.startedHere) {
      await this.deps.process.stop().catch(() => undefined);
      this.startedHere = false;
    }
    this.snapshot.status = 'cancelled';
    this.snapshot.finishedAt = this.deps.now().toISOString();
    this.snapshot.message = '已取消本次部署；已下载的安装包与已有安装都未被删除。';
    for (const step of this.snapshot.steps) {
      if (step.status === 'running') {
        step.status = 'cancelled';
        step.finishedAt = this.snapshot.finishedAt;
      } else if (step.status === 'idle') {
        step.status = 'cancelled';
      }
    }
    this.emit();
  }

  private cancelRemaining(fromId: SnowLumaStepId): void {
    const index = SNOWLUMA_STEP_IDS.indexOf(fromId);
    for (const id of SNOWLUMA_STEP_IDS.slice(index)) {
      const step = this.step(id);
      if (step.status === 'idle' || step.status === 'running') step.status = 'cancelled';
    }
    this.snapshot.status = 'cancelled';
    this.snapshot.finishedAt = this.deps.now().toISOString();
    this.snapshot.message = '已取消本次部署；已下载的安装包与已有安装都未被删除。';
    this.emit();
  }

  private markBlocked(id: SnowLumaStepId): void {
    const step = this.step(id);
    step.status = 'blocked';
    step.detail = '受上游许可限制，未获书面授权时不会执行';
    step.error = this.options.authorization.reason;
    step.hint = '可先按"手动安装后检测"的方式使用：从官方 Releases 下载解压，再回到本页选择目录。';
    step.evidence = [
      '许可依据：SnowLuma EULA §5.4 —— 将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署，均须事先取得书面授权',
      this.options.authorization.authorizationRef
        ? `已登记授权文号：${this.options.authorization.authorizationRef}`
        : '未登记著作权人书面授权（清单 authorizationRef 为空）',
    ];
    this.emit();
  }

  private markSkipped(id: SnowLumaStepId, reason: string): void {
    const step = this.step(id);
    step.status = 'skipped';
    step.detail = reason;
    step.finishedAt = this.deps.now().toISOString();
    this.emit();
  }

  private deriveStatus(): SnowLumaDeploySnapshot['status'] {
    if (this.snapshot.steps.some((step) => step.status === 'running')) return 'running';
    const gated = this.snapshot.steps.filter((step) => step.status === 'blocked');
    if (gated.length > 0) return 'blocked';
    if (this.snapshot.steps.some((step) => step.status === 'cancelled')) return 'cancelled';
    if (this.snapshot.steps.some((step) => step.status === 'failed')) return 'failed';
    if (this.snapshot.steps.some((step) => step.status === 'waiting')) return 'waiting';
    if (this.snapshot.steps.every((step) => step.status === 'done' || step.status === 'skipped')) return 'done';
    // 只跑了部分步骤（例如单独重跑「环境检查」）：既没在跑也没失败，回到可继续的初始态。
    return 'idle';
  }

  private describe(): string {
    switch (this.snapshot.status) {
      case 'done':
        return '个人 QQ 链路已按步骤完成并通过验证。';
      case 'failed': {
        const failedStep = this.snapshot.steps.find((step) => step.status === 'failed');
        return failedStep ? `第「${failedStep.label}」步失败：${failedStep.error ?? failedStep.detail ?? '未知原因'}` : '部署失败';
      }
      case 'blocked':
        return this.options.authorization.reason;
      case 'cancelled':
        return '已取消本次部署；已下载的安装包与已有安装都未被删除。';
      default: {
        const waiting = this.snapshot.steps.find((step) => step.status === 'waiting');
        if (waiting) return `等待你操作：${waiting.detail ?? waiting.label}`;
        return '部署进行中';
      }
    }
  }

  private async execute(id: SnowLumaStepId): Promise<StepOutcome> {
    this.beginStep(id);
    let outcome: StepOutcome;
    try {
      outcome = await this.runImpl(id);
    } catch (error) {
      if (isCancelled(error)) {
        outcome = { status: 'cancelled', detail: '已取消', error: '已取消本次操作' };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        outcome = {
          status: 'failed',
          error: message,
          hint: (error as { hint?: string })?.hint,
        };
        await this.deps.log('error', `snowluma step ${id} failed: ${message}`);
      }
    }
    if (outcome.status === 'running') {
      // 防御：实现里不允许返回 running。
      outcome = { ...outcome, status: 'failed', error: '内部状态异常' };
    }
    this.endStep(id, outcome);
    return outcome;
  }

  private async runImpl(id: SnowLumaStepId): Promise<StepOutcome> {
    switch (id) {
      case 'precheck':
        return this.precheck();
      case 'release':
        return this.releaseStep();
      case 'download':
        return this.downloadStep();
      case 'install':
        return this.installStep();
      case 'configure':
        return this.configureStep();
      case 'start':
        return this.startStep();
      case 'link':
        return this.linkStep();
      case 'verify':
        return this.verifyStep();
    }
  }

  private async precheck(): Promise<StepOutcome> {
    const evidence: string[] = [];
    if (this.deps.platform !== 'win32') {
      return {
        status: 'failed',
        error: `当前系统是 ${this.deps.platform}，本产品只支持 Windows x64`,
        hint: '请在 Windows 10/11 x64 上运行',
      };
    }
    evidence.push(`系统：${this.deps.platform}（${process.arch}）`);

    const qq: DeployQqState = await this.deps.detectQq().catch(() => ({ installed: false, running: false }));
    evidence.push(qq.installed ? `QQ 客户端：已安装${qq.path ? `（${qq.path}）` : ''}` : 'QQ 客户端：未检测到');
    evidence.push(qq.running ? 'QQ 进程：正在运行' : 'QQ 进程：未运行');
    if (!qq.installed) {
      return {
        status: 'failed',
        error: '没有检测到桌面版 QQ（NTQQ）',
        hint: '请先从 im.qq.com 安装官方桌面版 QQ 并登录一次，再回到这里。',
        evidence,
      };
    }

    const existing = await inspectExistingInstall(this.deps.install, this.options.installDir);
    evidence.push(
      existing.installed
        ? `安装目录：已存在 SnowLuma ${existing.version ?? '(版本未知)'}（${this.options.installDir}）`
        : `安装目录：${this.options.installDir} 尚未安装 SnowLuma`,
    );
    if (existing.hasConfig) evidence.push('用户数据：检测到 config/（不会被覆盖）');
    if (existing.hasUserData) evidence.push('用户数据：检测到 data/（QQ 登录态，不会被覆盖）');

    const free = await this.deps.install.freeBytes(this.options.installDir).catch(() => undefined);
    if (free !== undefined) {
      evidence.push(`磁盘：可用 ${(free / 1024 / 1024).toFixed(0)} MB`);
      if (free < 200 * 1024 * 1024) {
        return {
          status: 'failed',
          error: '磁盘可用空间不足 200 MB',
          hint: '清理磁盘后重试；已下载的安装包会保留',
          evidence,
        };
      }
    }

    return {
      status: 'done',
      detail: existing.installed ? '环境就绪（已有安装将被复用/升级）' : '环境就绪',
      evidence,
    };
  }

  private async releaseStep(): Promise<StepOutcome> {
    const release = await resolveRelease(this.deps.release, this.options.manifest);
    this.release = release;
    await this.deps.log(
      'info',
      `snowluma release resolved v${release.version} (${release.verifiedAgainst})`,
    );
    return {
      status: 'done',
      detail: `锁定 v${release.version}（${release.verifiedAgainst === 'manifest+github' ? '已与 GitHub 核对' : '仅按内置清单'}）`,
      evidence: release.evidence,
    };
  }

  private async downloadStep(): Promise<StepOutcome> {
    const release = this.release ?? (await resolveRelease(this.deps.release, this.options.manifest));
    this.release = release;
    const step = this.step('download');
    const result = await ensurePackage(this.deps.package, {
      release,
      cacheDir: this.options.cacheDir,
      signal: this.options.signal,
      onProgress: (progress) => {
        step.progress = progress;
        step.detail =
          progress.percent === undefined
            ? `已下载 ${(progress.receivedBytes / 1024 / 1024).toFixed(1)} MB`
            : `已下载 ${progress.percent}%`;
        this.emit();
      },
    });
    step.progress = {
      receivedBytes: release.sizeBytes,
      totalBytes: release.sizeBytes,
      percent: 100,
      speedBps: 0,
      etaSeconds: 0,
    };
    return {
      status: 'done',
      detail: result.reused ? '复用已校验的安装包（未重复下载）' : '下载完成并通过 SHA-256 校验',
      evidence: result.evidence,
    };
  }

  private async installStep(): Promise<StepOutcome> {
    const release = this.release;
    if (!release) {
      return { status: 'failed', error: '还没有解析官方版本', hint: '先执行「获取官方版本」' };
    }
    const paths = this.statePaths;
    const step = this.step('install');
    const result = await installPackage(this.deps.install, {
      zipPath: join(this.options.cacheDir, release.fileName),
      installDir: this.options.installDir,
      expectedVersion: release.version,
      sha256: release.sha256,
      sizeBytes: release.sizeBytes,
      sourceUrl: release.url,
      fileName: release.fileName,
      stagingDir: paths.staging,
      backupDir: paths.backup,
      recordPath: paths.record,
      repair: this.options.repair,
      signal: this.options.signal,
      onProgress: (info) => {
        step.detail = `正在${info.phase === 'extract' ? '解压' : info.phase === 'swap' ? '替换文件' : '校验'}（${info.files} 项）`;
        this.emit();
      },
    });
    return {
      status: 'done',
      detail: result.changed
        ? `已安装 v${result.version}${result.upgraded ? '（覆盖升级，用户配置已保留）' : ''}`
        : `已是 v${result.version}，未重复解压`,
      evidence: result.evidence,
    };
  }

  private async configureStep(): Promise<StepOutcome> {
    const port = this.options.onebotPort ?? this.options.manifest.ports.onebotHttp;
    const inspection = await inspectConfig(this.deps.config, { installDir: this.options.installDir });
    const evidence = [
      `配置目录：${inspection.configDir}（${inspection.exists ? '存在' : '不存在'}）`,
      ...(inspection.problem ? [`配置现状：${inspection.problem}`] : []),
      ...(inspection.sourceFile ? [`生效配置：${inspection.sourceFile}`] : []),
    ];

    const ensured = await ensureOneBotHttpConfig(this.deps.config, {
      installDir: this.options.installDir,
      port,
      backupRoot: this.statePaths.configBackups,
    });
    evidence.push(...ensured.evidence);

    const endpoint = await readActiveEndpoint(this.deps.config, { installDir: this.options.installDir });
    if (!endpoint) {
      return {
        status: 'failed',
        error: '写入后仍读不到可用的 OneBot HTTP 端点',
        hint: '打开 SnowLuma WebUI → 连接配置，确认 OneBot v11 HTTP 已启用（默认 127.0.0.1:3000）',
        evidence,
      };
    }
    this.endpoint = endpoint;
    evidence.push(`端点：${endpoint.baseUrl}（来源 ${endpoint.sourceFile}，令牌${endpoint.accessToken ? '已读取' : '为空'}）`);
    return {
      status: 'done',
      detail: `OneBot HTTP 已就绪：${endpoint.baseUrl}`,
      evidence,
    };
  }

  private async startStep(): Promise<StepOutcome> {
    const evidence: string[] = [];
    const status = this.deps.process.status;
    if (status.running) {
      evidence.push(`启动：已由本软件启动并仍在运行（pid ${status.pid}），不重复启动`);
    } else {
      const started = await this.deps.process.start({
        installDir: this.options.installDir,
        nodeExePath: join(this.options.installDir, 'node.exe'),
        entry: this.options.manifest.layout.entry,
      });
      this.startedHere = true;
      evidence.push(`启动：已启动 SnowLuma（pid ${started.pid}，cwd=${this.options.installDir}）`);
    }

    const webuiPort = this.options.manifest.ports.webui;
    const webui = await waitForTcp(this.deps.health, {
      host: '127.0.0.1',
      port: webuiPort,
      timeoutMs: DEFAULT_WEBUI_TIMEOUT_MS,
      label: 'SnowLuma WebUI',
    });
    if (!webui.ok) {
      const exited = this.deps.process.status.exited;
      const tail = this.deps.process.outputTail.slice(-5);
      return {
        status: 'failed',
        error: exited
          ? `SnowLuma 启动后退出（code=${exited.code ?? 'null'}）${tail.length ? `：${tail.join(' | ')}` : ''}`
          : (webui.error ?? 'WebUI 未在预期时间内就绪'),
        hint: exited ? '展开日志查看原因；常见原因是 QQ 未登录或版本不受支持' : '检查 5099 端口是否被占用，或查看下方日志',
        evidence: [...evidence, ...tail.map((line) => `输出：${line}`)],
      };
    }
    evidence.push(`WebUI：http://127.0.0.1:${webuiPort} 已可连接（${webui.elapsedMs} ms）`);

    const onebotPort = this.endpoint ? Number(new URL(this.endpoint.baseUrl).port || 80) : this.options.manifest.ports.onebotHttp;
    const onebot = await waitForTcp(this.deps.health, {
      host: '127.0.0.1',
      port: onebotPort,
      timeoutMs: DEFAULT_ONEBOT_TIMEOUT_MS,
      label: 'OneBot HTTP',
    });
    evidence.push(
      onebot.ok
        ? `OneBot HTTP：127.0.0.1:${onebotPort} 已监听`
        : `OneBot HTTP：127.0.0.1:${onebotPort} 尚未监听（通常表示还没登录 QQ）`,
    );

    return {
      status: 'done',
      detail: onebot.ok ? 'SnowLuma 已启动，OneBot HTTP 已监听' : 'SnowLuma 已启动；OneBot 需要登录 QQ 后才会监听',
      evidence,
    };
  }

  private async linkStep(): Promise<StepOutcome> {
    const evidence: string[] = [];
    let state = await this.deps.link.state();
    evidence.push(
      state.installed
        ? `适配插件：dsh-qq-link 已安装${state.version ? ` v${state.version}` : ''}`
        : '适配插件：未安装，准备安装',
    );
    if (!state.installed) {
      await this.deps.link.install();
      state = await this.deps.link.state();
      evidence.push(state.installed ? '适配插件：安装完成' : '适配插件：安装后仍未检测到（Harness 可能未运行）');
      if (!state.installed) {
        return {
          status: 'failed',
          error: '适配插件安装后仍不可用',
          hint: '先启动 Harness（第 2 节），再重试这一步。',
          evidence,
        };
      }
    }

    const endpoint =
      this.endpoint ?? (await readActiveEndpoint(this.deps.config, { installDir: this.options.installDir }));
    if (!endpoint) {
      return {
        status: 'failed',
        error: '读不到 SnowLuma 的 OneBot 端点，无法配置适配插件',
        hint: '先确认 SnowLuma 已启动并生成 config/onebot.json',
        evidence,
      };
    }
    this.endpoint = endpoint;
    const configured = await this.deps.link.configure({
      baseUrl: endpoint.baseUrl,
      accessToken: endpoint.accessToken,
    });
    evidence.push(
      configured.ok
        ? `已把端点 ${endpoint.baseUrl} 写入适配插件（令牌只留在主进程，不回显）`
        : `写入适配插件配置失败：${configured.error ?? '未知错误'}`,
    );
    if (!configured.ok) {
      return {
        status: 'failed',
        error: configured.error ?? '写入适配插件配置失败',
        hint: '确认 Harness 正在运行且 dsh-qq-link 已加载',
        evidence,
      };
    }

    const after = await this.deps.link.state();
    if (after.bridge) {
      evidence.push(
        after.bridge.ok
          ? `Bridge 状态接口：ok（后端${after.bridge.backendOk ? '可用' : `不可用：${after.bridge.error ?? '未知'}`}）`
          : `Bridge 状态接口：不可读`,
      );
    }
    return {
      status: 'done',
      detail: after.bridge?.backendOk
        ? '适配插件已联通 SnowLuma 后端'
        : '适配插件已配置；SnowLuma 后端还不可用（通常在 QQ 登录后恢复）',
      evidence,
    };
  }

  private async verifyStep(): Promise<StepOutcome> {
    const evidence: string[] = [];
    const endpoint =
      this.endpoint ?? (await readActiveEndpoint(this.deps.config, { installDir: this.options.installDir }));
    if (!endpoint) {
      return {
        status: 'failed',
        error: '读不到 OneBot 端点',
        hint: '确认 SnowLuma 已启动并完成 QQ 登录',
        evidence,
      };
    }
    const onebot = await checkOneBot(this.deps.health, {
      baseUrl: endpoint.baseUrl,
      accessToken: endpoint.accessToken,
    });
    if (!onebot.responsive) {
      return {
        status: 'failed',
        error: onebot.error ?? 'OneBot 未返回真实 QQ 号',
        hint: '打开 SnowLuma WebUI 完成 QQ 扫码登录；登录后 OneBot 才会返回账号信息',
        evidence,
      };
    }
    this.endpoint = endpoint;
    evidence.push(`OneBot get_login_info：QQ ${onebot.uin}${onebot.nickname ? `（${onebot.nickname}）` : ''}`);

    const link = await this.deps.link.state();
    if (!link.bridge?.ok) {
      return {
        status: 'failed',
        error: '适配插件状态接口不可读',
        hint: '确认 Harness 正在运行，且 dsh-qq-link 已加载',
        evidence,
      };
    }
    evidence.push(`Bridge：ok；后端${link.bridge.backendOk ? '可用' : `不可用（${link.bridge.error ?? '未知'}）`}`);
    if (!link.bridge.backendOk) {
      return {
        status: 'failed',
        error: `适配插件访问不到 OneBot 后端：${link.bridge.error ?? '未知'}`,
        hint: '在「联通 Harness」里重新写入端点与令牌，再重试',
        evidence,
      };
    }

    if (!this.options.messageVerifiedAt) {
      return {
        status: 'waiting',
        detail: `自动检查已全部通过。请用手机 QQ 给 ${onebot.uin} 发一条消息，并在 QQ 里看到回复后点击「我已收到回复」。`,
        hint: '本步骤不会自动判定成功：必须由你确认真实收到过回复。',
        evidence,
      };
    }
    evidence.push(`用户确认：已于 ${this.options.messageVerifiedAt} 真实收到 QQ 回复`);
    return {
      status: 'done',
      detail: '双向消息链路已通过（真实 OneBot + 真实用户确认）',
      evidence,
    };
  }
}
