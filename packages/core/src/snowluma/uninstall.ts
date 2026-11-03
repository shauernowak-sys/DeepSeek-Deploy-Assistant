import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { SnowLumaUninstallInput } from '@dda/spec';

import { REQUIRED_PACKAGE_FILES, type InstallFsDeps, type ReleaseJsonShape } from './install';
import { copyDirRecursive, type ConfigDeps } from './config';

/**
 * 卸载（M3.3-10）。
 *
 * 分五类，逐类由用户勾选，默认只删"我们自己的状态"：
 *  1. 我们自己的程序文件 —— 由安装包卸载器负责，本模块不碰；
 *  2. SnowLuma 程序文件 —— 只删 `release.json` 里列出的包内条目；
 *  3. SnowLuma 的 `config/` —— 删前先备份到我们的 state 目录（可恢复）；
 *  4. SnowLuma 的 `data/`（QQ 登录态、消息库）—— 只有用户明确勾选才删，不备份；
 *  5. 用户自行创建的数据 —— **永不删除**。
 */

export interface UninstallDeps
  extends Pick<ConfigDeps, 'exists' | 'readFile' | 'remove' | 'mkdir' | 'copyDir' | 'now'> {}

interface UninstallOptions {
  installDir: string;
  /** 我们自己的状态目录（安装记录、暂存、配置备份）。 */
  ourStateDir: string;
  /** 备份 config/ 的目标根目录。 */
  backupRoot: string;
  input: SnowLumaUninstallInput;
}

export interface UninstallResult {
  ok: boolean;
  actions: string[];
  refusedReason?: string;
}

export async function uninstallSnowLuma(deps: UninstallDeps, options: UninstallOptions): Promise<UninstallResult> {
  const actions: string[] = [];
  if (!options.input.confirm) {
    return { ok: false, actions, refusedReason: '需要用户明确确认后才执行卸载' };
  }

  if (options.input.removeOurState) {
    await deps.remove(options.ourStateDir);
    actions.push(`已删除本软件的 SnowLuma 状态目录：${options.ourStateDir}`);
  }

  if (options.input.removeComponent) {
    const releasePath = join(options.installDir, 'release.json');
    let entries: string[] = [];
    if (await deps.exists(releasePath)) {
      try {
        const raw = JSON.parse(await deps.readFile(releasePath)) as ReleaseJsonShape;
        entries = Array.isArray(raw.entries) ? raw.entries.filter((item): item is string => typeof item === 'string') : [];
      } catch {
        entries = [];
      }
    }
    if (entries.length === 0) {
      entries = [...REQUIRED_PACKAGE_FILES].filter((item) => !item.includes('/'));
      actions.push('release.json 不可读，改为按已知包内文件清单删除');
    }
    for (const entry of entries) {
      if (entry === 'config' || entry === 'data' || entry === 'logs') continue;
      if (entry.includes('/') || entry.includes('\\') || entry.includes('..')) continue;
      await deps.remove(join(options.installDir, entry));
      actions.push(`已删除 SnowLuma 程序文件：${entry}`);
    }
  }

  if (options.input.removeConfig) {
    const configDir = join(options.installDir, 'config');
    if (await deps.exists(configDir)) {
      const backupDir = join(options.backupRoot, `uninstall-${deps.now().toISOString().replace(/[:.]/g, '-')}`);
      await deps.mkdir(backupDir);
      await copyDirRecursive(configDir, join(backupDir, 'config'));
      await deps.remove(configDir);
      actions.push(`已删除 config/，删除前已备份到 ${backupDir}`);
    }
  }

  if (options.input.removeUserData) {
    const dataDir = join(options.installDir, 'data');
    const logsDir = join(options.installDir, 'logs');
    if (await deps.exists(dataDir)) {
      await deps.remove(dataDir);
      actions.push('已删除 data/（QQ 登录态与消息库，无法恢复）');
    }
    if (await deps.exists(logsDir)) {
      await deps.remove(logsDir);
      actions.push('已删除 logs/');
    }
  }

  // 兜底：如果程序文件已清空，移除空目录本身（只 rm 空目录，`force` 不会递归删用户文件）。
  try {
    await rm(options.installDir, { recursive: false, force: true });
  } catch {
    // 目录非空（有用户数据）时保留。
  }

  return { ok: true, actions };
}
