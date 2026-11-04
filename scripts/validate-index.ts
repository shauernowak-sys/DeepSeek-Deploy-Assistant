/**
 * D01 产物校验 CLI（CI 第二步）。
 *
 *   tsx scripts/validate-index.ts [--dir=<market 产物目录>] [--base-url=<...>]
 *
 * 与 build-index 的区别：build 会**重新生成**再校验；validate 只校验**已存在的产物**，
 * 因此能发现「catalog 改了但产物没重建」这类漂移，以及手工改坏产物的情况。
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MarketIndexError, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

import {
  MARKET_INDEX_BASE_URL,
  assertArtifactsExist,
  buildMarketIndex,
  collectCatalogProblems,
  collectIconProblems,
  collectIndexProblems,
  type MarketIndexDocument,
} from '@dda/core';
import { loadMatrix } from '@dda/core';
import { CatalogOverlaySchema } from '@dda/spec';
import type { Catalog } from '@dda/spec';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_DIR = join(REPO_ROOT, 'apps', 'desktop', 'resources', 'market');
const COMPAT_PATH = join(REPO_ROOT, 'apps', 'desktop', 'resources', 'manifests', 'compat.json');

function parseArgs(argv: readonly string[]): { dir: string; baseUrl: string } {
  let dir = DEFAULT_DIR;
  let baseUrl = MARKET_INDEX_BASE_URL;
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2) as [string, string | undefined];
    if (key === '--dir') {
      if (value === undefined) throw new Error('--dir 需要取值');
      dir = resolve(value);
    } else if (key === '--base-url') {
      if (value === undefined) throw new Error('--base-url 需要取值');
      baseUrl = value;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return { dir, baseUrl };
}

async function main(): Promise<number> {
  const { dir, baseUrl } = parseArgs(process.argv.slice(2));
  const problems: string[] = [];

  const { CATALOG } = (await import('../catalog/index')) as { CATALOG: Catalog };
  const matrix = loadMatrix(JSON.parse(await readFile(COMPAT_PATH, 'utf8')));

  problems.push(...collectCatalogProblems(CATALOG, matrix));
  problems.push(...(await collectIconProblems(dir, CATALOG)));

  const written = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as MarketIndexDocument;
  let parsed;
  try {
    parsed = parseMarketIndex(written, baseUrl);
  } catch (error) {
    if (error instanceof MarketIndexError) {
      console.error(`[validate-index] 官方校验器拒绝: ${error.path} ${error.reason}`);
      return 1;
    }
    throw error;
  }

  const expected = buildMarketIndex(CATALOG);
  if (JSON.stringify(expected) !== JSON.stringify(written)) {
    problems.push('index.json 与当前 catalog 不一致 → 产物过期，请重新运行 npm run build:index');
  }

  problems.push(...collectIndexProblems(CATALOG, written, parsed, baseUrl));
  problems.push(...(await assertArtifactsExist(dir, written)));

  const overlayRaw = JSON.parse(await readFile(join(dir, 'catalog.overlay.json'), 'utf8')) as unknown;
  const overlay = CatalogOverlaySchema.safeParse(overlayRaw);
  if (!overlay.success) {
    problems.push(`catalog.overlay.json 校验失败: ${overlay.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }

  console.log(
    `[validate-index] ${dir}: ${parsed.plugins.length} 个插件 / ` +
      `${parsed.plugins.reduce((sum, plugin) => sum + plugin.versions.length, 0)} 个版本`,
  );

  if (problems.length > 0) {
    console.error('\n[validate-index] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log('[validate-index] OK');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[validate-index] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
