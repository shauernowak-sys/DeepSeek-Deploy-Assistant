import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from '@dda/core';
import type { RuntimeSelection } from '@dda/spec';

import { fileExists } from '../process/runner';
import { dshBinJs, nodeExe, type AppPaths } from '../paths';

export interface StoredRuntimeSelection extends RuntimeSelection {
  savedAt: string;
  planId?: string;
  qqMode?: 'official' | 'personal';
}

export function runtimeSelectionPath(paths: AppPaths): string {
  return join(paths.root, 'state', 'runtime-selection.json');
}

/** 部署开始前写入；启动 Harness 时按它选择 node.exe / dsh bin.js。 */
export async function saveRuntimeSelection(
  paths: AppPaths,
  selection: RuntimeSelection,
  planId?: string,
  qqMode?: 'official' | 'personal',
): Promise<string> {
  const file = runtimeSelectionPath(paths);
  const payload: StoredRuntimeSelection = { ...selection, savedAt: new Date().toISOString(), planId, qqMode };
  await writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

function isRuntimeSelection(value: unknown): value is StoredRuntimeSelection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const node = v.node as Record<string, unknown> | undefined;
  const harness = v.harness as Record<string, unknown> | undefined;
  return (
    (node?.mode === 'system' || node?.mode === 'managed') &&
    typeof node.exe === 'string' &&
    (harness?.mode === 'system' || harness?.mode === 'managed')
  );
}

/**
 * 读取上一次部署确认的运行时。文件损坏/目标已不存在时回退到私有运行时，
 * 而不是让 Harness 启动失败或悄悄使用错误版本。
 */
export async function loadRuntimeSelection(paths: AppPaths): Promise<RuntimeSelection> {
  const fallback: RuntimeSelection = {
    node: { mode: 'managed', exe: nodeExe(paths), dir: dirname(nodeExe(paths)) },
    harness: { mode: 'managed', bin: dshBinJs(paths) },
  };
  const raw = await readFile(runtimeSelectionPath(paths), 'utf8').catch(() => undefined);
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRuntimeSelection(parsed)) return fallback;
  const node = parsed.node;
  if (!(await fileExists(node.exe))) return fallback;
  if (parsed.harness.mode === 'system' && (!parsed.harness.bin || !(await fileExists(parsed.harness.bin)))) {
    return fallback;
  }
  return {
    node: { mode: node.mode, exe: node.exe, dir: node.dir, version: node.version },
    harness: { mode: parsed.harness.mode, bin: parsed.harness.bin, version: parsed.harness.version },
  };
}

/** Legacy tasks without a mode used the official QQ deployment plan. */
export async function loadDeploymentQqMode(paths: AppPaths): Promise<'official' | 'personal'> {
  const raw = await readFile(runtimeSelectionPath(paths), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('部署路线记录无效，请重新确认部署方案');
  const mode = (parsed as StoredRuntimeSelection).qqMode;
  if (mode === undefined || mode === 'official') return 'official';
  if (mode === 'personal') return mode;
  throw new Error('部署路线记录无效，请重新确认部署方案');
}
