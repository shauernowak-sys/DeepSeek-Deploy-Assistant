import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename } from 'node:path';

import { DdaError, ERROR_CODES, type SnowLumaProcessStatus } from '@dda/spec';

/**
 * SnowLuma 进程管理（M3.3-05）。
 *
 * 关键点（来自专项调查的"坑"）：
 *  - 完整版带自带 `node.exe`，所以要按**可执行文件路径 + cwd**判断归属，不能只找 node.exe；
 *  - `launcher.bat` 会 `pause`，在无人值守下会挂住，因此直接 `node.exe index.mjs` 启动；
 *  - 只有从**本进程**启动的子进程才能拿到 pid/退出码，这正是"防止重复启动"和"异常退出监测"的依据。
 */

interface SpawnedChild {
  pid?: number;
  stdout: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void };
  stderr: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void };
  once(event: 'spawn', cb: () => void): void;
  once(event: 'error', cb: (error: Error) => void): void;
  once(event: 'close', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
  exitCode: number | null;
}

interface SpawnDeps {
  spawn(exePath: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): SpawnedChild;
  now(): Date;
}

export function createNodeSpawnDeps(): SpawnDeps {
  return {
    spawn: (exePath, args, options) =>
      spawn(exePath, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
      }) as ChildProcessWithoutNullStreams as unknown as SpawnedChild,
    now: () => new Date(),
  };
}

interface StartOptions {
  installDir: string;
  nodeExePath: string;
  entry?: string;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** 官方 WebUI 初始凭据只打印一次：`initial credentials: user=admin <password>`。 */
export function parseInitialCredentials(line: string): { user: string; password: string } | undefined {
  const match = /initial credentials:\s*user=(\S+)\s+(\S+)/i.exec(line.replace(ANSI, ''));
  if (!match) return undefined;
  return { user: match[1]!, password: match[2]! };
}

export class SnowLumaProcessService {
  private child?: SpawnedChild;
  private startedAt?: Date;
  private exited?: { code: number | null; signal: string | null; at: string };
  private readonly output: string[] = [];
  private partial = '';
  /** 只在内存里保留，绝不写日志/落盘。 */
  private credentials?: { user: string; password: string };

  constructor(private readonly deps: SpawnDeps) {}

  get status(): SnowLumaProcessStatus {
    const running = Boolean(this.child) && this.child?.exitCode === null;
    return {
      running,
      pid: running ? this.child?.pid : undefined,
      startedAt: this.startedAt?.toISOString(),
      exited: this.exited,
    };
  }

  get outputTail(): string[] {
    return [...this.output];
  }

  /** 只给主进程用：返回后由调用方一次性展示给用户，不落日志。 */
  get webuiBootstrapCredentials(): { user: string; password: string } | undefined {
    return this.credentials;
  }

  async start(options: StartOptions): Promise<{ pid: number; alreadyRunning: boolean }> {
    if (this.status.running) {
      return { pid: this.child!.pid ?? 0, alreadyRunning: true };
    }
    if (basename(options.nodeExePath).toLowerCase() !== 'node.exe') {
      throw new DdaError(ERROR_CODES.E_SPAWN_DENIED, 'SnowLuma 只能由自带的 node.exe 启动', '这是安全拦截');
    }
    const entry = options.entry ?? 'index.mjs';
    if (!/^[A-Za-z0-9._-]+\.mjs$/.test(entry)) {
      throw new DdaError(ERROR_CODES.E_SPAWN_DENIED, `非法的入口文件：${entry}`, '这是安全拦截');
    }

    this.exited = undefined;
    this.output.length = 0;
    this.partial = '';

    const env: NodeJS.ProcessEnv = { ...process.env };
    // 不代用户接受 EULA/PRIVACY：这两个变量必须由用户本人在 WebUI 里点。
    delete env.SNOWLUMA_ACCEPT_EULA;
    delete env.SNOWLUMA_ACCEPT_PRIVACY;
    for (const [key, value] of Object.entries(options.env ?? {})) env[key] = value;

    const child = this.deps.spawn(options.nodeExePath, [entry], { cwd: options.installDir, env });
    this.child = child;
    this.startedAt = this.deps.now();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.ingest(chunk, options.onLine));
    child.stderr.on('data', (chunk: string) => this.ingest(chunk, options.onLine));

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(error));
    });
    child.once('close', (code, signal) => {
      this.exited = { code, signal, at: this.deps.now().toISOString() };
      if (this.child === child) this.child = undefined;
    });

    return { pid: child.pid ?? 0, alreadyRunning: false };
  }

  private ingest(chunk: string, onLine?: (line: string) => void): void {
    this.partial += chunk;
    const parts = this.partial.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const raw of parts) this.pushLine(raw, onLine);
    if (this.partial.length > 4000) {
      this.pushLine(this.partial, onLine);
      this.partial = '';
    }
  }

  private pushLine(raw: string, onLine?: (line: string) => void): void {
    const line = raw.replace(ANSI, '').trimEnd();
    if (!line.trim()) return;
    this.output.push(line);
    if (this.output.length > 300) this.output.shift();
    const creds = parseInitialCredentials(line);
    if (creds) this.credentials = creds;
    onLine?.(line);
  }

  async stop(timeoutMs = 8000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, timeoutMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = undefined;
  }
}
