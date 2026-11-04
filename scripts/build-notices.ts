/**
 * 生成随包分发的 `THIRD_PARTY_NOTICES.md`（D05 / SEC-LIC）。
 *
 *   tsx scripts/build-notices.ts            # 写入仓库根目录
 *   tsx scripts/build-notices.ts --check    # 只比对；不一致 exit 1（CI 用）
 *   tsx scripts/build-notices.ts --out=<path>
 *
 * 内容取自真实数据：本产品生产闭包（`pnpm list --prod`）+ catalog 每个条目的闭包快照。
 * 不写时间戳，保证 CI 可 diff。
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateClosure,
  parsePnpmListJson,
  renderNoticesDocument,
  resolveClosureLicenses,
  summarizeNotices,
} from '@dda/core';
import type { Catalog } from '@dda/spec';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_OUT = join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');

function parseArgs(argv: readonly string[]): { check: boolean; out: string } {
  let check = false;
  let out = DEFAULT_OUT;
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2) as [string, string | undefined];
    if (key === '--check') check = true;
    else if (key === '--out' && value !== undefined) out = resolve(value);
    else throw new Error(`未知参数: ${arg}`);
  }
  return { check, out };
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

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const { CATALOG } = (await import('../catalog/index')) as { CATALOG: Catalog };

  const productPackages = await resolveClosureLicenses(parsePnpmListJson(pnpmList(REPO_ROOT)));
  const product = evaluateClosure('product（本产品生产闭包）', productPackages);

  const plugins = CATALOG.entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    version: entry.version,
    report: evaluateClosure(`${entry.name}@${entry.version}`, entry.depsClosure),
  }));

  const document = renderNoticesDocument({
    product,
    plugins,
    generatedBy: 'scripts/build-notices.ts（package.json 版本 + pnpm 生产闭包）',
  });

  console.log(summarizeNotices({ product, plugins, generatedBy: 'scripts/build-notices.ts' }));

  if (options.check) {
    let current = '';
    try {
      current = await readFile(options.out, 'utf8');
    } catch {
      console.error(`\n[notices] 缺少 ${options.out}；请运行 npm run notices:build`);
      return 1;
    }
    if (current.replace(/\r\n/gu, '\n') !== document) {
      console.error(`\n[notices] ${options.out} 与当前依赖不一致；请运行 npm run notices:build 后提交`);
      return 1;
    }
    console.log('\n[notices] OK（与当前依赖一致）');
    return 0;
  }

  await writeFile(options.out, document, 'utf8');
  console.log(`\n[notices] 已写入 ${options.out}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[notices] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
