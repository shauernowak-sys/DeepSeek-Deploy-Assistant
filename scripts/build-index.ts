/**
 * D01 索引构建链 CLI。
 *
 *   tsx scripts/build-index.ts                 # 生成 + 官方校验器校验 + registry 复核
 *   tsx scripts/build-index.ts --offline       # 跳过 registry 复核（无网环境；产物照样过官方校验器）
 *   tsx scripts/build-index.ts --out=<dir>     # 自定义输出目录
 *
 * 产物：
 *   <out>/index.json            官方 format 1，由 @deepseek-ai/dsh-plugin-market-index 校验
 *   <out>/catalog.overlay.json  我方 overlay（许可/哈希/闭包/验收/风险）
 *   <out>/icons/*               索引引用的相对图标
 *
 * 退出码：0 = 产物可信；1 = 任一校验失败（CI 依赖此行为）。
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MarketIndexError, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

import {
  MARKET_FIELD_OWNERSHIP,
  MARKET_INDEX_BASE_URL,
  buildMarketIndex,
  buildOverlay,
  collectCatalogProblems,
  collectIconProblems,
  collectIndexProblems,
  collectRegistryProblems,
  type RegistryVersionFacts,
} from '@dda/core';
import { loadMatrix } from '@dda/core';
import type { Catalog } from '@dda/spec';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'apps', 'desktop', 'resources', 'market');
const CATALOG_DIR = join(REPO_ROOT, 'catalog');
const COMPAT_PATH = join(REPO_ROOT, 'apps', 'desktop', 'resources', 'manifests', 'compat.json');

interface Options {
  outDir: string;
  baseUrl: string;
  offline: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { outDir: DEFAULT_OUT_DIR, baseUrl: MARKET_INDEX_BASE_URL, offline: false };
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2) as [string, string | undefined];
    if (key === '--out') {
      if (value === undefined) throw new Error('--out 需要取值');
      options.outDir = resolve(value);
    } else if (key === '--base-url') {
      if (value === undefined) throw new Error('--base-url 需要取值');
      options.baseUrl = value;
    } else if (key === '--offline') {
      options.offline = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

async function loadCatalog(): Promise<Catalog> {
  // 动态导入：catalog 在模块顶层就做 zod 解析，静态导入会让错误以堆栈形式抛出、看不出是哪个字段。
  const module = (await import('../catalog/index')) as { CATALOG: Catalog };
  return module.CATALOG;
}

function npmJson(args: readonly string[]): unknown {
  const isWin = process.platform === 'win32';
  const raw = isWin
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm view ${args.join(' ')} --json`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
    : execFileSync('npm', ['view', ...args, '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
  return JSON.parse(raw) as unknown;
}

/**
 * `npm view <pkg> --json` 返回的是「latest 的 manifest + versions 列表」，不是逐版本的 dist，
 * 因此 publishTimestamp 与 integrity 分开取：一次 time 表 + 每个锁定版本一次 dist.integrity。
 */
function readVersionFacts(name: string, version: string): RegistryVersionFacts {
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) {
    throw new Error(`包名不符合 npm 语法，拒绝执行: ${name}`);
  }
  const timeMap = npmJson([name, 'time']) as Record<string, unknown>;
  const published = timeMap[version];
  const integrity = npmJson([`${name}@${version}`, 'dist.integrity']);
  return {
    versionExists: typeof published === 'string',
    ...(typeof published === 'string' && Number.isFinite(Math.floor(Date.parse(published) / 1000))
      ? { publishTimestamp: Math.floor(Date.parse(published) / 1000) }
      : {}),
    ...(typeof integrity === 'string' && integrity !== '' ? { integrity } : {}),
  };
}

async function copyIcons(outDir: string): Promise<number> {
  const sourceDir = join(CATALOG_DIR, 'icons');
  const targetDir = join(outDir, 'icons');
  await mkdir(targetDir, { recursive: true });
  let files: string[] = [];
  try {
    files = await readdir(sourceDir);
  } catch {
    return 0;
  }
  for (const file of files) {
    await copyFile(join(sourceDir, file), join(targetDir, file));
  }
  return files.length;
}

function printFieldOwnership(): void {
  console.log('\n字段分工（官方库负责的规则不得在本仓库重复实现）：');
  console.log('  官方校验器：');
  for (const rule of MARKET_FIELD_OWNERSHIP.official) console.log(`    - ${rule}`);
  console.log('  我方 overlay：');
  for (const field of MARKET_FIELD_OWNERSHIP.overlay) console.log(`    - ${field}`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const catalog = await loadCatalog();
  const matrix = loadMatrix(JSON.parse(await readFile(COMPAT_PATH, 'utf8')));

  const problems: string[] = [...collectCatalogProblems(catalog, matrix)];
  problems.push(...(await collectIconProblems(CATALOG_DIR, catalog)));

  const index = buildMarketIndex(catalog);
  const overlay = buildOverlay(catalog, `catalog@${catalog.entries.map((e) => `${e.name}@${e.version}`).join(',')}`);

  await mkdir(options.outDir, { recursive: true });
  await writeFile(join(options.outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await writeFile(
    join(options.outDir, 'catalog.overlay.json'),
    `${JSON.stringify(overlay, null, 2)}\n`,
    'utf8',
  );
  const iconCount = await copyIcons(options.outDir);

  // 官方校验器：生成物必须能通过它，否则说明构建链产出了格式 1 之外的东西。
  const written = JSON.parse(await readFile(join(options.outDir, 'index.json'), 'utf8')) as unknown;
  let parsed;
  try {
    parsed = parseMarketIndex(written, options.baseUrl);
  } catch (error) {
    if (error instanceof MarketIndexError) {
      console.error(`\n[build-index] 官方校验器拒绝: ${error.path} ${error.reason}`);
      printFieldOwnership();
      return 1;
    }
    throw error;
  }
  problems.push(...collectIndexProblems(catalog, index, parsed, options.baseUrl));

  if (options.offline) {
    console.log('[build-index] --offline：跳过 registry 的 publishTimestamp / integrity 复核');
  } else {
    const facts = new Map<string, RegistryVersionFacts>();
    for (const entry of catalog.entries) {
      facts.set(`${entry.name}@${entry.version}`, readVersionFacts(entry.name, entry.version));
    }
    problems.push(...collectRegistryProblems(catalog, facts));
  }

  console.log(
    `[build-index] index.json: ${index.plugins.length} 个插件 / ` +
      `${index.plugins.reduce((sum, plugin) => sum + plugin.versions.length, 0)} 个版本 · ` +
      `overlay: ${overlay.plugins.length} 条 · 图标: ${iconCount} 个`,
  );
  console.log(`[build-index] 输出目录: ${options.outDir}`);
  console.log(`[build-index] 校验基址: ${options.baseUrl}`);
  printFieldOwnership();

  if (problems.length > 0) {
    console.error('\n[build-index] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log('\n[build-index] OK（官方校验器 + 我方断言全部通过）');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[build-index] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
