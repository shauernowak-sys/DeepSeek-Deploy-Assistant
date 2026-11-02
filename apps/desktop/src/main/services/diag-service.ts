import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildDiagnosticSections, previewLines, writeZip, type DiagnosticSection, type NetworkSummary } from '@dda/core';
import { app } from 'electron';
import { BASELINE, type PluginState, type TaskSummary } from '@dda/spec';

import type { Container } from './container';
import type { EnvService } from './env-service';
import type { HarnessService } from './harness-service';

export interface DiagPreview {
  entries: string[];
  totalBytes: number;
  targetDir: string;
  warning: string;
}

/**
 * Diagnostics collection is deliberately two-phase: the user first sees exactly what will be
 * collected (already sanitized), then either cancels or confirms the export.
 */
export class DiagnosticsService {
  /** Snapshot returned by the last preview: an export must ship exactly what the user saw. */
  private previewed?: DiagnosticSection[];

  constructor(
    private readonly container: Container,
    private readonly env: EnvService,
    private readonly harness: HarnessService,
    private readonly getTask: () => Promise<TaskSummary | undefined>,
    /** Injectable for tests: the real probe hits the network and would make the ZIP non-deterministic. */
    private readonly networkProbe?: () => Promise<NetworkSummary>,
  ) {}

  private async sections(): Promise<DiagnosticSection[]> {
    const { paths } = this.container;
    const report = await this.env.scan();
    const node = report.runtimes.find((r) => r.id === 'node');
    const pnpm = report.runtimes.find((r) => r.id === 'pnpm');
    const dsh = report.runtimes.find((r) => r.id === 'dsh');

    let plugins: PluginState[] = [];
    try {
      plugins = await this.harness.listPlugins();
    } catch {
      plugins = [];
    }

    const profileDir = join(paths.dshHome, 'profiles', BASELINE.dsh.profile);
    const logs = await this.logFiles();

    return buildDiagnosticSections({
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      os: { caption: report.os.caption, arch: report.os.arch, admin: report.os.admin },
      runtime: {
        node: node?.version,
        pnpm: pnpm?.version,
        dsh: dsh?.version,
        profile: profileDir,
        profileExists: dsh?.installed ?? false,
      },
      plugins,
      task: await this.getTask(),
      network: await this.network(),
      logFiles: logs,
      homeDir: process.env.USERPROFILE ?? '',
      dataDir: paths.root,
    });
  }

  async preview(): Promise<DiagPreview> {
    const sections = await this.sections();
    this.previewed = sections;
    const totalBytes = sections.reduce((sum, s) => sum + Buffer.byteLength(s.content, 'utf8'), 0);
    return {
      entries: previewLines(sections),
      totalBytes,
      targetDir: join(this.container.paths.root, 'diagnostics'),
      warning: '内容已脱敏：不含 API Key、QQ Token/AppSecret、用户名与用户目录；导出前请再确认一次。',
    };
  }

  private network(): Promise<NetworkSummary> {
    return this.networkProbe ? this.networkProbe() : this.networkSummary();
  }

  async export(): Promise<{ zipPath: string; bytes: number; entries: number }> {
    // Ship the snapshot the user confirmed. Re-collecting here would produce different log tails
    // and network results, so the ZIP could contain content the preview never showed.
    const sections = this.previewed ?? (await this.sections());
    this.previewed = undefined;
    const dir = join(this.container.paths.root, 'diagnostics');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = join(dir, `dda-diagnostics-${stamp}.zip`);
    await mkdir(dir, { recursive: true });
    const { bytes } = await writeZip(
      zipPath,
      sections.map((s) => ({ name: s.name, content: s.content })),
    );
    await this.container.logger.info('diagnostics', `exported ${zipPath} (${bytes} bytes)`);
    return { zipPath, bytes, entries: sections.length };
  }

  private async logFiles(): Promise<string[]> {
    const dir = this.container.paths.logs;
    const names = await readdir(dir).catch(() => [] as string[]);
    const files = await Promise.all(
      names
        .filter((n) => n.endsWith('.log'))
        .map(async (n) => ({ path: join(dir, n), time: (await stat(join(dir, n))).mtimeMs })),
    );
    return files.sort((a, b) => b.time - a.time).map((f) => f.path);
  }

  private async networkSummary() {
    const targets = [
      { name: 'npm-mirror', url: `${this.container.registry}/-/ping` },
      { name: 'npm-official', url: 'https://registry.npmjs.org/-/ping' },
      { name: 'node-mirror', url: 'https://cdn.npmmirror.com/binaries/node/index.json' },
      { name: 'node-official', url: 'https://nodejs.org/dist/index.json' },
    ];
    const items = await Promise.all(
      targets.map(async (t) => {
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          const res = await fetch(t.url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
          return { target: t.name, url: t.url, ok: res.ok, status: res.status, millis: Date.now() - started };
        } catch (error) {
          return {
            target: t.name,
            url: t.url,
            ok: false,
            millis: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return { items, generatedAt: new Date().toISOString() };
  }
}
