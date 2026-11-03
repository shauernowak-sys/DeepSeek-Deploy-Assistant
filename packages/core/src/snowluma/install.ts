import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

import yauzl from 'yauzl';

import {
  DdaError,
  ERROR_CODES,
  SnowLumaInstallRecordSchema,
  type SnowLumaInstallRecord,
} from '@dda/spec';

import { extractZip } from '../transfer/extract';

/**
 * SnowLuma 解压与安装（M3.3-03）。
 *
 * 设计要点（都是"真实用户机器上会出事"的场景）：
 *  - **只替换包内条目**：升级/修复时按 `release.json` 的 `entries` 逐个替换，`config/` 与 `data/`
 *    永远不在条目里，因此用户的 OneBot 配置、WebUI 口令、QQ 登录态天然被保留；
 *  - **先 staging 再落盘 + 日志回滚**：任一步失败都能把安装目录恢复原状，不留半个版本；
 *  - **失败只清理本次临时文件**：staging/backup 都在我们自己的 state 目录下，不碰用户数据；
 *  - **磁盘空间预检**：先算解压后总字节，空间不够就提前失败（E_DISK_FULL）。
 */

export interface InstallFsDeps {
  exists(path: string): Promise<boolean>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  /** 可用磁盘字节数；拿不到时返回 undefined（跳过预检，不阻断安装）。 */
  freeBytes(path: string): Promise<number | undefined>;
  extract(options: { zipPath: string; destDir: string }): Promise<{ files: number; bytes: number }>;
  uncompressedSize(zipPath: string): Promise<number>;
  now(): Date;
}

export function createNodeInstallDeps(): InstallFsDeps {
  return {
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (path, encoding) => readFile(path, encoding),
    readdir: (path) => readdir(path),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    remove: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
    rename: async (from, to) => {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
    },
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, 'utf8');
    },
    async freeBytes(path) {
      try {
        const fsStat = await statfs(path);
        return Number(fsStat.bavail) * Number(fsStat.bsize);
      } catch {
        return undefined;
      }
    },
    extract: (options) => extractZip({ ...options, stripTopLevelDir: false }),
    uncompressedSize: sumUncompressedSize,
    now: () => new Date(),
  };
}

/** 统计 zip 解压后的总字节数（只读条目表，不解压）。 */
function sumUncompressedSize(zipPath: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('无法打开压缩包'));
        return;
      }
      let total = 0;
      zipfile.on('entry', (entry: yauzl.Entry) => {
        total += entry.uncompressedSize;
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolvePromise(total));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

/** 包内必须存在的文件（来自官方 v2.4.0 实测结构，见 docs/M3.3-实施报告.md §3）。 */
export const REQUIRED_PACKAGE_FILES = [
  'release.json',
  'package.json',
  'index.mjs',
  'node.exe',
  'launcher.bat',
  'client/index.html',
  'native/snowluma-win32-x64.node',
] as const;

/** 用户数据目录：永远不在替换范围内。 */
const USER_DATA_DIRS = ['config', 'data', 'logs'] as const;

export interface ReleaseJsonShape {
  version?: unknown;
  target?: unknown;
  entries?: unknown;
}

interface PackageValidation {
  ok: boolean;
  version?: string;
  target?: string;
  entries: string[];
  problems: string[];
}

/** 校验包根目录结构；返回的 entries 已过滤为安全的顶层名称。 */
export async function validatePackageRoot(
  deps: Pick<InstallFsDeps, 'exists' | 'readFile'>,
  packageRoot: string,
  expectedVersion: string,
): Promise<PackageValidation> {
  const problems: string[] = [];

  for (const relative of REQUIRED_PACKAGE_FILES) {
    const path = join(packageRoot, relative.replace(/\//g, sep));
    if (!(await deps.exists(path))) problems.push(`缺少文件 ${relative}`);
  }

  let version: string | undefined;
  let target: string | undefined;
  const entries: string[] = [];
  try {
    const raw = JSON.parse(await deps.readFile(join(packageRoot, 'release.json'), 'utf8')) as ReleaseJsonShape;
    version = typeof raw.version === 'string' ? raw.version : undefined;
    target = typeof raw.target === 'string' ? raw.target : undefined;
    if (Array.isArray(raw.entries)) {
      for (const item of raw.entries) {
        if (typeof item !== 'string') continue;
        const normalized = normalize(item);
        if (!normalized || normalized.includes('..') || normalized.includes(sep) || /^[A-Za-z]:/.test(normalized)) {
          problems.push(`release.json 的条目不安全：${item}`);
          continue;
        }
        if ((USER_DATA_DIRS as readonly string[]).includes(normalized)) {
          problems.push(`release.json 试图覆盖用户数据目录：${item}`);
          continue;
        }
        entries.push(normalized);
      }
    } else {
      problems.push('release.json 缺少 entries 数组');
    }
  } catch (error) {
    problems.push(`release.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }

  if (version !== expectedVersion) problems.push(`包内版本 ${version ?? '(未知)'} 与期望 ${expectedVersion} 不一致`);
  if (target !== undefined && target !== 'win32-x64') problems.push(`包内平台 ${target} 不是 win32-x64`);

  return { ok: problems.length === 0, version, target, entries, problems };
}

interface ExistingInstall {
  installed: boolean;
  version?: string;
  hasConfig: boolean;
  hasUserData: boolean;
  entries: string[];
}

export async function inspectExistingInstall(
  deps: Pick<InstallFsDeps, 'exists' | 'readFile'>,
  installDir: string,
): Promise<ExistingInstall> {
  const releasePath = join(installDir, 'release.json');
  const installed = await deps.exists(releasePath);
  let version: string | undefined;
  let entries: string[] = [];
  if (installed) {
    try {
      const raw = JSON.parse(await deps.readFile(releasePath, 'utf8')) as ReleaseJsonShape;
      version = typeof raw.version === 'string' ? raw.version : undefined;
      entries = Array.isArray(raw.entries) ? raw.entries.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      // 损坏的 release.json 当作"未安装/需修复"。
    }
  }
  return {
    installed,
    version,
    hasConfig: await deps.exists(join(installDir, 'config')),
    hasUserData: await deps.exists(join(installDir, 'data')),
    entries,
  };
}

/** 若压缩包只有一个顶层目录（很多项目如此），返回该目录，否则返回原目录。 */
async function resolvePackageRoot(deps: Pick<InstallFsDeps, 'readdir' | 'exists'>, stagingDir: string): Promise<string> {
  const names = await deps.readdir(stagingDir);
  if (names.length !== 1) return stagingDir;
  const only = names[0]!;
  const candidate = join(stagingDir, only);
  if (await deps.exists(join(candidate, 'release.json'))) return candidate;
  return stagingDir;
}

/**
 * 需要落盘的条目 = `release.json` 里声明的条目 ∪ 必需文件所在的顶层条目。
 *
 * 上游 v2.4.0 的 `release.json` **没有列出 `node.exe`**（实测：entries 只有
 * EULA/PRIVACY/check-node-version/client/index/launcher/native/package/release），
 * 但它是完整版自带的运行时。只按 entries 复制会得到一个"没有 node.exe"的安装目录，
 * 因此这里必须把必需文件的顶层条目也补进来。用户数据目录永远排除。
 */
async function resolveInstallEntries(
  deps: Pick<InstallFsDeps, 'exists'>,
  packageRoot: string,
  declared: string[],
): Promise<string[]> {
  const result: string[] = [];
  const add = (entry: string) => {
    if (!entry) return;
    if ((USER_DATA_DIRS as readonly string[]).includes(entry)) return;
    if (!result.includes(entry)) result.push(entry);
  };
  for (const entry of declared) add(entry);
  for (const required of REQUIRED_PACKAGE_FILES) {
    const top = required.split('/')[0]!;
    if (result.includes(top)) continue;
    if (await deps.exists(join(packageRoot, required.replace(/\//g, sep)))) add(top);
  }
  return result;
}

interface InstallOptions {
  zipPath: string;
  installDir: string;
  expectedVersion: string;
  sha256: string;
  sizeBytes: number;
  sourceUrl: string;
  fileName: string;
  /** 我们自己的暂存/备份/记录位置（都在应用 state 目录下）。 */
  stagingDir: string;
  backupDir: string;
  recordPath: string;
  repair?: boolean;
  signal?: AbortSignal;
  onProgress?: (info: { phase: 'extract' | 'swap' | 'validate'; files: number; bytes: number }) => void;
}

interface InstallResult {
  installDir: string;
  version: string;
  /** 之前没有安装 → false；覆盖安装/升级/修复 → true。 */
  upgraded: boolean;
  /** 本次是否真的解压落盘（同版本且结构完整时为 false）。 */
  changed: boolean;
  preserved: { config: boolean; data: boolean };
  files: number;
  bytes: number;
  evidence: string[];
  record: SnowLumaInstallRecord;
}

interface JournalEntry {
  entry: string;
  hadExisting: boolean;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('已取消安装'), { cancelled: true });
}

export async function installPackage(
  deps: InstallFsDeps,
  options: InstallOptions,
): Promise<InstallResult> {
  const installDir = resolve(options.installDir);
  const evidence: string[] = [];

  const existing = await inspectExistingInstall(deps, installDir);
  const preserved = { config: existing.hasConfig, data: existing.hasUserData };
  if (existing.installed) {
    evidence.push(`安装：检测到已有安装（版本 ${existing.version ?? '未知'}）`);
  } else {
    evidence.push('安装：目录里没有 release.json，按全新安装处理');
  }
  if (preserved.config) evidence.push('安装：已存在 config/，本次不会触碰');
  if (preserved.data) evidence.push('安装：已存在 data/（QQ 登录态与消息库），本次不会触碰');

  // 同版本且结构完整：直接复用，不重复解压（除非用户点"修复"）。
  if (existing.installed && existing.version === options.expectedVersion && !options.repair) {
    const validation = await validatePackageRoot(deps, installDir, options.expectedVersion);
    if (validation.ok) {
      evidence.push(`安装：已是 v${options.expectedVersion} 且结构完整，跳过解压（需要强制覆盖请用"修复"）`);
      const record = await writeInstallRecord(deps, options.recordPath, {
        installDir,
        version: options.expectedVersion,
        sha256: options.sha256,
        sizeBytes: options.sizeBytes,
        sourceUrl: options.sourceUrl,
        now: deps.now(),
      });
      return {
        installDir,
        version: options.expectedVersion,
        upgraded: true,
        changed: false,
        preserved,
        files: 0,
        bytes: 0,
        evidence,
        record,
      };
    }
    evidence.push(`安装：结构不完整（${validation.problems.slice(0, 3).join('；')}），按修复处理`);
  }

  assertNotAborted(options.signal);

  // 磁盘空间预检。
  let packageBytes = 0;
  try {
    packageBytes = await deps.uncompressedSize(options.zipPath);
  } catch {
    packageBytes = options.sizeBytes * 3;
  }
  const free = await deps.freeBytes(dirname(installDir));
  if (free !== undefined && free < packageBytes + 64 * 1024 * 1024) {
    throw new DdaError(
      ERROR_CODES.E_DISK_FULL,
      `磁盘可用空间不足：需要约 ${Math.ceil(packageBytes / 1024 / 1024)} MB，当前可用 ${Math.floor(free / 1024 / 1024)} MB`,
      '清理磁盘后重试；已下载的安装包会保留，不必重新下载',
    );
  }
  evidence.push(`安装：解压后约 ${(packageBytes / 1024 / 1024).toFixed(1)} MB，磁盘可用 ${free === undefined ? '未知' : `${Math.floor(free / 1024 / 1024)} MB`}`);

  await deps.remove(options.stagingDir);
  await deps.mkdir(options.stagingDir);
  await deps.remove(options.backupDir);
  await deps.mkdir(options.backupDir);
  await deps.mkdir(installDir);

  let extracted: { files: number; bytes: number };
  try {
    extracted = await deps.extract({ zipPath: options.zipPath, destDir: options.stagingDir });
  } catch (error) {
    await deps.remove(options.stagingDir);
    throw error;
  }
  assertNotAborted(options.signal);
  evidence.push(`安装：解压完成 ${extracted.files} 个文件（${(extracted.bytes / 1024 / 1024).toFixed(1)} MB）`);
  options.onProgress?.({ phase: 'extract', files: extracted.files, bytes: extracted.bytes });

  const packageRoot = await resolvePackageRoot(deps, options.stagingDir);
  const validation = await validatePackageRoot(deps, packageRoot, options.expectedVersion);
  if (!validation.ok) {
    await deps.remove(options.stagingDir);
    throw new DdaError(
      ERROR_CODES.E_EXTRACT_FAILED,
      `安装包结构校验失败：${validation.problems.join('；')}`,
      '改用官方发布包重新下载；已下载的损坏包不会被使用',
    );
  }
  evidence.push(`安装：release.json 校验通过（version=${validation.version}，target=${validation.target}）`);

  const journal: JournalEntry[] = [];
  try {
    for (const entry of await resolveInstallEntries(deps, packageRoot, validation.entries)) {
      assertNotAborted(options.signal);
      const from = join(packageRoot, entry);
      if (!(await deps.exists(from))) {
        evidence.push(`安装：条目 ${entry} 在包内不存在，跳过`);
        continue;
      }
      const target = join(installDir, entry);
      const hadExisting = await deps.exists(target);
      if (hadExisting) await deps.rename(target, join(options.backupDir, entry));
      journal.push({ entry, hadExisting });
      await deps.rename(from, target);
    }
    options.onProgress?.({ phase: 'swap', files: validation.entries.length, bytes: extracted.bytes });

    const post = await validatePackageRoot(deps, installDir, options.expectedVersion);
    if (!post.ok) {
      throw new DdaError(
        ERROR_CODES.E_EXTRACT_FAILED,
        `落盘后结构校验失败：${post.problems.join('；')}`,
        '已回滚到安装前状态',
      );
    }
    options.onProgress?.({ phase: 'validate', files: post.entries.length, bytes: extracted.bytes });
  } catch (error) {
    await rollback(deps, installDir, options.backupDir, journal);
    await deps.remove(options.stagingDir);
    throw error;
  }

  await deps.remove(options.stagingDir);
  await deps.remove(options.backupDir);

  const record = await writeInstallRecord(deps, options.recordPath, {
    installDir,
    version: options.expectedVersion,
    sha256: options.sha256,
    sizeBytes: options.sizeBytes,
    sourceUrl: options.sourceUrl,
    now: deps.now(),
  });
  evidence.push(`安装：已写入安装记录（${options.recordPath}）`);

  return {
    installDir,
    version: options.expectedVersion,
    upgraded: existing.installed,
    changed: true,
    preserved,
    files: extracted.files,
    bytes: extracted.bytes,
    evidence,
    record,
  };
}

async function rollback(
  deps: InstallFsDeps,
  installDir: string,
  backupDir: string,
  journal: JournalEntry[],
): Promise<void> {
  for (const item of [...journal].reverse()) {
    const target = join(installDir, item.entry);
    try {
      await deps.remove(target);
      if (item.hadExisting) await deps.rename(join(backupDir, item.entry), target);
    } catch {
      // 回滚尽力而为；失败也不抛，避免掩盖原始错误（调用方会展示原始失败原因）。
    }
  }
}

async function writeInstallRecord(
  deps: Pick<InstallFsDeps, 'writeFile'>,
  recordPath: string,
  input: {
    installDir: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    sourceUrl: string;
    now: Date;
  },
): Promise<SnowLumaInstallRecord> {
  const record = SnowLumaInstallRecordSchema.parse({
    id: 'snowluma',
    version: input.version,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    sourceUrl: input.sourceUrl,
    installDir: input.installDir,
    installedAt: input.now.toISOString(),
  });
  await deps.writeFile(recordPath, JSON.stringify(record, null, 2));
  return record;
}

