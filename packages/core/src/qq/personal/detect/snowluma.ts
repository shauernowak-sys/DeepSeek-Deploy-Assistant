import { join, normalize } from 'node:path';

import type { ProcessInfo } from './qqnt';

/**
 * SnowLuma 安装与运行探测。
 *
 * 关键坑（见专项报告 §8）：Windows 完整版用**自带的 `node.exe`** 运行，
 * 所以"存在 node.exe 进程"绝对不能作为判据——会误判整台机器上的所有 Node 进程。
 * 正确判据是"该进程的可执行路径/命令行指向**我们这个安装目录**"。
 */

export interface SnowLumaDeps {
  exists(path: string): Promise<boolean>;
  readJson(path: string): Promise<unknown>;
  listProcesses(): Promise<ProcessInfo[]>;
}

export interface SnowLumaDetection {
  installed: boolean;
  installDir?: string;
  version?: string;
  running: boolean;
  pids: number[];
  /** 检测到版本与清单不一致时的说明。 */
  versionProblem?: string;
  evidence: string[];
}

const normalizeForCompare = (value: string): string => normalize(value).replace(/[\\/]+$/, '').toLowerCase();

/**
 * 进程是否属于**这个安装目录**下的 SnowLuma。
 * 命令行里通常包含 `node index.mjs`（cwd 不可得），可执行路径则直接指向 `<installDir>\node.exe`，
 * 因此两者都要看。
 */
export function isSnowLumaProcess(process: ProcessInfo, installDir: string): boolean {
  const target = normalizeForCompare(installDir);
  const exe = process.exePath ? normalizeForCompare(process.exePath) : '';
  const cmd = process.cmdline ? normalizeForCompare(process.cmdline) : '';
  return exe.startsWith(`${target}\\`) || cmd.includes(target);
}

export async function detectSnowLuma(
  deps: SnowLumaDeps,
  options: { installDir: string; expectedVersion: string; releaseFile?: string },
): Promise<SnowLumaDetection> {
  const { installDir, expectedVersion } = options;
  const releaseFile = options.releaseFile ?? 'release.json';
  const evidence: string[] = [];

  let version: string | undefined;
  let versionProblem: string | undefined;
  const releasePath = join(installDir, releaseFile);
  const installed = await deps.exists(releasePath);

  if (installed) {
    try {
      const raw = await deps.readJson(releasePath);
      const parsed = raw as { version?: unknown } | undefined;
      version = typeof parsed?.version === 'string' ? parsed.version : undefined;
      evidence.push(
        version ? `文件检测：${releasePath} 报告版本 ${version}` : `文件检测：${releasePath} 可读但没有 version 字段`,
      );
    } catch (error) {
      evidence.push(`文件检测：${releasePath} 无法解析（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (version && version !== expectedVersion) {
      versionProblem = `检测到 ${version}，清单要求 ${expectedVersion}`;
      evidence.push(`版本比对：${versionProblem}`);
    } else if (version) {
      evidence.push(`版本比对：与清单一致（${expectedVersion}）`);
    }
  } else {
    evidence.push(`文件检测：安装目录没有 ${releaseFile}（未安装或目录不对）`);
  }

  const processes = await deps.listProcesses().catch(() => [] as ProcessInfo[]);
  const pids = processes.filter((item) => isSnowLumaProcess(item, installDir)).map((item) => item.pid);
  evidence.push(
    pids.length > 0
      ? `进程检测：安装目录下的 SnowLuma 正在运行（pid ${pids.join(', ')}）`
      : '进程检测：安装目录下的 SnowLuma 未运行（注意：不能只看 node.exe）',
  );

  return { installed, installDir, version, running: pids.length > 0, pids, versionProblem, evidence };
}
