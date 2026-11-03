import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { RollbackTarget } from '@dda/spec';

/** Windows paths are case-insensitive; POSIX ones are not. */
function comparable(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * True when `child` is `parent` itself or lives below it.
 * Comparison is separator-aware, so `...\DeepSeekDeployAssistant-evil` is NOT inside
 * `...\DeepSeekDeployAssistant`.
 */
export function isPathInside(child: string, parent: string): boolean {
  const c = comparable(resolve(child));
  const p = comparable(resolve(parent));
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Deepest existing ancestor, so a not-yet-created path still gets its real location checked. */
async function nearestExisting(path: string): Promise<string | undefined> {
  let current = resolve(path);
  for (let guard = 0; guard < 128; guard += 1) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  return undefined;
}

export interface ClassifyRollbackOptions {
  /** Folders this application manages; nothing outside of them may be deleted. */
  roots: string[];
}

/**
 * Decides which journal paths may really be deleted. A path must:
 *  1. be absolute and sit inside one of the managed roots (separator-aware, no prefix tricks),
 *  2. resolve — following symlinks — to a location that is still inside that root,
 *  3. not be the managed root itself and not be a symlink/junction we cannot vouch for.
 *
 * Refusing is the safe default: a path we cannot attribute is never worth a recursive delete.
 */
export async function classifyRollbackTargets(
  paths: string[],
  options: ClassifyRollbackOptions,
): Promise<RollbackTarget[]> {
  const roots = options.roots.map((r) => resolve(r));
  const realRoots = await Promise.all(roots.map(canonical));
  const result: RollbackTarget[] = [];

  for (const raw of paths) {
    // `exists` is reported for every entry, including refused ones: the dialog lists real state.
    let exists = false;
    let isLink = false;
    try {
      const info = await lstat(raw);
      exists = true;
      isLink = info.isSymbolicLink();
    } catch {
      exists = false;
    }

    if (!isAbsolute(raw)) {
      result.push({ path: raw, exists, deletable: false, reason: '不是绝对路径，无法确认归属' });
      continue;
    }

    const target = resolve(raw);
    const rootIndex = roots.findIndex((root) => isPathInside(target, root));
    if (rootIndex === -1) {
      result.push({ path: target, exists, deletable: false, reason: '不在本软件管理目录内' });
      continue;
    }
    if (comparable(target) === comparable(roots[rootIndex]!)) {
      result.push({ path: target, exists, deletable: false, reason: '不允许删除受管根目录本身' });
      continue;
    }
    if (isLink) {
      result.push({ path: target, exists, deletable: false, reason: '疑似软链接/联接点，拒绝递归删除' });
      continue;
    }

    // Even a path that does not exist yet must not sit behind a symlinked parent.
    const anchor = exists ? target : await nearestExisting(target);
    const realAnchor = anchor ? await canonical(anchor) : undefined;
    if (!realAnchor || !realRoots.some((root) => isPathInside(realAnchor, root))) {
      result.push({ path: target, exists, deletable: false, reason: '实际路径指向受管目录之外（疑似路径穿越）' });
      continue;
    }

    result.push({ path: target, exists, deletable: true });
  }

  return result;
}
