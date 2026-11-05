/**
 * D09 完整策展 · 候选审计（D11 闭包 + 真实安装探测）
 *
 *   npm run audit:candidates                    # 审计 catalog/candidates 里的全部候选
 *   npm run audit:candidates -- --only=dsh-pet  # 只审一个
 *   npm run audit:candidates -- --out=report.json
 *
 * 做两件事，都要求"真实执行、不猜"：
 *   1. **D11 闭包审计**：在隔离目录真实安装，用 pnpm 自己的生产闭包解析许可，再交给 `evaluateClosure()` 判三态；
 *   2. **安装探测**：记录 `pnpm add` 的退出码、耗时、安装后的版本、以及包里是否真的带 `dsh.bundle.patch`。
 *
 * 安全边界：
 *   - 全部在 `%TEMP%\dda-candidate-audit\` 下，用独立 pnpm store，不碰真实 profile 与全局环境；
 *   - 一律 `--ignore-scripts`：不执行任何第三方安装脚本（`prepare`/`postinstall` 等）；
 *   - 只读 registry，不写仓库（除非显式 `--out` 指向仓库）。
 *
 * 退出码：0 = 全部审计完成（不论结论）；1 = 审计过程本身失败。
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { evaluateClosure } from '@dda/core';
import type { CatalogCandidate, DepsClosureEntry } from '@dda/spec';

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_WORK = join(tmpdir(), 'dda-candidate-audit');
const STORE_DIR = join(DEFAULT_WORK, 'pnpm-store');

interface Options {
  only: Set<string>;
  out?: string;
  /** 顺便把审计结果写成 `catalog/data/candidate-audits.ts`（可复现，不依赖外部生成器）。 */
  emitTs?: string;
  work: string;
  keep: boolean;
  /** 锁定版 dsh 的 bin.js；给定即额外做 D03 侧的真实 `dsh plugin add` 探测。 */
  dshBin?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { only: new Set(), work: DEFAULT_WORK, keep: false };
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2) as [string, string | undefined];
    if (key === '--only') {
      if (value === undefined) throw new Error('--only 需要取值');
      options.only.add(value);
    } else if (key === '--out') {
      if (value === undefined) throw new Error('--out 需要取值');
      options.out = resolve(value);
    } else if (key === '--emit-ts') {
      if (value === undefined) throw new Error('--emit-ts 需要取值');
      options.emitTs = resolve(value);
    } else if (key === '--work') {
      if (value === undefined) throw new Error('--work 需要取值');
      options.work = resolve(value);
    } else if (key === '--keep') {
      options.keep = true;
    } else if (key === '--dsh-bin') {
      if (value === undefined) throw new Error('--dsh-bin 需要取值');
      options.dshBin = resolve(value);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (options.dshBin === undefined && process.env.DDA_AUDIT_DSH_BIN !== undefined) {
    options.dshBin = resolve(process.env.DDA_AUDIT_DSH_BIN);
  }
  return options;
}

function pnpmCmd(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function runPnpm(args: string[], cwd: string, timeoutMs: number) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(pnpmCmd(), args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_store_dir: STORE_DIR },
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    return { ok: true, code: 0, stdout, stderr, elapsedMs: Date.now() - started };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    return {
      ok: false,
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: (failure.stderr ?? '') + (failure.killed ? '\n[timeout]' : ''),
      elapsedMs: Date.now() - started,
    };
  }
}

/**
 * 从**已安装**的 node_modules 解析生产闭包。
 *
 * 不用 `pnpm licenses list`：它在自定义 store 下会报 `ERR_PNPM_MISSING_PACKAGE_INDEX_FILE`，
 * 而且我们需要的只是「实际装了哪些包、每个包自称什么许可」，直接从磁盘读比依赖 pnpm 内部索引更可靠。
 */
async function resolveClosure(dir: string): Promise<CatalogClosureFact[]> {
  const rootModules = join(dir, 'node_modules');
  const pnpmDir = join(rootModules, '.pnpm');
  const pnpmEntries = await readdir(pnpmDir).catch(() => [] as string[]);

  const readPkg = async (pkgDir: string): Promise<{ version?: string; license?: unknown; dependencies?: Record<string, string> } | undefined> => {
    try {
      return JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as {
        version?: string;
        license?: unknown;
        dependencies?: Record<string, string>;
      };
    } catch {
      return undefined;
    }
  };

  const locate = async (name: string) => {
    const direct = await readPkg(join(rootModules, ...name.split('/')));
    if (direct !== undefined) return direct;
    // 版本冲突时 pnpm 把包放进 `.pnpm/<name>@<ver>/node_modules/<name>`。
    const scoped = name.replace('/', '+');
    for (const entry of pnpmEntries) {
      if (!entry.startsWith(`${name}@`) && !entry.startsWith(`${scoped}@`)) continue;
      const nested = await readPkg(join(pnpmDir, entry, 'node_modules', ...name.split('/')));
      if (nested !== undefined) return nested;
    }
    return undefined;
  };

  const licenseOf = (value: unknown): string => {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (Array.isArray(value)) {
      const parts = value.map((item) => (typeof item === 'string' ? item : String(item))).filter((item) => item !== '');
      if (parts.length > 0) return parts.join(' OR ');
    }
    const typed = value as { type?: unknown } | undefined;
    if (typed !== undefined && typeof typed.type === 'string' && typed.type.trim() !== '') return typed.type.trim();
    return '(none)';
  };

  const root = await readPkg(dir);
  const seen = new Map<string, CatalogClosureFact>();
  const queue = Object.keys(root?.dependencies ?? {});
  let guard = 0;
  while (queue.length > 0 && guard < 5000) {
    guard += 1;
    const name = queue.shift() as string;
    const pkg = await locate(name);
    if (pkg === undefined || pkg.version === undefined) continue;
    const id = `${name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.set(id, { name, version: pkg.version, license: licenseOf(pkg.license) });
    for (const dependency of Object.keys(pkg.dependencies ?? {})) queue.push(dependency);
  }
  return [...seen.values()].sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
}

interface CatalogClosureFact {
  name: string;
  version: string;
  license: string;
}

async function readInstalledPackage(
  projectDir: string,
  name: string,
): Promise<{ version?: string; hasBundlePatch: boolean; patch: string } | undefined> {
  const pkgPath = join(projectDir, 'node_modules', ...name.split('/'), 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
      version?: string;
      dsh?: { bundle?: { patch?: string | string[] } };
    };
    // `dsh.bundle.patch` 可能是单个路径，也可能是路径数组（@8kugames/dsh-zed-acp 就是数组）。
    const patch = pkg.dsh?.bundle?.patch;
    const paths = Array.isArray(patch) ? patch : typeof patch === 'string' ? [patch] : [];
    return { version: pkg.version, hasBundlePatch: paths.length > 0, patch: paths.join(', ') };
  } catch {
    return undefined;
  }
}

interface AuditRow {
  id: string;
  name: string;
  version: string;
  requested: string;
  install: { ok: boolean; code: number; elapsedMs: number; errorTail?: string };
  installedVersion?: string;
  bundlePatchPresent: boolean;
  bundlePatchPaths?: string;
  closureCount: number;
  verdict: 'allowed' | 'needs-review' | 'denied';
  byLicense: Array<{ license: string; count: number }>;
  denied: DepsClosureEntry[];
  needsReview: DepsClosureEntry[];
  closure: DepsClosureEntry[];
  auditedAt: string;
  /** D03 侧：用锁定版 dsh 真实 `plugin add` 到隔离 profile 的结果。 */
  dshProbe?: {
    attempted: boolean;
    ok: boolean;
    code: number;
    profile: string;
    installElapsedMs: number;
    listed: boolean;
    errorTail?: string;
  };
}

/** 用锁定版 dsh 在**隔离 DSH_HOME** 里真实安装一次（D03 的第 5~6 步，不启动宿主）。 */
async function probeDshInstall(
  candidate: CatalogCandidate,
  options: { dshBin: string; work: string },
): Promise<NonNullable<AuditRow['dshProbe']>> {
  const profile = `audit-${candidate.id.replace(/^plg-/, '')}`;
  const home = join(options.work, 'dsh-home');
  await mkdir(home, { recursive: true });
  const env = {
    ...process.env,
    DSH_HOME: home,
    npm_config_store_dir: STORE_DIR,
    npm_config_registry: process.env.npm_config_registry ?? 'https://registry.npmjs.org/',
  };
  const started = Date.now();
  const spec = `${candidate.name}@${candidate.version}`;
  let ok = false;
  let code = 1;
  let errorTail = '';
  try {
    await execFileAsync(
      process.execPath,
      [options.dshBin, 'plugin', '--profile', profile, 'add', spec],
      { cwd: options.work, env, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    ok = true;
    code = 0;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    code = typeof failure.code === 'number' ? failure.code : 1;
    errorTail = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim().slice(-800);
  }
  const installElapsedMs = Date.now() - started;

  let listed = false;
  if (ok) {
    try {
      const listing = await execFileAsync(
        process.execPath,
        [options.dshBin, 'plugin', '--profile', profile, 'list'],
        { cwd: options.work, env, timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      );
      listed = listing.stdout.includes(`${candidate.name} ${candidate.version}`)
        || listing.stdout.includes(`${candidate.name}@${candidate.version}`);
    } catch {
      listed = false;
    }
  }

  return {
    attempted: true,
    ok,
    code,
    profile,
    installElapsedMs,
    listed,
    ...(errorTail === '' ? {} : { errorTail }),
  };
}

/**
 * 安装 + 审计一个候选。目录按候选 id 隔离，store 共用（同一版本只下载一次）。
 */
async function auditCandidate(candidate: CatalogCandidate, work: string): Promise<AuditRow> {
  const slug = candidate.name.replace(/[@/]/g, '_');
  const dir = join(work, slug);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'dda-candidate-audit', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    'utf8',
  );

  const requested = `${candidate.name}@${candidate.version}`;
  // --ignore-scripts：第三方安装脚本一律不执行（审计不需要它们跑起来）。
  const install = await runPnpm(
    ['add', requested, '--ignore-scripts', '--reporter=append-only', '--store-dir', STORE_DIR],
    dir,
    15 * 60_000,
  );

  const installed = await readInstalledPackage(dir, candidate.name);
  const auditedAt = new Date().toISOString();

  if (!install.ok) {
    return {
      id: candidate.id,
      name: candidate.name,
      version: candidate.version,
      requested,
      install: {
        ok: false,
        code: install.code,
        elapsedMs: install.elapsedMs,
        errorTail: (install.stderr || install.stdout).trim().slice(-800),
      },
      bundlePatchPresent: installed?.hasBundlePatch ?? false,
      ...(installed?.patch === undefined || installed.patch === '' ? {} : { bundlePatchPaths: installed.patch }),
      closureCount: 0,
      verdict: 'denied',
      byLicense: [],
      denied: [],
      needsReview: [],
      closure: [],
      auditedAt,
    };
  }

  const entries = await resolveClosure(dir);
  const report = evaluateClosure(requested, entries);
  return {
    id: candidate.id,
    name: candidate.name,
    version: candidate.version,
    requested,
    install: { ok: true, code: 0, elapsedMs: install.elapsedMs },
    ...(installed?.version === undefined ? {} : { installedVersion: installed.version }),
    bundlePatchPresent: installed?.hasBundlePatch ?? false,
    ...(installed?.patch === undefined || installed.patch === '' ? {} : { bundlePatchPaths: installed.patch }),
    closureCount: report.entries.length,
    verdict: report.verdict,
    byLicense: report.byLicense,
    denied: report.denied,
    needsReview: report.needsReview,
    closure: report.entries,
    auditedAt,
  };
}

/** 把审计结果渲染成 `catalog/data/candidate-audits.ts`（可复现产物，不依赖外部生成器）。 */
function renderAuditTs(rows: readonly AuditRow[]): string {
  const method =
    '隔离目录 + 真实 pnpm 安装（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包 + evaluateClosure 现算裁决';
  const esc = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const entry = (e: DepsClosureEntry) =>
    `        { name: '${esc(e.name)}', version: '${esc(e.version)}', license: '${esc(e.license)}', verdict: '${e.verdict}', redistributable: ${e.redistributable} },`;

  const out: string[] = [
    '/**',
    ' * D09 完整策展 · 候选审计证据（**自动生成，不要手改**）。',
    ' *',
    ' * 生成命令：',
    ' *   npm run audit:candidates -- --emit-ts=catalog/data/candidate-audits.ts',
    ' *   （需要 D03 侧证据时再给 --dsh-bin=<dsh>/lib/bin.js，或用 DDA_AUDIT_DSH_BIN）',
    ' *',
    ' * 数据来源：隔离目录真实 `pnpm add`（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包，',
    ' * 以及用锁定版 dsh 在隔离 DSH_HOME 真实 `dsh plugin add` / `plugin list`。',
    ' *',
    ' * 为什么生成而不是手写：闭包有 40+ 条、逐包带裁决，手抄一定会与审计报告对不上。',
    ' */',
    "import type { CatalogCandidateAudit } from '@dda/spec';",
    '',
    'export const CANDIDATE_AUDITS: Readonly<Record<string, CatalogCandidateAudit>> = {',
  ];

  for (const row of rows) {
    out.push(`  // ${row.name}@${row.version}`);
    out.push(`  '${row.id}': {`);
    out.push('    depsClosure: [');
    for (const e of row.closure) out.push(entry(e));
    out.push('    ],');
    out.push('    closureAudit: {');
    out.push(`      auditedAt: '${row.auditedAt}',`);
    out.push(`      method: '${esc(method)}',`);
    out.push(`      verdict: '${row.verdict}',`);
    out.push(`      packageCount: ${row.closureCount},`);
    out.push('      byLicense: [');
    for (const bucket of row.byLicense) {
      out.push(`        { license: '${esc(bucket.license)}', count: ${bucket.count} },`);
    }
    out.push('      ],');
    out.push('      denied: [');
    for (const e of row.denied) out.push(entry(e));
    out.push('      ],');
    out.push('      needsReview: [');
    for (const e of row.needsReview) out.push(entry(e));
    out.push('      ],');
    out.push('    },');
    if (row.dshProbe !== undefined) {
      out.push('    installProbe: {');
      out.push(`      hostDsh: '0.2.0-rc.2',`);
      out.push(`      probedAt: '${row.auditedAt}',`);
      out.push(`      installed: ${row.dshProbe.ok},`);
      out.push(`      listed: ${row.dshProbe.listed},`);
      out.push(`      elapsedMs: ${row.dshProbe.installElapsedMs},`);
      if (row.dshProbe.errorTail !== undefined) {
        const failure = row.dshProbe.errorTail.split('\n').filter(Boolean).slice(-4).join(' / ').slice(0, 600);
        out.push(`      failure: '${esc(failure)}',`);
      }
      out.push('    },');
    }
    out.push('  },');
  }

  out.push('};', '');
  return out.join('\n');
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const { CATALOG_CANDIDATES } = (await import('../catalog/index')) as {
    CATALOG_CANDIDATES: readonly CatalogCandidate[];
  };

  const targets = options.only.size === 0
    ? CATALOG_CANDIDATES
    : CATALOG_CANDIDATES.filter((candidate) => options.only.has(candidate.name));
  if (targets.length === 0) throw new Error('没有匹配的候选');

  await mkdir(options.work, { recursive: true });
  console.log(`[audit] 工作目录: ${options.work}`);
  console.log(`[audit] 候选 ${targets.length} 个（--ignore-scripts，独立 store）\n`);

  const rows: AuditRow[] = [];
  for (const candidate of targets) {
    process.stdout.write(`[audit] ${candidate.name}@${candidate.version} … `);
    const row = await auditCandidate(candidate, options.work);
    if (options.dshBin !== undefined) {
      row.dshProbe = await probeDshInstall(candidate, { dshBin: options.dshBin, work: options.work });
    }
    rows.push(row);
    const verdict = row.install.ok ? row.verdict : 'install-failed';
    const dshNote = row.dshProbe === undefined
      ? ''
      : `  dsh=${row.dshProbe.ok ? (row.dshProbe.listed ? 'install+list-ok' : 'install-ok/list-miss') : `fail(${row.dshProbe.code})`}`;
    console.log(
      `${verdict}  (${Math.round(row.install.elapsedMs / 1000)}s, 闭包 ${row.closureCount} 包, bundle=${row.bundlePatchPresent})${dshNote}`,
    );
  }

  console.log('\n=== 汇总 ===');
  for (const row of rows) {
    if (!row.install.ok) {
      console.log(`${row.name}@${row.version}: 安装失败 code=${row.install.code}`);
      console.log(`  ${row.install.errorTail?.split('\n').slice(-3).join('\n  ')}`);
      continue;
    }
    const denied = row.denied.map((entry) => `${entry.name}@${entry.version}(${entry.license})`);
    console.log(
      `${row.name}@${row.version}: ${row.verdict}  闭包 ${row.closureCount} 包  ` +
        `bundle=${row.bundlePatchPresent}  ${row.byLicense.map((b) => `${b.license}×${b.count}`).join(' ')}`,
    );
    if (denied.length > 0) console.log(`  不可分发: ${denied.join(', ')}`);
    if (row.needsReview.length > 0) {
      console.log(`  需复核: ${row.needsReview.map((e) => `${e.name}(${e.license})`).join(', ')}`);
    }
    if (row.dshProbe !== undefined) {
      const probe = row.dshProbe;
      console.log(
        `  dsh 探测: profile=${probe.profile} install=${probe.ok ? 'ok' : `fail(${probe.code})`} ` +
          `listed=${probe.listed} ${Math.round(probe.installElapsedMs / 1000)}s`,
      );
      if (probe.errorTail !== undefined) console.log(`    ${probe.errorTail.split('\n').slice(-3).join('\n    ')}`);
    }
  }

  if (options.out !== undefined) {
    await writeFile(options.out, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    console.log(`\n[audit] 报告已写入: ${options.out}`);
  }

  if (options.emitTs !== undefined) {
    await writeFile(options.emitTs, renderAuditTs(rows), 'utf8');
    console.log(`[audit] 审计数据已写入: ${options.emitTs}`);
  }

  if (!options.keep) {
    // 只删项目目录，保留 store（下一次审计复用，不重复下载）。
    for (const candidate of targets) {
      const slug = candidate.name.replace(/[@/]/g, '_');
      await rm(join(options.work, slug), { recursive: true, force: true });
    }
  } else {
    console.log(`[audit] --keep：保留项目目录于 ${options.work}`);
  }

  // 目录清空后确认没有残留（store 除外）
  const leftovers = (await readdir(options.work)).filter((entry) => entry !== 'pnpm-store');
  if (leftovers.length > 0) console.log(`[audit] 残余目录: ${leftovers.join(', ')}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[audit] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
