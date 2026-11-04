/**
 * D11 许可门禁 CLI。
 *
 *   tsx scripts/license-gate.ts --scope=product
 *   tsx scripts/license-gate.ts --scope=plugin:plg-official-qqbot --profile-dir=<profile>
 *   tsx scripts/license-gate.ts --scope=all --profile-dir=<profile> --json=out.json --notices=NOTICES.md
 *
 * 判定含义见 packages/core/src/market/license-gate.ts：
 * - `product`：本产品自己的生产闭包（CI 使用，必须 allowed）；
 * - `plugin:<catalog id>`：catalog 条目的**真实**安装闭包（用于决定能否离线打包）；
 * - `all`：两者都跑（未给 --profile-dir 时只跑 product）。
 *
 * 退出码：0 = 全部 allowed；1 = 存在 denied / needs-review（即不可由我方分发）。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateClosure,
  formatClosureReport,
  parsePnpmListJson,
  renderThirdPartyNotices,
  resolveClosureLicenses,
  type ClosureReport,
} from '@dda/core';

import { CATALOG } from '../catalog/index';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface Options {
  scope: string;
  profileDir?: string;
  jsonPath?: string;
  noticesPath?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { scope: 'product' };
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2) as [string, string | undefined];
    switch (key) {
      case '--scope':
        if (value === undefined) throw new Error('--scope 需要取值：product | plugin:<id> | all');
        options.scope = value;
        break;
      case '--profile-dir':
        if (value === undefined) throw new Error('--profile-dir 需要取值');
        options.profileDir = resolve(value);
        break;
      case '--json':
        options.jsonPath = resolve(value ?? 'license-report.json');
        break;
      case '--notices':
        options.noticesPath = resolve(value ?? 'THIRD_PARTY_NOTICES.md');
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

/** 包名只允许 npm 语法，避免把未校验字符串拼进 shell 命令。 */
function assertSafePackageName(name: string): void {
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) {
    throw new Error(`包名不符合 npm 语法，拒绝执行: ${name}`);
  }
}

function runPnpmList(cwd: string): string {
  // `.cmd` shim 在 Windows 上不能直接 spawn；命令串固定且已校验包名，构建脚本可接受。
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

async function productReport(): Promise<ClosureReport> {
  const packages = parsePnpmListJson(runPnpmList(REPO_ROOT));
  const withLicenses = await resolveClosureLicenses(packages);
  return evaluateClosure('product（本产品生产闭包）', withLicenses);
}

async function pluginReport(entryId: string, profileDir: string): Promise<ClosureReport> {
  const entry = CATALOG.entries.find((candidate) => candidate.id === entryId);
  if (entry === undefined) {
    throw new Error(`catalog 中不存在条目 ${entryId}；可选：${CATALOG.entries.map((e) => e.id).join(', ')}`);
  }
  assertSafePackageName(entry.name);

  // 真实安装版本必须与 catalog 宣称的一致，否则这份闭包结论不能用来给该条目背书。
  const profileManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const installed = profileManifest.dependencies?.[entry.name];
  if (installed !== entry.version) {
    throw new Error(
      `profile 中 ${entry.name} 的版本是 ${installed ?? '(未安装)'}，与 catalog ${entry.version} 不一致；` +
        '请先按该版本安装再跑门禁',
    );
  }

  const packages = parsePnpmListJson(runPnpmList(profileDir));
  const withLicenses = await resolveClosureLicenses(packages);
  return evaluateClosure(`${entry.id}（${entry.name}@${entry.version} 插件闭包）`, withLicenses);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const reports: ClosureReport[] = [];

  if (options.scope === 'product' || options.scope === 'all') {
    reports.push(await productReport());
  }
  if (options.scope.startsWith('plugin:')) {
    const entryId = options.scope.slice('plugin:'.length);
    if (options.profileDir === undefined) throw new Error('插件门禁需要 --profile-dir=<已安装该插件的 profile 目录>');
    reports.push(await pluginReport(entryId, options.profileDir));
  } else if (options.scope === 'all') {
    if (options.profileDir !== undefined) {
      for (const entry of CATALOG.entries) reports.push(await pluginReport(entry.id, options.profileDir));
    } else {
      console.log('[license-gate] 未提供 --profile-dir，all 只覆盖 product 闭包');
    }
  } else if (options.scope !== 'product') {
    throw new Error(`未知 scope: ${options.scope}`);
  }

  let blocked = false;
  for (const report of reports) {
    console.log(formatClosureReport(report));
    if (report.verdict !== 'allowed') blocked = true;
  }

  if (options.jsonPath !== undefined) {
    await mkdir(dirname(options.jsonPath), { recursive: true });
    await writeFile(options.jsonPath, `${JSON.stringify(reports, null, 2)}\n`, 'utf8');
    console.log(`[license-gate] 报告已写入 ${options.jsonPath}`);
  }
  if (options.noticesPath !== undefined) {
    await mkdir(dirname(options.noticesPath), { recursive: true });
    const body = reports.map((report) => renderThirdPartyNotices(report, new Date().toISOString())).join('\n\n');
    await writeFile(options.noticesPath, `${body}\n`, 'utf8');
    console.log(`[license-gate] NOTICE 片段已写入 ${options.noticesPath}`);
  }

  if (blocked) {
    console.error('\n[license-gate] BLOCKED：存在不可分发的依赖。');
    console.error('处置：改为在线安装（本软件不复制其字节）；确需分发时先取得授权，并把许可结论写回 catalog。');
    return 1;
  }
  console.log('\n[license-gate] OK');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[license-gate] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
