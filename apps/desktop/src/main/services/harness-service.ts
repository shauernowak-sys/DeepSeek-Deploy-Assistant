import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants as fsConstants } from 'node:fs';

import {
  assertDistributionAllowed,
  assertPluginInstallAllowed,
  collectQrArt,
  describeEvent,
  installCatalogPlugin,
  installWithRegistryFallback,
  parseQqLine,
  probeHarness,
  readQqEntry,
  registryPlan,
  stripAnsi,
  type QqOutputEvent,
} from '@dda/core';
import {
  createDshCli,
  dshBinJs,
  fileExists,
  loadRuntimeSelection,
  type ChildHandle,
  type DshCli,
} from '@dda/adapters';
import {
  BASELINE,
  DdaError,
  ERROR_CODES,
  PERSONAL_QQ_ADAPTER,
  QQ_PLUGIN_DISTRIBUTION,
  type HealthReport,
  type PluginState,
} from '@dda/spec';

import type { Container } from './container';
import { findMarketEntryBySpec } from './market-catalog';

export interface HarnessStatus {
  running: boolean;
  pid?: number;
  url?: string;
  health?: HealthReport;
  plugins?: PluginState[];
}

export class HarnessService {
  private session?: {
    handle: ChildHandle;
    url: string;
    token: string;
    pid?: number;
    health: HealthReport;
    startedAt: string;
  };
  /** 子进程输出环形缓冲：QQ 插件没有状态接口，连接/扫码信号只在 stdout/stderr 里。 */
  private readonly output: string[] = [];
  private readonly qqEvents: { at: string; event: QqOutputEvent }[] = [];
  private partial = '';

  constructor(
    private readonly container: Container,
    /** Injects user credentials into the launch environment (never written to disk). */
    private readonly launchEnv: () => Promise<Record<string, string>> = async () => ({}),
  ) {}

  /**
   * Launching before the deployment step has produced a runtime used to fail inside `spawn` with a
   * raw ENOENT; ordinary users cannot act on that. Fail early with something they can act on.
   */
  private async assertRuntimeInstalled(): Promise<void> {
    const { paths } = this.container;
    const runtime = await loadRuntimeSelection(paths);
    const missing: string[] = [];
    if (!(await fileExists(runtime.node.exe))) missing.push(`Node（${runtime.node.exe}）`);
    const harnessBin = runtime.harness.bin ?? dshBinJs(paths);
    if (!(await fileExists(harnessBin))) missing.push(`Harness 本体（${harnessBin}）`);
    if (missing.length === 0) return;
    throw new DdaError(
      ERROR_CODES.E_HARNESS_NOT_DEPLOYED,
      `Harness 尚未安装，缺少：${missing.join('、')}`,
      '先在第 3 节点"开始部署"完成安装（需要联网），成功后再启动 Harness',
    );
  }

  private async getCli(): Promise<DshCli> {
    const runtime = await loadRuntimeSelection(this.container.paths);
    return createDshCli({
      paths: this.container.paths,
      pnpmBinDir: join(this.container.paths.root, 'bin'),
      registry: this.container.registry,
      nodeExePath: runtime.node.exe,
      binPath: runtime.harness.bin,
    });
  }

  async status(): Promise<HarnessStatus> {
    if (!this.session) return { running: false };
    const health = await probeHarness({ baseUrl: this.session.url.split('?')[0]!, token: this.session.token });
    this.session.health = health;
    return { running: true, pid: this.session.pid, url: this.session.url, health };
  }

  async launch(port = 0): Promise<HarnessStatus> {
    if (this.session) return this.status();
    await this.assertRuntimeInstalled();
    this.resetOutput();

    const { handle, ready } = await (await this.getCli()).launchWeb(
      BASELINE.dsh.profile,
      port,
      undefined,
      await this.launchEnv(),
      (chunk) => this.ingest(chunk),
    );
    let url: string;
    let token: string;
    try {
      const info = await ready;
      url = info.url;
      token = info.token;
    } catch (error) {
      await handle.stop();
      throw error;
    }

    const baseUrl = url.split('?')[0]!;
    let health = await probeHarness({ baseUrl, token });
    // dsh prints the URL slightly before the listener accepts connections; retry briefly.
    for (let i = 0; i < 10 && health.level === 'down'; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      health = await probeHarness({ baseUrl, token });
    }

    this.session = {
      handle,
      url,
      token,
      pid: handle.child.pid ?? undefined,
      health,
      startedAt: new Date().toISOString(),
    };
    await this.container.logger.info(
      'harness',
      `launched pid=${this.session.pid} url=${baseUrl} health=${health.level} (${health.detail})`,
    );
    return { running: true, pid: this.session.pid, url, health };
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    await this.session.handle.stop();
    this.session = undefined;
    await this.container.logger.info('harness', 'stopped');
  }

  /** 应用新配置/新凭据的最可靠方式：重启子进程，让启动环境重新注入。 */
  async restart(port = 0): Promise<HarnessStatus> {
    await this.stop();
    return this.launch(port);
  }

  get running(): boolean {
    return this.session !== undefined;
  }

  get startedAt(): string | undefined {
    return this.session?.startedAt;
  }

  /** 本次启动以来解析出的 QQ 插件事件（时间序，供状态机判定）。 */
  get pluginEvents(): { at: string; event: QqOutputEvent }[] {
    return [...this.qqEvents];
  }

  /** 输出尾部（已去 ANSI），用于在界面上展示"为什么是这个状态"。 */
  outputTail(count = 20): string[] {
    return this.output.slice(-count);
  }

  /** 插件打印的 ASCII 二维码（供界面直接展示，不必只依赖浏览器）。 */
  qrArt(): string[] {
    return collectQrArt(this.output);
  }

  /** Keep only the QQ-relevant surface: bind links are short-lived and never persisted. */
  private resetOutput(): void {
    this.output.length = 0;
    this.qqEvents.length = 0;
    this.partial = '';
  }

  private ingest(chunk: string): void {
    this.partial += chunk;
    const parts = this.partial.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.pushLine(line);
    if (this.partial.length > 4000) {
      // 没有换行的超长输出（例如二维码块）也不能无限增长。
      this.pushLine(this.partial);
      this.partial = '';
    }
  }

  private pushLine(raw: string): void {
    const line = stripAnsi(raw).trimEnd();
    if (!line.trim()) return;
    this.output.push(line);
    if (this.output.length > 300) this.output.shift();
    const event = parseQqLine(line);
    if (event) {
      this.qqEvents.push({ at: new Date().toISOString(), event });
      if (this.qqEvents.length > 100) this.qqEvents.shift();
      // 持久化一条脱敏证据：QQ 连接信号只在子进程输出里，不落日志就无法事后复核。
      void this.container.logger.info('qq', describeEvent(event));
    }
  }

  async probe(): Promise<HealthReport | undefined> {
    if (!this.session) return undefined;
    const health = await probeHarness({ baseUrl: this.session.url.split('?')[0]!, token: this.session.token });
    this.session.health = health;
    return health;
  }

  async listPlugins(): Promise<PluginState[]> {
    return (await this.getCli()).listPlugins(BASELINE.dsh.profile);
  }

  /**
   * P-10 + D03：官方插件的唯一安装入口。9 步编排里第 1 步就是 compat 门禁，
   * 之后才是 precheck/spec/registry/install/复核，第 7–9 步缺证据时明确记 unverified。
   */
  private async installGated(spec: string, allow: { catalog: boolean; adapter: boolean }): Promise<void> {
    assertPluginInstallAllowed({
      matrix: this.container.matrix,
      spec,
      dshVersion: BASELINE.dsh.version,
      catalogSpecs: allow.catalog ? [spec] : [],
      ...(allow.adapter ? { adapterSpecs: [spec] } : {}),
    });
    if (allow.catalog) assertDistributionAllowed(QQ_PLUGIN_DISTRIBUTION, 'online-install');

    const cli = await this.getCli();
    const entry = allow.catalog ? findMarketEntryBySpec(spec) : undefined;
    if (entry !== undefined) {
      const outcome = await installCatalogPlugin(
        { entry, matrix: this.container.matrix, dshVersion: BASELINE.dsh.version },
        {
          precheck: async () => {
            await access(this.container.paths.dshHome, fsConstants.W_OK);
          },
          addPlugin: (layer) => cli.addPlugin(BASELINE.dsh.profile, spec, { registry: layer.url }),
          listPlugins: () => cli.listPlugins(BASELINE.dsh.profile),
          dumpConfig: () => cli.dumpConfig(BASELINE.dsh.profile),
          checkConfig: async () => this.checkPluginConfig(),
          log: (line) => {
            void this.container.logger.info('plugin', line);
          },
        },
      );
      await this.container.logger.info(
        'plugin',
        `installed ${spec} from ${outcome.registry.id}; connectivity=${outcome.connectivity}`,
      );
      return;
    }

    // 适配插件（个人 QQ）不在 catalog 里：仍走同一门禁 + 同一 registry 回退。
    const result = await installWithRegistryFallback({
      spec,
      plan: registryPlan(),
      log: (line) => {
        void this.container.logger.info('plugin', line);
      },
      install: (layer) => cli.addPlugin(BASELINE.dsh.profile, spec, { registry: layer.url }),
    });
    await this.container.logger.info('plugin', `installed ${spec} from ${result.registry.id}`);
  }

  /** 步骤 8：只检查「字段存在且格式合法」，不代表已生效。 */
  private async checkPluginConfig(): Promise<string[]> {
    const patchPath = join(
      this.container.paths.dshHome,
      'profiles',
      BASELINE.dsh.profile,
      'cordis.patch.yml',
    );
    if (!(await fileExists(patchPath))) return ['profile 补丁文件不存在'];
    const entry = readQqEntry(await readFile(patchPath, 'utf8'));
    if (!entry.present) return ['补丁中没有 im-qqbot 条目'];
    const problems: string[] = [];
    const access = entry.config.access as { c2cMode?: unknown; groupMode?: unknown } | undefined;
    if (access === undefined || typeof access !== 'object') problems.push('缺少 access 配置');
    else if (typeof access.c2cMode !== 'string' || typeof access.groupMode !== 'string') {
      problems.push('access.c2cMode / access.groupMode 缺失或类型不对');
    }
    return problems;
  }

  async installQqPlugin(): Promise<void> {
    return this.installGated(`@tencent-connect/dsh-qqbot@${BASELINE.qqbot.version}`, {
      catalog: true,
      adapter: false,
    });
  }

  /** 个人 QQ 适配插件：白名单内唯一允许代装的第三方插件（不属于 compat 的三元组）。 */
  async installAdapterPlugin(): Promise<void> {
    return this.installGated(PERSONAL_QQ_ADAPTER.spec, { catalog: false, adapter: true });
  }

  async removePlugin(name: string): Promise<void> {
    return (await this.getCli()).removePlugin(BASELINE.dsh.profile, name);
  }

  /**
   * Harness Web 的会话凭据。个人 QQ 探测需要带会话 cookie 访问插件路由
   * （`/dsh-qq-bridge/state` 在无 cookie 时返回 authentication_required）。
   */
  auth(): { baseUrl: string; token: string } | undefined {
    if (!this.session) return undefined;
    return { baseUrl: this.session.url.split('?')[0]!, token: this.session.token };
  }

  get bindUrl(): string | undefined {
    return this.session?.url;
  }
}
