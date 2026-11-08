import { dirname, join } from 'node:path';

import { BASELINE, DdaError, ERROR_CODES, type PluginState, type RuntimeInfo } from '@dda/spec';

import { runCommand, spawnCommand, fileExists, type ChildHandle, type RunResult } from '../process/runner';
import type { AppPaths } from '../paths';
import { dshBinJs, nodeExe } from '../paths';

export interface DshEnvOptions {
  paths: AppPaths;
  pnpmBinDir: string;
  registry: string;
  /** 复用系统 Node 时传入；默认使用私有运行时。 */
  nodeExePath?: string;
  /** 复用系统 Harness 时传入其可执行 JS 入口；默认使用私有 Harness。 */
  binPath?: string;
  /**
   * P-11：探测到不可达的代理变量名。只在本子进程的 env 里剔除，
   * 不修改 `process.env`，也不改用户系统设置。
   */
  proxyExclusions?: readonly string[];
}

export function dshEnv(options: DshEnvOptions, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { paths, pnpmBinDir, registry } = options;
  const node = options.nodeExePath ?? nodeExe(paths);
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: paths.dshHome,
    npm_config_registry: registry,
    npm_config_store_dir: join(paths.root, 'cache', 'pnpm-store'),
    // Only this child sees our private Node/pnpm; the user's PATH and env vars stay untouched.
    PATH: `${dirname(node)};${pnpmBinDir};${process.env.PATH ?? ''}`,
    ...extra,
  };
  // 剔除失效代理只发生在传出去的副本上（NO_PROXY 不动）。
  for (const name of options.proxyExclusions ?? []) delete base[name];
  return base;
}

export interface DshCli {
  version(): Promise<RuntimeInfo>;
  ensureProfile(profile: string): Promise<void>;
  listPlugins(profile: string): Promise<PluginState[]>;
  /** 组合树转储：用于「已加载」复核（步骤 7）。 */
  dumpConfig(profile: string): Promise<string>;
  addPlugin(profile: string, spec: string, options?: { registry?: string; storeDir?: string }): Promise<RunResult>;
  removePlugin(profile: string, name: string, options?: { storeDir?: string }): Promise<void>;
  launchWeb(
    profile: string,
    port: number,
    timeoutMs?: number,
    extraEnv?: Record<string, string>,
    /** 原始输出回调：QQ 插件的连接/扫码信号只出现在子进程输出里（官方未提供状态接口）。 */
    onOutput?: (chunk: string) => void,
  ): Promise<{ handle: ChildHandle; ready: Promise<{ url: string; token: string }> }>;
}

export function createDshCli(options: DshEnvOptions): DshCli {
  const { paths } = options;
  const exe = options.nodeExePath ?? nodeExe(paths);
  const bin = options.binPath ?? dshBinJs(paths);

  const run = (args: string[], timeoutMs = 5 * 60_000) =>
    runCommand({ exePath: exe, args: [bin, ...args], env: dshEnv(options), timeoutMs });

  return {
    async version() {
      if (!(await fileExists(bin))) return { id: 'dsh', installed: false };
      const { stdout } = await run(['--version'], 60_000);
      return { id: 'dsh', installed: true, version: stdout.trim(), path: bin };
    },

    async ensureProfile(profile) {
      if (profile === 'desktop') {
        throw new DdaError(ERROR_CODES.E_PROFILE_OWNED_BY_DESKTOP, 'desktop profile 由官方桌面端独占', '本工具不会修改它');
      }
      // `plugin list` materialises the profile directory from the shipped template (M0 observed).
      await run(['plugin', '--profile', profile, 'list'], 180_000);
    },

    async listPlugins(profile) {
      const { stdout } = await run(['plugin', '--profile', profile, 'list'], 180_000);
      return parsePluginList(stdout);
    },

    async dumpConfig(profile) {
      const { stdout } = await run(['--profile', profile, '--dump-config'], 120_000);
      return stdout;
    },

    async addPlugin(profile, spec, options) {
      if (profile === 'desktop') {
        throw new DdaError(ERROR_CODES.E_PROFILE_OWNED_BY_DESKTOP, 'desktop profile 由官方桌面端独占', '本工具不会修改它');
      }
      // `--registry=` 会被 dsh 用于预检查询，并原样转发给 pnpm（实测 0.2.0-rc.2）。
      const registryArgs = options?.registry === undefined ? [] : [`--registry=${options.registry}`];
      // profile 的 node_modules 是从某个具体 store 链接来的；换了 store 再装/删会被
      // pnpm 以 ERR_PNPM_UNEXPECTED_STORE 拒绝，所以沿用 profile 记录的那个（见 .modules.yaml）。
      const storeArgs = options?.storeDir === undefined ? [] : [`--store-dir=${options.storeDir}`];
      return run(['plugin', '--profile', profile, 'add', spec, ...registryArgs, ...storeArgs], 30 * 60_000);
    },

    async removePlugin(profile, name, options) {
      if (profile === 'desktop') {
        throw new DdaError(ERROR_CODES.E_PROFILE_OWNED_BY_DESKTOP, 'desktop profile 由官方桌面端独占', '本工具不会修改它');
      }
      const storeArgs = options?.storeDir === undefined ? [] : [`--store-dir=${options.storeDir}`];
      await run(['plugin', '--profile', profile, 'remove', name, ...storeArgs], 10 * 60_000);
    },

    async launchWeb(profile, port, timeoutMs = WEB_START_TIMEOUT_MS, extraEnv, onOutput) {
      const args = [bin, '--profile', profile, '--no-open', '--port', String(port)];
      // extraEnv carries the user's API credential into the harness credential seam; it is never persisted.
      const handle = spawnCommand({ exePath: exe, args, env: dshEnv(options, extraEnv) });
      const ready = new Promise<{ url: string; token: string }>((resolve, reject) => {
        let buffer = '';
        let settled = false;
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(message));
        };
        const succeed = (value: { url: string; token: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          // A silent timeout is undiagnosable: keep the tail of what the child actually said.
          const tail = buffer.trim().slice(-400) || '（无输出）';
          fail(`等待 dsh web 启动超时（${Math.round(timeoutMs / 1000)}s）：${tail}`);
        }, timeoutMs);
        // Missing runtime (node.exe not deployed) surfaces here as ENOENT instead of an uncaught throw.
        handle.child.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            fail(`找不到 Harness 运行时：${exe}。请先完成"一键部署"，再启动 Harness。`);
            return;
          }
          fail(`无法启动 Harness 运行时（${error.code ?? 'UNKNOWN'}）：${error.message}`);
        });
        handle.child.stdout.setEncoding('utf8');
        handle.child.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          onOutput?.(chunk);
          const match = /(http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_-]+)/.exec(buffer);
          if (match) {
            const raw = match[1]!;
            const token = /token=([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? '';
            succeed({ url: raw, token });
          }
        });
        handle.child.stderr.setEncoding('utf8');
        handle.child.stderr.on('data', (chunk: string) => {
          buffer += chunk;
          onOutput?.(chunk);
        });
        handle.child.once('close', (code) => {
          fail(`dsh web 提前退出（code=${code}）：${buffer.trim().slice(-400) || '（无输出）'}`);
        });
      });
      return { handle, ready };
    },
  };
}

/** pnpm SGR colors (`FORCE_COLOR`, a TTY). They wrap glyphs; they are not part of the tree. */
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/**
 * `dsh plugin list` prints a pnpm dependency tree. We only need top-level dependencies.
 * Unparsable output yields an empty list rather than a fake "installed" state.
 */
export function parsePluginList(stdout: string): PluginState[] {
  const plugins: PluginState[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    // Only depth-0 entries: pnpm prefixes top-level deps with `└── `/`├── ` at column 0,
    // nested dependencies keep leading indentation. Stripping indentation would over-report.
    // Color codes sit around those glyphs (`\u001b[2m└── \u001b[22mname\u001b[90m@version`),
    // so remove SGR first and leave the spaces in place.
    const line = rawLine.replace(ANSI_SGR, '');
    const treeMatch = /^(?:└── |├── )(.+)$/.exec(line);
    if (!treeMatch) continue;
    const dep = /^(@?[A-Za-z0-9][\w./@-]*)@([0-9][\w.+-]*)$/.exec(treeMatch[1]!.trim());
    if (!dep) continue;
    plugins.push({ name: dep[1]!, version: dep[2]!, installed: true, listedAt: new Date().toISOString() });
  }
  return plugins;
}

export const QQ_PLUGIN_SPEC = `${'@tencent-connect/dsh-qqbot'}@${BASELINE.qqbot.version}`;

/**
 * `dsh web` on a freshly deployed root has been observed to stay silent for well over 30 s on a
 * first start (first-run initialisation + Defender scanning of a freshly written tree). Failing
 * the launch at 30 s produced a false negative for the user, so the ceiling is generous and the
 * captured output is included in the error.
 */
export const WEB_START_TIMEOUT_MS = 120_000;
