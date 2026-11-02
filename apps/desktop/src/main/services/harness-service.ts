import { join } from 'node:path';

import { probeHarness } from '@dda/core';
import { createDshCli, dshBinJs, fileExists, nodeExe, type ChildHandle, type DshCli } from '@dda/adapters';
import { BASELINE, DdaError, ERROR_CODES, type HealthReport, type PluginState } from '@dda/spec';

import type { Container } from './container';

export interface HarnessStatus {
  running: boolean;
  pid?: number;
  url?: string;
  health?: HealthReport;
  plugins?: PluginState[];
}

export class HarnessService {
  private session?: { handle: ChildHandle; url: string; token: string; pid?: number; health: HealthReport };
  private cli?: DshCli;

  constructor(
    private readonly container: Container,
    /** Injects the user's API credential into the launch environment (never written to disk). */
    private readonly apiEnv: () => Promise<Record<string, string>> = async () => ({}),
  ) {}

  /**
   * Launching before the deployment step has produced a runtime used to fail inside `spawn` with a
   * raw ENOENT; ordinary users cannot act on that. Fail early with something they can act on.
   */
  private async assertRuntimeInstalled(): Promise<void> {
    const { paths } = this.container;
    const missing: string[] = [];
    if (!(await fileExists(nodeExe(paths)))) missing.push(`Node（${nodeExe(paths)}）`);
    if (!(await fileExists(dshBinJs(paths)))) missing.push(`Harness 本体（${dshBinJs(paths)}）`);
    if (missing.length === 0) return;
    throw new DdaError(
      ERROR_CODES.E_HARNESS_NOT_DEPLOYED,
      `Harness 尚未安装，缺少：${missing.join('、')}`,
      '先在第 3 节点"开始部署"完成安装（需要联网），成功后再启动 Harness',
    );
  }

  private getCli(): DshCli {
    if (!this.cli) {
      this.cli = createDshCli({
        paths: this.container.paths,
        pnpmBinDir: join(this.container.paths.root, 'bin'),
        registry: this.container.registry,
      });
    }
    return this.cli;
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

    const { handle, ready } = await this.getCli().launchWeb(BASELINE.dsh.profile, port, undefined, await this.apiEnv());
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

    this.session = { handle, url, token, pid: handle.child.pid ?? undefined, health };
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

  async probe(): Promise<HealthReport | undefined> {
    if (!this.session) return undefined;
    const health = await probeHarness({ baseUrl: this.session.url.split('?')[0]!, token: this.session.token });
    this.session.health = health;
    return health;
  }

  listPlugins(): Promise<PluginState[]> {
    return this.getCli().listPlugins(BASELINE.dsh.profile);
  }

  installQqPlugin(): Promise<void> {
    return this.getCli().addPlugin(BASELINE.dsh.profile, `@tencent-connect/dsh-qqbot@${BASELINE.qqbot.version}`);
  }

  get bindUrl(): string | undefined {
    return this.session?.url;
  }
}
