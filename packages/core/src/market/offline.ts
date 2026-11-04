import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { DdaError, ERROR_CODES, DISTRIBUTION_MODE_LABELS } from '@dda/spec';
import type { CatalogEntry, DistributionBlocker, DistributionMode, DistributionPolicy } from '@dda/spec';

import { assertDistributionAllowed } from './distribution';
import { evaluateClosure } from './license-gate';
import { sha256File } from '../transfer/downloader';

/**
 * D05 离线与缓存（通用部分）。
 *
 * QQ 插件**不可离线**（闭包含 UNLICENSED），这一点已由 Gate 4 ② 的降级结论固化。
 * 本模块交付的是"将来许可允许的条目"可用的能力，且必须**复用 D11 门禁**——
 * 任何离线打包请求都要先过 `assertDistributionAllowed(policy, 'offline-bundle')`。
 */

/** 按 catalog 条目推导分发策略：允许再分发才有 `offline-bundle`，否则只有 `online-install`。 */
export function distributionPolicyForEntry(entry: CatalogEntry): DistributionPolicy {
  const report = evaluateClosure(`${entry.name}@${entry.version}`, entry.depsClosure);
  const blocked: DistributionBlocker[] = [...report.denied, ...report.needsReview].map((pkg) => ({
    mode: 'offline-bundle' as DistributionMode,
    package: pkg.name,
    version: pkg.version,
    license: pkg.license,
    reason: '该包的许可不允许我方再分发，打进离线包即构成再分发',
  }));

  const redistributable = entry.license.redistributable && report.verdict === 'allowed';
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    license: entry.license.spdx,
    allowed: redistributable ? ['online-install', 'offline-bundle'] : ['online-install'],
    blocked: redistributable ? [] : blocked,
    notice: redistributable
      ? `${entry.name} 的依赖闭包全部允许再分发，可制作离线包。`
      : `${entry.name} 的依赖闭包含不可再分发组件，只能在线安装。`,
  };
}

export interface OfflineBundleFile {
  /** 包内相对路径（POSIX）。 */
  path: string;
  content: Buffer | string;
}

export interface OfflineBundleManifest {
  schemaVersion: 1;
  entryId: string;
  name: string;
  version: string;
  /** catalog 记录的 integrity（sha512），用于与 registry 对账。 */
  integrity: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  /** 整包指纹：按 path 排序后把 `path:sha256` 串起来再取 sha256。 */
  bundleSha256: string;
}

/** 离线打包入口：门禁先行，任何不可分发的条目都在写文件之前被拒。 */
export async function buildOfflineBundle(input: {
  entry: CatalogEntry;
  files: readonly OfflineBundleFile[];
  outDir: string;
}): Promise<OfflineBundleManifest> {
  const policy = distributionPolicyForEntry(input.entry);
  assertDistributionAllowed(policy, 'offline-bundle');

  if (input.files.length === 0) {
    throw new DdaError(ERROR_CODES.E_MANIFEST_INVALID, '离线包内容为空', '至少包含插件 tarball 与其声明文件');
  }

  const targetDir = join(resolve(input.outDir), input.entry.id);
  await mkdir(targetDir, { recursive: true });

  const files: OfflineBundleManifest['files'] = [];
  for (const file of input.files) {
    const relative = file.path.replace(/\\/gu, '/').replace(/^\/+/u, '');
    if (relative === '' || relative.includes('..')) {
      throw new DdaError(ERROR_CODES.E_EXTRACT_UNSAFE_PATH, `非法包内路径：${file.path}`, '使用相对 POSIX 路径');
    }
    const target = join(targetDir, relative);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}`;
    await writeFile(temp, file.content);
    await rename(temp, target);
    files.push({ path: relative, sha256: await sha256File(target), bytes: (await readFile(target)).length });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const bundleSha256 = await hashOf(files.map((file) => `${file.path}:${file.sha256}`).join('\n'));

  const manifest: OfflineBundleManifest = {
    schemaVersion: 1,
    entryId: input.entry.id,
    name: input.entry.name,
    version: input.entry.version,
    integrity: input.entry.integrity,
    files,
    bundleSha256,
  };
  await writeFile(join(targetDir, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function hashOf(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 离线安装前的证书检查：缓存文件必须**重新校验哈希**才可用。
 * 不一致 → 删除缓存并给出可执行提示（不是"请重试"这种空话）。
 */
export async function assertCachedTarball(cachedPath: string, expectedSha256: string): Promise<void> {
  let actual: string;
  try {
    actual = await sha256File(cachedPath);
  } catch {
    throw new DdaError(
      ERROR_CODES.E_DOWNLOAD_NETWORK,
      `离线缓存不存在：${cachedPath}`,
      '先联网安装一次以填充缓存，或改用在线安装',
    );
  }
  if (actual === expectedSha256.toLowerCase()) return;

  await rm(cachedPath, { force: true });
  throw new DdaError(
    ERROR_CODES.E_HASH_MISMATCH,
    `离线缓存已损坏（期望 ${expectedSha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已删除`,
    '重新联网安装以刷新缓存，或检查磁盘是否被篡改',
  );
}

/** 离线安装时的 spec：绝对路径的 `.tgz`（pnpm 接受本地 tarball）。 */
export function offlineInstallSpec(cachedPath: string): string {
  return resolve(cachedPath);
}

/** 断网/不可用时的提示（D05 的 (d) 项）：必须给可执行动作，不说"请重试"。 */
export function offlineFallbackHint(mode: DistributionMode): string {
  if (mode === 'offline-bundle') {
    return '当前条目不允许离线分发；请在联网环境重试在线安装，或检查是否被错误地要求离线。';
  }
  return `「${DISTRIBUTION_MODE_LABELS[mode]}」不可用：请检查网络/代理，或改用「${DISTRIBUTION_MODE_LABELS['online-install']}」重试。`;
}
