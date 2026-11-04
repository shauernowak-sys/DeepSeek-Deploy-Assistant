/**
 * 生成随包分发的许可全文目录 `licenses/`（SEC-LIC / D05）。
 *
 *   tsx scripts/build-licenses.ts             # 写入 licenses/ 与 licenses/README.md
 *   tsx scripts/build-licenses.ts --check     # 只比对；不一致 exit 1（CI 用）
 *   tsx scripts/build-licenses.ts --licenses-dir=<path>
 *   tsx scripts/build-licenses.ts --runtime-root=<path>   # 私有运行时根目录（默认 %LOCALAPPDATA%\DeepSeekDeployAssistant）
 *
 * 许可全文来源：
 * - 本产品生产闭包：直接读 `node_modules` 里每个包自己的 LICENSE 文件（不猜、不生成）；
 * - Node.js / pnpm / Harness：读用户机器上已安装的官方发行包内的 LICENSE。
 *
 * 无时间戳输出，保证 CI 可 diff。运行时组件在 CI 机器上不存在时，若已提交的文件存在则沿用，
 * 并明确打印"未重新校验来源"——不静默当作通过。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LICENSE_DIR,
  licensesForClosure,
  parsePnpmListJson,
  pickLicenseFile,
  renderLicenseIndex,
  requiredRuntimeFiles,
  runtimeLicenseTargets,
} from '@dda/core';
import type { ClosurePackageLocation, LicenseTextTarget, RuntimeLicenseComponent } from '@dda/core';
import { BASELINE } from '@dda/spec';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_LICENSES_DIR = join(REPO_ROOT, LICENSE_DIR);

const RUNTIME_COMPONENTS: readonly RuntimeLicenseComponent[] = [
  { id: 'node', package: 'node', version: BASELINE.node.version, license: 'MIT' },
  { id: 'pnpm', package: 'pnpm', version: BASELINE.pnpm.version, license: 'MIT' },
  { id: 'harness', package: '@deepseek-ai/dsh', version: BASELINE.dsh.version, license: 'MIT' },
];

interface Options {
  check: boolean;
  licensesDir: string;
  runtimeRoot: string;
}

function parseArgs(argv: readonly string[]): Options {
  let check = false;
  let licensesDir = DEFAULT_LICENSES_DIR;
  let runtimeRoot = join(process.env.LOCALAPPDATA ?? '', 'DeepSeekDeployAssistant');
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2) as [string, string | undefined];
    if (key === '--check') check = true;
    else if (key === '--licenses-dir' && value !== undefined) licensesDir = resolve(value);
    else if (key === '--runtime-root' && value !== undefined) runtimeRoot = resolve(value);
    else throw new Error(`未知参数: ${arg}`);
  }
  return { check, licensesDir, runtimeRoot };
}

function pnpmList(cwd: string): string {
  return process.platform === 'win32'
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm list --prod --depth Infinity --json'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
    : execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
}

/** 运行时组件在用户机器上的官方发行包位置；读不到就返回 `undefined`（CI 上必然读不到）。 */
function runtimeSourceDir(id: RuntimeLicenseComponent['id'], runtimeRoot: string): string | undefined {
  const candidates: Record<RuntimeLicenseComponent['id'], string> = {
    node: join(runtimeRoot, 'runtimes', 'node', BASELINE.node.version),
    pnpm: join(runtimeRoot, 'runtimes', 'pnpm', 'node_modules', 'pnpm'),
    harness: join(runtimeRoot, 'harness', BASELINE.dsh.version, 'node_modules', '@deepseek-ai', 'dsh'),
  };
  const dir = candidates[id];
  return existsSync(dir) ? dir : undefined;
}

async function pickInDir(dir: string | undefined): Promise<{ file: string; text: string } | undefined> {
  if (dir === undefined) return undefined;
  const picked = pickLicenseFile(await readdir(dir));
  if (picked === undefined) return undefined;
  const text = await readFile(join(dir, picked), 'utf8');
  return { file: join(dir, picked), text };
}

function normalizeText(text: string): string {
  return `${text.replace(/\r\n/gu, '\n').trimEnd()}\n`;
}

interface Planned {
  target: LicenseTextTarget;
  text: string;
  /** 许可全文来源路径；`undefined` 表示沿用已提交文件。 */
  source?: string;
}

function readPackageLicenseField(raw: string): string | undefined {
  try {
    const pkg = JSON.parse(raw) as { license?: unknown };
    if (typeof pkg.license === 'string') return pkg.license;
    if (typeof pkg.license === 'object' && pkg.license !== null) {
      const nested = (pkg.license as { type?: unknown }).type;
      if (typeof nested === 'string') return nested;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 用真实安装目录补齐 SPDX 字段：pnpm 的 `list` 输出里很多包没有 license 字段。 */
async function enrichLicense(pkg: ClosurePackageLocation): Promise<ClosurePackageLocation> {
  if (pkg.license !== undefined && pkg.license.trim() !== '') return pkg;
  if (pkg.dir === undefined) return pkg;
  const fromField = readPackageLicenseField(await readFile(join(pkg.dir, 'package.json'), 'utf8'));
  if (fromField !== undefined) return { ...pkg, license: fromField };
  // 只有文件、没有字段时**不从正文猜 SPDX**（猜错等于伪造许可结论），沿用 npm 约定写法。
  const picked = await pickInDir(pkg.dir);
  if (picked === undefined) return pkg;
  const basename = picked.file.split(/[\\/]/u).pop() ?? 'LICENSE';
  return { ...pkg, license: `SEE LICENSE IN ${basename}` };
}

async function plan(options: Options): Promise<{ planned: Planned[]; problems: string[] }> {
  const problems: string[] = [];

  const closure = parsePnpmListJson(pnpmList(REPO_ROOT));
  const enriched: ClosurePackageLocation[] = [];
  for (const pkg of closure) enriched.push(await enrichLicense(pkg));

  const planned: Planned[] = [];

  for (const target of runtimeLicenseTargets(RUNTIME_COMPONENTS)) {
    const dir = runtimeSourceDir(target.origin as RuntimeLicenseComponent['id'], options.runtimeRoot);
    const picked = await pickInDir(dir);
    if (picked === undefined) {
      const existing = join(options.licensesDir, target.file.replace(`${LICENSE_DIR}/`, ''));
      if (existsSync(existing)) {
        planned.push({ target, text: normalizeText(await readFile(existing, 'utf8')) });
        console.log(`[licenses] ${target.package}: 未找到本机官方发行包，沿用已提交全文`);
      } else {
        problems.push(
          `${target.package}@${target.version} 的许可全文缺失：本机未安装该发行包，且 ${existing} 不存在`,
        );
      }
      continue;
    }
    planned.push({ target, text: normalizeText(picked.text), source: picked.file });
  }

  for (const target of licensesForClosure(enriched)) {
    const pkg = enriched.find(
      (candidate) => candidate.name === target.package && candidate.version === target.version,
    );
    const picked = await pickInDir(pkg?.dir);
    if (picked === undefined) {
      problems.push(
        `${target.package}@${target.version} 没有许可全文文件（${pkg?.dir ?? '无安装目录'}）；` +
          '该包不应随包分发，或需要人工补充许可原文',
      );
      continue;
    }
    planned.push({ target, text: normalizeText(picked.text), source: picked.file });
  }

  return { planned, problems };
}

async function listedFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const nested of await readdir(join(dir, entry.name))) {
        files.push(`${entry.name}/${nested}`);
      }
      continue;
    }
    files.push(entry.name);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const { planned, problems } = await plan(options);

  if (problems.length > 0) {
    for (const problem of problems) console.error(`[licenses] 问题: ${problem}`);
    return 1;
  }

  const targets = planned.map((item) => item.target);
  const index = renderLicenseIndex(targets);
  const failures: string[] = [];

  for (const item of planned) {
    const relative = item.target.file.replace(`${LICENSE_DIR}/`, '');
    const destination = join(options.licensesDir, relative);
    if (options.check) {
      let current = '';
      try {
        current = normalizeText(await readFile(destination, 'utf8'));
      } catch {
        failures.push(`缺少 ${relative}`);
        continue;
      }
      if (current !== item.text) {
        failures.push(`${relative} 与来源不一致（${item.source ?? '已提交文件'}）`);
      }
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, item.text, 'utf8');
  }

  if (options.check) {
    for (const required of requiredRuntimeFiles()) {
      const relative = required.replace(`${LICENSE_DIR}/`, '');
      if (!targets.some((target) => target.file === required)) {
        failures.push(`清单要求的 ${relative} 未生成（node.json 等清单直接引用它）`);
      }
    }
    const indexDestination = join(options.licensesDir, 'README.md');
    let currentIndex = '';
    try {
      currentIndex = normalizeText(await readFile(indexDestination, 'utf8'));
    } catch {
      failures.push('缺少 README.md（许可全文索引）');
    }
    if (currentIndex !== '' && currentIndex !== index) {
      failures.push('README.md 与当前依赖闭包不一致');
    }

    const expected = new Set([...targets.map((target) => target.file.replace(`${LICENSE_DIR}/`, '')), 'README.md']);
    for (const file of await listedFiles(options.licensesDir)) {
      if (!expected.has(file)) failures.push(`多余文件 licenses/${file}（对应包已不在闭包内）`);
    }

    if (failures.length > 0) {
      for (const failure of failures) console.error(`[licenses] ${failure}`);
      console.error('\n[licenses] 不一致；请运行 npm run licenses:build 后提交');
      return 1;
    }
    console.log(
      `\n[licenses] OK：${targets.length} 份许可全文（含 ${requiredRuntimeFiles().length} 份运行时组件），与依赖闭包一致`,
    );
    return 0;
  }

  await mkdir(options.licensesDir, { recursive: true });
  await writeFile(join(options.licensesDir, 'README.md'), index, 'utf8');

  const expected = new Set([...targets.map((target) => target.file.replace(`${LICENSE_DIR}/`, '')), 'README.md']);
  for (const file of await listedFiles(options.licensesDir)) {
    if (!expected.has(file)) {
      await rm(join(options.licensesDir, file));
      console.log(`[licenses] 已删除过期文件 licenses/${file}`);
    }
  }

  for (const item of planned) {
    const relative = item.target.file.replace(`${LICENSE_DIR}/`, '');
    console.log(
      `[licenses] ${relative.padEnd(46)} ${item.target.package}@${item.target.version} ` +
        `(${item.target.license})${item.source === undefined ? ' [沿用]' : ''}`,
    );
  }
  console.log(`\n[licenses] 已写入 ${planned.length} 份许可全文 + README.md 于 ${options.licensesDir}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[licenses] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

// `dirname` 仅用于未来扩展路径解析；显式引用避免未使用导入告警。
void dirname;
