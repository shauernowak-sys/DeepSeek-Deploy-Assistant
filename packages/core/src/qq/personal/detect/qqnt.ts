import { basename } from 'node:path';

/**
 * 桌面版 QQ（NTQQ）探测。
 *
 * 为什么需要它：SnowLuma 不实现 QQ 协议，它把 hook 注入**正在运行的 `QQ.exe`**（官方文档）。
 * 因此"QQ 是否安装/是否在跑"是个人 QQ 路线的前置条件，必须在任何组件检测之前给出结论。
 */

export interface ProcessInfo {
  pid: number;
  exePath?: string;
  cmdline?: string;
}

export interface QqntDeps {
  exists(path: string): Promise<boolean>;
  listProcesses(): Promise<ProcessInfo[]>;
  env: Record<string, string | undefined>;
}

export interface QqntDetection {
  installed: boolean;
  path?: string;
  running: boolean;
  pids: number[];
  evidence: string[];
}

export const QQ_EXE_NAME = 'QQ.exe';

/** 常见安装位置（不含注册表，注册表探测留给上层补充）。 */
export function qqCandidatePaths(env: Record<string, string | undefined>): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA;
  const candidates = [
    `${programFiles}\\Tencent\\QQNT\\${QQ_EXE_NAME}`,
    `${programFilesX86}\\Tencent\\QQNT\\${QQ_EXE_NAME}`,
  ];
  if (localAppData) candidates.push(`${localAppData}\\Programs\\Tencent\\QQNT\\${QQ_EXE_NAME}`);
  return candidates;
}

/** 进程是否就是 QQ 客户端（只看可执行文件名，避免把腾讯系其它进程算进来）。 */
export function isQqProcess(process: ProcessInfo): boolean {
  if (!process.exePath) return false;
  return basename(process.exePath).toLowerCase() === QQ_EXE_NAME.toLowerCase();
}

export async function detectQqnt(deps: QqntDeps): Promise<QqntDetection> {
  const evidence: string[] = [];

  let installedPath: string | undefined;
  for (const candidate of qqCandidatePaths(deps.env)) {
    if (await deps.exists(candidate)) {
      installedPath = candidate;
      evidence.push(`文件检测：找到 ${candidate}`);
      break;
    }
  }
  if (!installedPath) evidence.push('文件检测：常见目录下没有找到 QQ.exe');

  const processes = await deps.listProcesses().catch(() => [] as ProcessInfo[]);
  const qqProcesses = processes.filter(isQqProcess);
  const pids = qqProcesses.map((item) => item.pid);
  // 用户把 QQ 装到了 D 盘或自定义目录时，三个固定路径会落空，但正在运行的 QQ.exe 路径就是安装位置。
  if (!installedPath) {
    const fromProcess = qqProcesses.find((item) => item.exePath)?.exePath;
    if (fromProcess) {
      installedPath = fromProcess;
      evidence.push(`进程检测：从正在运行的 QQ.exe 得到安装位置 ${fromProcess}`);
    }
  }
  if (!installedPath) evidence.push('文件检测：未安装桌面版 QQ');
  evidence.push(
    pids.length > 0 ? `进程检测：QQ.exe 正在运行（pid ${pids.join(', ')}）` : '进程检测：没有 QQ.exe 在运行',
  );

  return { installed: Boolean(installedPath), path: installedPath, running: pids.length > 0, pids, evidence };
}
