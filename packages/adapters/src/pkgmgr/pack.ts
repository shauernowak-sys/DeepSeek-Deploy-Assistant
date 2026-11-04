import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { DdaError, ERROR_CODES } from '@dda/spec';

import { runCommand, type RunOptions, type RunResult } from '../process/runner';

/**
 * D04：把插件目录打成 `.tgz`，交给 pnpm 的 `file:` 绝对路径。
 *
 * 用 pnpm 自己的 `pack` 而不是手写 tar，原因：
 * - 它会尊重 `package.json` 的 `files` 白名单（手写打包最容易漏文件）；
 * - 产物的目录结构（`package/…`）与 registry tarball 一致；
 * - `--config.ignore-scripts=true` 确保打包过程不执行 `prepack`/`prepare`。
 */
export interface PackDirectoryOptions {
  directory: string;
  /** 产物目录（绝对路径）。 */
  outDir: string;
  /** 执行 pnpm 的 Node（私有运行时或系统 Node）。 */
  nodeExePath: string;
  /** `pnpm.cjs` 的绝对路径。 */
  pnpmCliPath: string;
  timeoutMs?: number;
  /** 测试注入。 */
  run?: (options: RunOptions) => Promise<RunResult>;
}

export async function packDirectoryToTgz(options: PackDirectoryOptions): Promise<string> {
  const run = options.run ?? runCommand;
  const result = await run({
    exePath: options.nodeExePath,
    args: [
      options.pnpmCliPath,
      'pack',
      '--pack-destination',
      resolve(options.outDir),
      '--config.ignore-scripts=true',
    ],
    cwd: options.directory,
    timeoutMs: options.timeoutMs ?? 5 * 60_000,
  });

  if (result.code !== 0) {
    throw new DdaError(
      ERROR_CODES.E_PROCESS_FAILED,
      `打包失败（pnpm pack 退出码 ${result.code}）：${(result.stderr || result.stdout).trim().slice(-400)}`,
      '检查 package.json 是否合法、目录是否可读后重试',
    );
  }

  const reported = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().endsWith('.tgz'))
    .pop();
  if (reported === undefined) {
    throw new DdaError(
      ERROR_CODES.E_PROCESS_FAILED,
      `打包命令没有报告产物路径：${result.stdout.trim().slice(-200)}`,
      '导出诊断包反馈',
    );
  }

  const tgzPath = resolve(options.directory, reported);
  if (!existsSync(tgzPath)) {
    throw new DdaError(ERROR_CODES.E_PROCESS_FAILED, `打包产物不存在：${tgzPath}`, '重试导入');
  }
  return tgzPath;
}
