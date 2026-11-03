import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  SnowLumaDeployRunner,
  SnowLumaProcessService,
  createNodeBridgeDeps,
  createNodeConfigDeps,
  createNodeDetectionDeps,
  createNodeInstallDeps,
  createNodePackageDeps,
  createNodeSpawnDeps,
  detectQqnt,
  discoverInstallDirs,
  inspectConfig,
  listConfigBackups,
  readBridgeState,
  restoreConfig,
  uninstallSnowLuma,
  verifyInstallDir,
  type BridgeHttpDeps,
  type ConfigDeps,
  type DetectionDeps,
  type HealthDeps,
  type InstallFsDeps,
  type PackageFsDeps,
  type ReleaseHttpDeps,
  type SnowLumaDeployDeps,
  type UninstallResult,
} from '@dda/core';
import {
  SNOWLUMA_STEP_IDS,
  SNOWLUMA_STEP_LABEL,
  type InstallVerification,
  type SnowLumaDeploySnapshot,
  type SnowLumaInstallDiscovery,
  type SnowLumaManifest,
  type SnowLumaProcessStatus,
  type SnowLumaStartDeployInput,
  type SnowLumaStepId,
  type SnowLumaUninstallInput,
} from '@dda/spec';

import { ADAPTER_PLUGIN, type PersonalQqService } from './personal-qq-service';
import type { Container } from './container';
import type { HarnessService } from './harness-service';

/**
 * 主进程侧的个人 QQ 部署服务（M3.3-05 ~ M3.3-10 的接线层）。
 *
 * 职责边界：
 *  - 这里**只做编排与依赖装配**，具体 IO 都在 `@dda/core/snowluma/*` 里，可脱离 Electron 单测；
 *  - 渲染层永远不接触文件系统、进程与令牌，只读快照；
 *  - 快照会持久化到 `state/snowluma/deployment.json`，应用重启后仍能看到上次结论。
 */

export interface SnowLumaDeploymentServiceDeps {
  detection?: DetectionDeps;
  releaseHttp?: ReleaseHttpDeps;
  package?: PackageFsDeps;
  install?: InstallFsDeps;
  config?: ConfigDeps;
  health?: HealthDeps;
  bridge?: BridgeHttpDeps;
  spawn?: ReturnType<typeof createNodeSpawnDeps>;
  now?: () => Date;
  /** 环境变量（便于测试注入；默认 process.env）。 */
  env?: Record<string, string | undefined>;
  /** 快照变化回调（注册层用它推送 IPC 事件）。 */
  onUpdate?: (snapshot: SnowLumaDeploySnapshot) => void;
  /** 安装目录的默认根（便于测试注入）。 */
  managedRoot?: string;
}

const EMIT_INTERVAL_MS = 400;
const PERSIST_INTERVAL_MS = 1500;

export class SnowLumaDeploymentService {
  private readonly detection: DetectionDeps;
  private readonly releaseHttp: ReleaseHttpDeps;
  private readonly packageDeps: PackageFsDeps;
  private readonly installDeps: InstallFsDeps;
  private readonly configDeps: ConfigDeps;
  private readonly healthDeps: HealthDeps;
  private readonly bridgeDeps: BridgeHttpDeps;
  private readonly processService: SnowLumaProcessService;

  private runner?: SnowLumaDeployRunner;
  private controller?: AbortController;
  private current?: SnowLumaDeploySnapshot;
  private lastEmitAt = 0;
  private lastPersistAt = 0;
  private lastStatus?: string;

  constructor(
    private readonly container: Container,
    private readonly harness: HarnessService,
    private readonly personal: PersonalQqService,
    private readonly deps: SnowLumaDeploymentServiceDeps = {},
  ) {
    this.detection = deps.detection ?? createNodeDetectionDeps();
    this.releaseHttp = deps.releaseHttp ?? { getJson: (url, init) => this.detection.getJson(url, init ?? {}) };
    this.packageDeps = deps.package ?? createNodePackageDeps();
    this.installDeps = deps.install ?? createNodeInstallDeps();
    this.configDeps = deps.config ?? createNodeConfigDeps();
    this.healthDeps =
      deps.health ?? {
        connect: (host, port, timeoutMs) => this.detection.connect(host, port, timeoutMs),
        getJson: (url, init) => this.detection.getJson(url, init ?? {}),        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      };
    this.bridgeDeps = deps.bridge ?? createNodeBridgeDeps();
    this.processService = new SnowLumaProcessService(deps.spawn ?? createNodeSpawnDeps());
  }

  get managedInstallDir(): string {
    return this.deps.managedRoot ?? join(this.container.paths.root, 'components', 'snowluma');
  }

  private get stateDir(): string {
    return join(this.container.paths.root, 'state', 'snowluma');
  }

  private get snapshotPath(): string {
    return join(this.stateDir, 'deployment.json');
  }

  /** 供状态页展示：真实的 SnowLuma 进程状态（pid/退出码/输出尾部）。 */
  get processInfo(): SnowLumaProcessStatus {
    return this.processService.status;
  }

  async snapshot(): Promise<SnowLumaDeploySnapshot> {
    if (this.current) return this.current;
    const manifest = await this.personal.manifest();
    const authorization = await this.authorization(manifest);
    const installDir = await this.resolveInstallDir();
    try {
      const raw = JSON.parse(await readFile(this.snapshotPath, 'utf8')) as SnowLumaDeploySnapshot;
      if (raw && Array.isArray(raw.steps) && raw.steps.length === SNOWLUMA_STEP_IDS.length) {
        // 授权结论以当前清单为准（清单变更后旧快照里的 slot 可能已过时）。
        this.current = { ...raw, authorization, installDir };
        return this.current;
      }
    } catch {
      // 没有历史快照：返回空白快照。
    }
    this.current = {
      id: 'idle',
      status: 'idle',
      authorization,
      installDir,
      steps: SNOWLUMA_STEP_IDS.map((id) => ({
        id,
        label: SNOWLUMA_STEP_LABEL[id],
        status: 'idle' as const,
        evidence: [],
        retryable: true,
      })),
      message: '还没有执行过部署。点击"开始部署"会依次执行环境检查、下载、安装、配置、启动与联通。',
      productVersion: manifest.version,
    };
    return this.current;
  }

  private async authorization(manifest: SnowLumaManifest): Promise<SnowLumaDeploySnapshot['authorization']> {
    const { decideManifestAutomation } = await import('@dda/core');
    const decision = decideManifestAutomation(manifest);
    return {
      allowed: decision.allowed,
      mode: decision.allowed ? 'auto' : 'guided',
      reason: decision.reason,
      authorizationRef: manifest.authorizationRef,
    };
  }

  private async resolveInstallDir(explicit?: string): Promise<string> {
    if (explicit && isAbsolute(explicit)) return explicit;
    const settings = await this.personal.settings();
    if (settings.installDir && isAbsolute(settings.installDir)) return settings.installDir;
    const discovered = await this.personal.discoverInstallDir(settings);
    if (discovered) return discovered;
    return this.managedInstallDir;
  }

  /** 只读依赖（安装定位/校验用）。 */
  private get locateDeps() {
    return {
      exists: (path: string) => this.installDeps.exists(path),
      readFile: (path: string) => this.installDeps.readFile(path, 'utf8'),
      readdir: (path: string) => this.installDeps.readdir(path),
    };
  }

  /**
   * 在常见位置找已安装的 SnowLuma（M3.3.1 第三步）。
   * 只读扫描；返回每个候选的逐项校验结果，供 UI 让用户确认。
   */
  async discoverInstall(): Promise<SnowLumaInstallDiscovery> {
    const manifest = await this.personal.manifest();
    const settings = await this.personal.settings();
    const candidates = await discoverInstallDirs(this.locateDeps, {
      env: this.deps.env ?? process.env,
      expectedVersion: manifest.version,
      managedDir: this.managedInstallDir,
      settingsDir: settings.installDir,
    });
    const selected =
      candidates.find((item) => item.verification.valid)?.verification ?? candidates[0]?.verification;
    await this.container.logger.info(
      'snowluma',
      `install discovery: ${candidates.length} candidate(s), selected=${selected?.installDir ?? 'none'}`,
    );
    return { expectedVersion: manifest.version, candidates, selected };
  }

  /** 校验指定目录（缺省用当前解析出来的目录）。 */
  async verifyInstall(installDir?: string): Promise<InstallVerification> {
    const manifest = await this.personal.manifest();
    const dir = installDir ?? (await this.resolveInstallDir());
    return verifyInstallDir(this.locateDeps, { installDir: dir, expectedVersion: manifest.version });
  }

  /**
   * 用户点「我已完成安装」/选择目录后确认使用该目录。
   * 只有确实有 release.json 才写入设置（避免把乱选的目录存下来）。
   */
  async useInstallDir(installDir: string): Promise<{
    ok: boolean;
    verification: InstallVerification;
    message: string;
  }> {
    const manifest = await this.personal.manifest();
    const verification = await verifyInstallDir(this.locateDeps, {
      installDir,
      expectedVersion: manifest.version,
    });
    if (!verification.exists || !verification.installDir) {
      return {
        ok: false,
        verification,
        message: verification.problems[0] ?? '这个目录里没有 release.json',
      };
    }
    const finalDir = verification.installDir;
    const settings = await this.personal.settings();
    await this.personal.saveSettings({ ...settings, installDir: finalDir });
    if (this.current) this.current = { ...this.current, installDir: finalDir };
    await this.container.logger.info(
      'snowluma',
      `install dir set to ${finalDir} (valid=${verification.valid}, version=${verification.version ?? 'unknown'})`,
    );
    return {
      ok: true,
      verification,
      message: verification.valid
        ? `已使用 ${finalDir}（v${verification.version ?? '未知'}）`
        : `已记录目录，但校验未完全通过：${verification.problems[0] ?? '未知问题'}`,
    };
  }

  private async buildDeps(): Promise<SnowLumaDeployDeps> {
    const detection = this.detection;
    return {
      platform: process.platform,
      release: this.releaseHttp,
      package: this.packageDeps,
      install: this.installDeps,
      config: this.configDeps,
      process: this.processService,
      health: this.healthDeps,
      async detectQq() {
        const qq = await detectQqnt({
          exists: (path) => detection.exists(path),
          listProcesses: () => detection.listProcesses(),
          env: process.env,
        });
        return { installed: qq.installed, running: qq.running, path: qq.path };
      },
      link: {
        state: async () => {
          const plugins = await this.harness.listPlugins().catch(() => []);
          const found = plugins.find((item) => item.name === ADAPTER_PLUGIN);
          const auth = this.harness.auth();
          let bridge: { ok: boolean; backendOk: boolean; error?: string } | undefined;
          if (found?.installed && auth) {
            const result = await readBridgeState(this.bridgeDeps, { baseUrl: auth.baseUrl, token: auth.token });
            bridge = {
              ok: result.ok,
              backendOk: result.backendOk,
              error: result.errorMessage ?? result.backendError,
            };
          }
          return { installed: Boolean(found?.installed), version: found?.version, bridge };
        },
        install: async () => {
          const result = await this.personal.installAdapter();
          if (!result.ok) throw new Error(result.message);
        },
        configure: async (input) => {
          const result = await this.personal.applyBridgeEndpoint(input);
          return { ok: result.ok, error: result.ok ? undefined : result.message };
        },
      },
      now: () => (this.deps.now ? this.deps.now() : new Date()),
      newId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      log: (level, message) => this.container.logger[level]('snowluma', message),
    };
  }

  private handleUpdate = (snapshot: SnowLumaDeploySnapshot): void => {
    this.current = snapshot;
    const now = Date.now();
    const statusChanged = this.lastStatus !== snapshot.status;
    if (statusChanged || now - this.lastEmitAt >= EMIT_INTERVAL_MS) {
      this.lastEmitAt = now;
      this.lastStatus = snapshot.status;
      this.deps.onUpdate?.(snapshot);
    }
    if (statusChanged || now - this.lastPersistAt >= PERSIST_INTERVAL_MS) {
      this.lastPersistAt = now;
      void this.persist(snapshot);
    }
  };

  private async persist(snapshot: SnowLumaDeploySnapshot): Promise<void> {
    try {
      await mkdir(this.stateDir, { recursive: true });
      await writeFile(this.snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (error) {
      await this.container.logger.warn(
        'snowluma',
        `failed to persist deployment snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async createRunner(installDir: string, options: { repair?: boolean }): Promise<SnowLumaDeployRunner> {
    const manifest = await this.personal.manifest();
    const settings = await this.personal.settings();
    const authorization = await this.authorization(manifest);
    this.controller = new AbortController();
    return new SnowLumaDeployRunner(await this.buildDeps(), {
      manifest,
      authorization,
      installDir,
      stateDir: this.stateDir,
      cacheDir: this.container.paths.downloads,
      onebotPort: settings.onebotHttpPort,
      repair: options.repair,
      messageVerifiedAt: settings.messageVerifiedAt,
      signal: this.controller.signal,
      onUpdate: this.handleUpdate,
    });
  }

  /** 启动完整部署：立即返回快照，后续进度通过事件推送。 */
  async start(input: SnowLumaStartDeployInput): Promise<SnowLumaDeploySnapshot> {
    if (this.runner && this.current?.status === 'running') return this.current;
    const installDir = await this.resolveInstallDir(input.installDir);
    const settings = await this.personal.settings();
    if (settings.installDir !== installDir) {
      await this.personal.saveSettings({ ...settings, installDir });
    }
    const runner = await this.createRunner(installDir, { repair: input.repair });
    this.runner = runner;
    void runner
      .run()
      .catch(async (error) => {
        await this.container.logger.error(
          'snowluma',
          `deployment crashed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return runner.state;
  }

  /** 单步重跑（失败后"重新执行"）。 */
  async retryStep(stepId: SnowLumaStepId): Promise<SnowLumaDeploySnapshot> {
    // 取消过之后旧的 AbortSignal 已触发，必须用新的 runner，否则下载/安装会立刻被判为取消。
    if (!this.runner || !this.current || this.controller?.signal.aborted) {
      const installDir = await this.resolveInstallDir();
      this.runner = await this.createRunner(installDir, {});
    }
    return this.runner.runStep(stepId);
  }

  async cancel(): Promise<SnowLumaDeploySnapshot> {
    this.controller?.abort();
    if (this.runner) {
      await this.runner.cancel();
      return this.runner.state;
    }
    return this.snapshot();
  }

  async stopProcess(): Promise<{ ok: boolean; message: string }> {
    const status = this.processService.status;
    if (!status.running) return { ok: true, message: 'SnowLuma 当前没有运行' };
    await this.processService.stop();
    await this.container.logger.info('snowluma', `stopped pid=${status.pid ?? 'unknown'}`);
    return { ok: true, message: '已停止 SnowLuma（不会删除任何文件）' };
  }

  async webuiCredentials(): Promise<{ user: string; password: string } | undefined> {
    return this.processService.webuiBootstrapCredentials;
  }

  async outputTail(count = 30): Promise<string[]> {
    return this.processService.outputTail.slice(-count);
  }

  async configBackups(): Promise<{ name: string; path: string }[]> {
    const root = join(this.stateDir, 'config-backups');
    const names = await listConfigBackups(this.configDeps, root);
    return names.map((name) => ({ name, path: join(root, name) }));
  }

  async restoreConfigBackup(name: string): Promise<{ ok: boolean; evidence: string[] }> {
    if (!/^config-[0-9TZ:.+-]+$/.test(name)) {
      return { ok: false, evidence: ['配置恢复：备份名不合法'] };
    }
    const installDir = await this.resolveInstallDir();
    const result = await restoreConfig(this.configDeps, {
      configDir: join(installDir, 'config'),
      backupDir: join(this.stateDir, 'config-backups', name),
    });
    await this.container.logger.info('snowluma', `config restore ${name}: ${result.restored}`);
    return { ok: result.restored, evidence: result.evidence };
  }

  /** 当前配置现状（只读，令牌不外泄）。 */
  async configInspection(): Promise<Awaited<ReturnType<typeof inspectConfig>>> {
    const installDir = await this.resolveInstallDir();
    return inspectConfig(this.configDeps, { installDir });
  }

  async uninstall(input: SnowLumaUninstallInput): Promise<UninstallResult> {
    await this.processService.stop().catch(() => undefined);
    const installDir = await this.resolveInstallDir();
    const result = await uninstallSnowLuma(this.configDeps, {
      installDir,
      ourStateDir: this.stateDir,
      backupRoot: join(this.container.paths.root, 'state', 'snowluma-uninstall-backups'),
      input,
    });
    await this.container.logger.info(
      'snowluma',
      `uninstall ok=${result.ok} actions=${result.actions.length}`,
    );
    if (result.ok && input.removeOurState) this.current = undefined;
    return result;
  }

  /** 应用退出时按"明确的生命周期策略"停止我们启动的进程（不删除任何文件）。 */
  async dispose(): Promise<void> {
    this.controller?.abort();
    await this.processService.stop().catch(() => undefined);
  }
}
