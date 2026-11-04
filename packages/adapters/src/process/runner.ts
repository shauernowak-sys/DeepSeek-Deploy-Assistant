import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { access } from 'node:fs/promises';

import { DdaError, ERROR_CODES } from '@dda/spec';

/**
 * No shell, ever. On Windows `.cmd` shims cannot be spawned without a shell, so we agreed to
 * invoke CLI entry points through `node.exe <cli.js>` instead — that keeps the attack surface
 * to "which JS entry point", never "which command string".
 */
export const ALLOWED_EXECUTABLES = ['node.exe', 'reg.exe'] as const;
export type AllowedExecutable = (typeof ALLOWED_EXECUTABLES)[number];

const SHELL_META = /[&|<>^`";$()\r\n]/;
/** `git+https://…&path:/dir` 这类 spec 里的 `&` 是 pnpm 参数分隔符，不是 shell 语义。 */
const GIT_SPEC = /^git\+(?:https?|ssh):\/\//;
const SHELL_META_EXCEPT_AMP = /[|<>^`";$()\r\n]/;

export interface RunOptions {
  exePath: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** true when the process was killed by our timeout rather than exiting on its own. */
  timedOut?: boolean;
}

export function assertExecutableAllowed(exePath: string): AllowedExecutable {
  const base = exePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (!(ALLOWED_EXECUTABLES as readonly string[]).includes(base)) {
    throw new DdaError(ERROR_CODES.E_SPAWN_DENIED, `${base} is not in the command allowlist`, '这是安全拦截');
  }
  return base as AllowedExecutable;
}

/** Arguments are passed as an array (never concatenated); we still reject shell metacharacters. */
export function assertArgsSafe(args: string[]): void {
  for (const arg of args) {
    // git spec 由 pnpm 解析（`&path:/sub` 是它的参数分隔符），但仍要挡掉真正的 shell 元字符。
    const meta = GIT_SPEC.test(arg) ? SHELL_META_EXCEPT_AMP : SHELL_META;
    if (meta.test(arg)) {
      throw new DdaError(ERROR_CODES.E_SPAWN_DENIED, `argument contains shell metacharacters: ${arg}`, '参数校验失败');
    }
  }
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  const child = spawnChecked(options);
  let stdout = '';
  let stderr = '';

  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          child.kill();
        }, options.timeoutMs)
      : undefined;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    options.onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    options.onStderr?.(chunk);
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode ?? -1));
  });
  if (timer) clearTimeout(timer);

  if (code !== 0) {
    throw new DdaError(
      ERROR_CODES.E_PROCESS_FAILED,
      `进程退出码 ${code}: ${stderr.trim().slice(-800) || stdout.trim().slice(-800)}`,
      '展开日志查看详细输出',
    );
  }
  return { code, stdout, stderr };
}

export interface CaptureOptions extends RunOptions {
  /** Exit code 0 is still required unless stderr matches this (e.g. pnpm's ERR_PNPM_IGNORED_BUILDS). */
  tolerateStderr?: RegExp;
}

/** Never throws for a non-zero exit: callers that need to distinguish "not found" from "failed" use this. */
export async function tryRunCommand(options: RunOptions): Promise<RunResult> {
  const child = spawnChecked(options);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    options.onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    options.onStderr?.(chunk);
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode ?? -1));
  });
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

/** Like runCommand but can tolerate known-benign non-zero exits; returns the code for logging. */
export async function runCommandCapture(options: CaptureOptions): Promise<RunResult> {
  const child = spawnChecked(options);
  let stdout = '';
  let stderr = '';
  const timer =
    options.timeoutMs !== undefined ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    options.onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    options.onStderr?.(chunk);
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode ?? -1));
  });
  if (timer) clearTimeout(timer);

  const tolerated = code === 0 || Boolean(options.tolerateStderr && options.tolerateStderr.test(stderr + stdout));
  if (!tolerated) {
    throw new DdaError(
      ERROR_CODES.E_PROCESS_FAILED,
      `进程退出码 ${code}: ${stderr.trim().slice(-800) || stdout.trim().slice(-800)}`,
      '展开日志查看详细输出',
    );
  }
  return { code, stdout, stderr };
}

export interface ChildHandle {
  child: ChildProcessWithoutNullStreams;
  /** Settles when the process started; rejects with the spawn failure (ENOENT/EACCES) instead of throwing. */
  spawned: Promise<void>;
  stop: () => Promise<void>;
}

export function spawnCommand(options: RunOptions): ChildHandle {
  const child = spawnChecked(options);
  // A spawn failure emits 'error' on the ChildProcess; without a listener Node rethrows it as an
  // uncaught exception in the main process (Electron then shows a raw JS error dialog).
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', (error: Error) => reject(error));
  });
  spawned.catch(() => undefined);
  return {
    child,
    spawned,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve();
        }, 3_000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function spawnChecked(options: RunOptions): ChildProcessWithoutNullStreams {
  assertExecutableAllowed(options.exePath);
  assertArgsSafe(options.args);
  const spawnOptions: SpawnOptionsWithoutStdio = {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
  };
  return spawn(options.exePath, options.args, spawnOptions) as ChildProcessWithoutNullStreams;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
