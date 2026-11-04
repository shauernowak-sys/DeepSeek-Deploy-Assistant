import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { DdaError, ERROR_CODES } from '@dda/spec';
import type { CatalogEntry } from '@dda/spec';

import { assertSafeEntryPath, cleanupDir, extractZip } from '../transfer/extract';
import { sha256File } from '../transfer/downloader';
import { evaluateClosure } from './license-gate';

/**
 * D04 本地导入：zip / tgz / 目录 三种入口，统一产出**绝对路径**的 `.tgz`。
 *
 * 三条硬约束（docs/M4-D01-D11-实施计划.md D04、PRD CN-5 / LIC-2）：
 * 1. **许可门禁先行**：本地导入等于我方分发这些字节。闭包含 `UNLICENSED` 时直接拒绝，
 *    因此官方 QQ 插件永远无法通过本地导入绕过 Gate 4 ②；
 * 2. 导入前校验包内容：`name/version` 与 catalog 一致、声明 `dsh.bundle.patch`、无生命周期脚本；
 * 3. 提供期望哈希时按 SHA-256 比对，不一致即拒并删除产物（沿用 P-9 的错误码口径）。
 */

export type LocalImportKind = 'directory' | 'tgz' | 'zip';

export const LOCAL_IMPORT_EXTENSIONS: Readonly<Record<Exclude<LocalImportKind, 'directory'>, string>> = {
  tgz: '.tgz',
  zip: '.zip',
};

export const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

export interface TarballEntry {
  name: string;
  size: number;
  type: 'file' | 'directory' | 'other';
}

export interface ImportedPackageJson {
  name?: unknown;
  version?: unknown;
  dsh?: unknown;
  scripts?: unknown;
}

function octal(header: Buffer, start: number, length: number): number {
  const text = header
    .toString('ascii', start, start + length)
    .replace(/\0.*$/u, '')
    .trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** 解析 tar（ustar）条目；只读元数据，不解压全部内容。 */
export function listTarballEntries(archive: Buffer): TarballEntry[] {
  const entries: TarballEntry[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = header
      .toString('utf8', 0, 100)
      .replace(/\0.*$/u, '')
      .trim();
    if (name === '') break; // 结束块
    const prefix = header
      .toString('utf8', 345, 500)
      .replace(/\0.*$/u, '')
      .trim();
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 48);
    entries.push({
      name: prefix === '' ? name : `${prefix}/${name}`,
      size,
      type: typeflag === '5' ? 'directory' : typeflag === '0' || typeflag === '\0' ? 'file' : 'other',
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** 读取 tar 里某个文件的原始内容（找不到返回 undefined）。 */
export function readTarballFile(archive: Buffer, target: string): Buffer | undefined {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = header
      .toString('utf8', 0, 100)
      .replace(/\0.*$/u, '')
      .trim();
    if (name === '') return undefined;
    const prefix = header
      .toString('utf8', 345, 500)
      .replace(/\0.*$/u, '')
      .trim();
    const size = octal(header, 124, 12);
    const fullName = prefix === '' ? name : `${prefix}/${name}`;
    if (normalizeEntryName(fullName) === normalizeEntryName(target)) {
      const start = offset + 512;
      return archive.subarray(start, start + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/** `./package/lib/a.js` → `lib/a.js`；`package/package.json` → `package.json`。 */
export function normalizeEntryName(name: string): string {
  const trimmed = name.replace(/\\/gu, '/').replace(/^\.\//u, '');
  return trimmed.startsWith('package/') ? trimmed.slice('package/'.length) : trimmed;
}

export interface TarballInspection {
  entries: string[];
  packageJson: ImportedPackageJson;
}

/** 读 `.tgz`：先做路径安全检查（zip-slip 同类），再取 `package.json`。 */
export async function inspectTgz(filePath: string): Promise<TarballInspection> {
  let archive: Buffer;
  try {
    archive = gunzipSync(await readFile(filePath));
  } catch {
    throw new DdaError(ERROR_CODES.E_EXTRACT_FAILED, `不是有效的 .tgz：${filePath}`, '重新导出一个未损坏的压缩包');
  }

  const entries = listTarballEntries(archive);
  for (const entry of entries) assertSafeEntryPath(entry.name);

  const raw = readTarballFile(archive, 'package/package.json') ?? readTarballFile(archive, 'package.json');
  if (raw === undefined) {
    throw new DdaError(ERROR_CODES.E_MANIFEST_INVALID, '压缩包里没有 package.json', '确认压缩的是插件包本身');
  }
  return { entries: entries.map((entry) => normalizeEntryName(entry.name)), packageJson: parsePackageJson(raw) };
}

function parsePackageJson(raw: Buffer): ImportedPackageJson {
  try {
    return JSON.parse(raw.toString('utf8')) as ImportedPackageJson;
  } catch {
    throw new DdaError(ERROR_CODES.E_MANIFEST_INVALID, 'package.json 不是合法 JSON', '修正后再导入');
  }
}

export function detectImportKind(sourcePath: string): LocalImportKind {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === '.tgz' || extension === '.tar.gz') return 'tgz';
  if (extension === '.zip') return 'zip';
  return 'directory';
}

/** 许可门禁：本地导入属于"我方分发"，闭包必须 100% 允许再分发。 */
export function assertLocalImportAllowed(entry: CatalogEntry): void {
  if (entry.status === 'blocked') {
    throw new DdaError(
      ERROR_CODES.E_DISTRIBUTION_BLOCKED,
      `${entry.name} 的条目状态为 blocked，不允许导入`,
      '改用在线安装或联系维护方',
    );
  }
  const report = evaluateClosure(`${entry.name}@${entry.version}`, entry.depsClosure);
  if (entry.license.redistributable && report.verdict === 'allowed') return;
  const offenders = [...report.denied, ...report.needsReview];
  throw new DdaError(
    ERROR_CODES.E_DISTRIBUTION_BLOCKED,
    `${entry.name} 不能通过本地导入分发：` +
      (offenders.length > 0
        ? offenders.map((pkg) => `${pkg.name}@${pkg.version}（${pkg.license}）`).join('、')
        : '条目声明不可再分发'),
    '改用在线安装：本软件只代为调用官方安装命令，不复制其字节',
  );
}

/** 包内容校验；返回问题列表（空数组表示通过）。 */
export function validateImportedPackage(pkg: ImportedPackageJson, entry: CatalogEntry): string[] {
  const problems: string[] = [];

  if (pkg.name !== entry.name) {
    problems.push(`包名不符：包内是 ${String(pkg.name ?? '(缺失)')}，期望 ${entry.name}`);
  }
  if (pkg.version !== entry.version) {
    problems.push(`版本不符：包内是 ${String(pkg.version ?? '(缺失)')}，期望 ${entry.version}`);
  }

  const patch = (pkg.dsh as { bundle?: { patch?: unknown } } | undefined)?.bundle?.patch;
  if (typeof patch !== 'string' || patch.trim() === '') {
    problems.push('package.json 没有声明 dsh.bundle.patch（不是 Harness 插件包）');
  }

  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  if (scripts !== undefined && typeof scripts === 'object') {
    const installed = LIFECYCLE_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
    if (installed.length > 0) {
      problems.push(`包含生命周期脚本（${installed.join(', ')}），导入包不允许执行安装脚本`);
    }
  }

  return problems;
}

export interface PrepareImportRequest {
  sourcePath: string;
  entry: CatalogEntry;
  /** 产物目录（绝对路径）；目录/zip 导入的 tgz 会写到这里。 */
  outDir: string;
  /** 期望的 SHA-256（十六进制）；提供则必须一致。 */
  expectedSha256?: string;
  /** 目录/zip → tgz 的打包器（适配器注入，见 `packDirectoryToTgz`）。 */
  packDirectory: (directory: string, outDir: string) => Promise<string>;
}

export interface PrepareImportResult {
  kind: LocalImportKind;
  /** 交给 pnpm 的绝对路径 `.tgz`。 */
  tgzPath: string;
  sha256: string;
  hashChecked: boolean;
  packageJson: ImportedPackageJson;
  warnings: string[];
}

export async function prepareLocalImport(request: PrepareImportRequest): Promise<PrepareImportResult> {
  const { entry } = request;

  // ① 许可门禁必须先于任何文件操作：导入即分发。
  assertLocalImportAllowed(entry);

  const sourcePath = resolve(request.sourcePath);
  const kind = detectImportKind(sourcePath);
  const warnings: string[] = [];
  let tempDir: string | undefined;
  let produced: string | undefined;

  try {
    let inspection: TarballInspection;
    let tgzPath: string;

    if (kind === 'tgz') {
      inspection = await inspectTgz(sourcePath);
      tgzPath = sourcePath;
    } else if (kind === 'zip') {
      tempDir = await mkdtemp(join(tmpdir(), 'dda-import-'));
      await extractZip({ zipPath: sourcePath, destDir: tempDir });
      inspection = await inspectDirectory(tempDir);
      tgzPath = await request.packDirectory(tempDir, resolve(request.outDir));
      produced = tgzPath;
    } else {
      const info = await stat(sourcePath).catch(() => undefined);
      if (info === undefined || !info.isDirectory()) {
        throw new DdaError(ERROR_CODES.E_MANIFEST_INVALID, `导入目录不存在：${sourcePath}`, '选择包含 package.json 的目录');
      }
      inspection = await inspectDirectory(sourcePath);
      tgzPath = await request.packDirectory(sourcePath, resolve(request.outDir));
      produced = tgzPath;
    }

    // ② 包内容校验
    const problems = validateImportedPackage(inspection.packageJson, entry);
    if (problems.length > 0) {
      throw new DdaError(ERROR_CODES.E_MANIFEST_INVALID, problems.join('；'), '修正插件包后重新导入');
    }

    // ③ 打包产物必须真的包含 bundle patch（`files` 漏配时最容易出问题）
    const patch = (inspection.packageJson.dsh as { bundle?: { patch?: string } }).bundle?.patch ?? '';
    const patchName = normalizeEntryName(patch);
    const finalEntries =
      kind === 'tgz' ? inspection.entries : (await inspectTgz(tgzPath)).entries;
    if (!finalEntries.includes(patchName)) {
      throw new DdaError(
        ERROR_CODES.E_MANIFEST_INVALID,
        `打包结果缺少 ${patchName}（package.json 的 files 字段可能没有包含它）`,
        `把 ${patchName} 加入 package.json 的 files 后重新导入`,
      );
    }

    // ④ 哈希
    const sha256 = await sha256File(tgzPath);
    if (request.expectedSha256 !== undefined) {
      const expected = request.expectedSha256.toLowerCase();
      if (sha256 !== expected) {
        throw new DdaError(
          ERROR_CODES.E_HASH_MISMATCH,
          `导入包哈希不一致：期望 ${expected.slice(0, 12)}…，实际 ${sha256.slice(0, 12)}…`,
          '确认包没有被替换；哈希不一致的文件不会被安装',
        );
      }
    } else {
      warnings.push('未提供期望哈希：本次导入没有与清单比对（仅限用户自备包）');
    }

    if (!isAbsolute(tgzPath)) {
      throw new DdaError(ERROR_CODES.E_MANIFEST_INVALID, `导入产物必须是绝对路径：${tgzPath}`, '内部错误，请反馈');
    }

    return { kind, tgzPath, sha256, hashChecked: request.expectedSha256 !== undefined, packageJson: inspection.packageJson, warnings };
  } catch (error) {
    // 失败不留半成品：删除本次生成的 tgz。
    if (produced !== undefined) await rm(produced, { force: true });
    throw error;
  } finally {
    if (tempDir !== undefined) await cleanupDir(tempDir);
  }
}

async function inspectDirectory(dir: string): Promise<TarballInspection> {
  let raw: Buffer;
  try {
    raw = await readFile(join(dir, 'package.json'));
  } catch {
    throw new DdaError(
      ERROR_CODES.E_MANIFEST_INVALID,
      `目录里没有 package.json：${dir}`,
      '选择插件包根目录（含 package.json）再导入',
    );
  }
  return { entries: [], packageJson: parsePackageJson(raw) };
}
