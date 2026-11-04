/**
 * P-5 / A9 的可重放 E2E：在**隔离** DSH_HOME 里用产品编排装一次官方 QQ 插件。
 *
 *   tsx scripts/install-e2e.ts                       # 镜像源（L2），直连（剔除代理变量）
 *   tsx scripts/install-e2e.ts --source=official     # 官方源（L3）
 *   tsx scripts/install-e2e.ts --source=both         # 依次各跑一遍，各自全新 DSH_HOME
 *   tsx scripts/install-e2e.ts --use-proxy           # 保留系统代理变量（默认剔除，模拟直连）
 *   tsx scripts/install-e2e.ts --keep                # 保留临时目录以便排查
 *
 * 走的是**产品代码**：`installCatalogPlugin()` 的 9 步编排（第 1 步 compat 门禁、
 * 第 3 步 spec、第 6 步 plugin list 复核、第 7 步 dump-config 加载复核），
 * 而不是脚本自己拼一条 `dsh plugin add`。
 *
 * 本脚本**不关闭系统 VPN**，也无法判断是否在 VPN 上。它的作用是让"无 VPN 安装成功"
 * 这件事可重复：剔除代理变量后直接访问所选源，并把每一步、每次尝试、实际拿到的源与耗时
 * 打到 stdout，供归档到 `docs/evidence/`。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appPaths, createDshCli, findDeadProxySettings, describeProxyReport } from '@dda/adapters';
import { installCatalogPlugin, loadMatrix, registryPlan, type PluginInstallOutcome } from '@dda/core';
import { BASELINE } from '@dda/spec';

import { OFFICIAL_QQBOT_ENTRY } from '../catalog/entries/official-qqbot';

const PROFILE = BASELINE.dsh.profile;
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

type SourceName = 'mirror' | 'official';

interface Options {
  sources: SourceName[];
  keep: boolean;
  useProxy: boolean;
  dshBin?: string;
  repeatInstall: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let sources: SourceName[] = ['mirror'];
  let keep = false;
  let useProxy = false;
  let dshBin: string | undefined;
  let repeatInstall = false;
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2) as [string, string | undefined];
    if (key === '--keep') keep = true;
    else if (key === '--use-proxy') useProxy = true;
    else if (key === '--repeat-install') repeatInstall = true;
    else if (key === '--source' && value === 'both') sources = ['mirror', 'official'];
    else if (key === '--source' && (value === 'mirror' || value === 'official')) sources = [value];
    else if (key === '--dsh-bin' && value !== undefined) dshBin = value;
    else throw new Error(`未知参数：${arg}`);
  }
  return { sources, keep, useProxy, repeatInstall, ...(dshBin === undefined ? {} : { dshBin }) };
}

function defaultDshBin(): string {
  return join(
    process.env.LOCALAPPDATA ?? '',
    'DeepSeekDeployAssistant',
    'harness',
    BASELINE.dsh.version,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
}

/** 生产用的是产品自己写的 pnpm shim（`runtimes/pnpm` + `bin/pnpm.cmd`）；退化为系统 pnpm。 */
function pnpmBinDir(): string {
  const productBin = join(process.env.LOCALAPPDATA ?? '', 'DeepSeekDeployAssistant', 'bin');
  if (existsSync(join(productBin, 'pnpm.cmd'))) return productBin;
  try {
    const found = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'where pnpm.cmd'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== '');
    if (found !== undefined) return dirname(found);
  } catch {
    // 交给后面的 access 检查给出可读失败
  }
  return productBin;
}

function log(line: string): void {
  console.log(`[install-e2e] ${line}`);
}

/**
 * 直连可达性 + 真实字节：用 Node 的 `fetch` **刻意绕过**代理（undici 默认不读
 * `HTTP(S)_PROXY`），因此这条证据回答的是"不挂 VPN/代理能不能拿到东西"，
 * 而不是"pnpm 缓存里有没有"。
 */
async function probeDirect(layer: { url: string; label: string }): Promise<{ ok: boolean; detail: string }> {
  const base = layer.url.replace(/\/+$/u, '');
  const packumentUrl = `${base}/@tencent-connect%2Fdsh-qqbot`;
  const meta = await fetch(packumentUrl, { headers: { accept: 'application/json' } });
  if (!meta.ok) return { ok: false, detail: `元数据 HTTP ${meta.status}` };
  const json = (await meta.json()) as {
    versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
  };
  const dist = json.versions?.[OFFICIAL_QQBOT_ENTRY.version]?.dist;
  if (dist?.tarball === undefined) {
    return { ok: false, detail: `${layer.label} 上没有 ${OFFICIAL_QQBOT_ENTRY.version} 版本` };
  }
  const startedAt = Date.now();
  const tarball = await fetch(dist.tarball);
  if (!tarball.ok) return { ok: false, detail: `tarball HTTP ${tarball.status}` };
  const bytes = Buffer.from(await tarball.arrayBuffer());
  const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const kib = bytes.length / 1024;
  const speed = kib / seconds;

  let integrity = '未提供';
  if (dist.integrity?.startsWith('sha512-') === true) {
    const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    integrity = actual === dist.integrity ? '匹配' : '不匹配';
  }
  return {
    ok: integrity !== '不匹配',
    detail:
      `${layer.label} 直连 OK：元数据 HTTP 200，tarball ${kib.toFixed(1)} KiB in ${seconds.toFixed(2)} s` +
      `（${speed.toFixed(0)} KiB/s），integrity=${integrity}`,
  };
}

/** pnpm 的 store 目录（`npm_config_store_dir` 对 pnpm 无效，只能问它自己）。 */
function pnpmStorePath(): string | undefined {
  try {
    const out = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm store path'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? undefined : out.split(/\r?\n/u).pop();
  } catch {
    return undefined;
  }
}

/** store 里的文件数与总字节：安装前后各取一次，用增量判断"是否真的下载了字节"。 */
async function storeFootprint(dir: string | undefined): Promise<{ files: number; bytes: number }> {
  if (dir === undefined) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      files += 1;
      try {
        bytes += (await stat(child)).size;
      } catch {
        // 统计用途，读不到就跳过
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function readProfileDependency(profileDir: string, name: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(profileDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const declared = pkg.dependencies?.[name];
    return declared === undefined ? undefined : declared.replace(/^[^\d]*/u, '');
  } catch {
    return undefined;
  }
}

interface RunResult {
  source: SourceName;
  ok: boolean;
  detail: string;
}

function summarize(outcome: PluginInstallOutcome): string {
  const steps = outcome.steps
    .map((step) => `${step.index}:${step.id}=${step.status}${step.attempts > 1 ? `x${step.attempts}` : ''}`)
    .join(' ');
  return (
    `action=${outcome.action} source=${outcome.installSource} registry=${outcome.registry?.label ?? '(未使用)'} ` +
    `tarball=${outcome.tarballHosts.total === 0 ? '未取得' : outcome.tarballHosts.hosts.map((h) => `${h.host}(${h.count})`).join(',')} ` +
    `connectivity=${outcome.connectivity} | ${steps}`
  );
}

async function runSource(source: SourceName, options: Options, bin: string, matrix: ReturnType<typeof loadMatrix>): Promise<RunResult> {
  const layer = source === 'mirror' ? registryPlan('mirror-first')[0]! : registryPlan('official-first')[0]!;
  const localAppData = await mkdtemp(join(tmpdir(), `dda-install-e2e-${source}-`));
  const paths = appPaths(localAppData);
  const profileDir = join(paths.dshHome, 'profiles', PROFILE);
  const storeDir = join(paths.root, 'cache', 'pnpm-store');

  const proxy = await findDeadProxySettings(process.env, { timeoutMs: 1500 });
  const proxyExclusions = [
    ...proxy.dead.map((setting) => setting.name),
    ...(options.useProxy ? [] : PROXY_NAMES),
  ];

  console.log('');
  log(`=== 源：${layer.label}（${layer.url}）===`);
  log(`隔离 DSH_HOME：${paths.dshHome}`);
  log(`代理：${describeProxyReport(proxy)}；本脚本${options.useProxy ? '保留' : '剔除'}代理变量 → 实际子进程环境为${options.useProxy ? '系统代理' : '直连'}`);
  log(`dsh 入口：${bin}`);
  log(`pnpm 目录：${pnpmBinDir()}`);

  try {
    await mkdir(paths.root, { recursive: true });
    await access(paths.root, fsConstants.W_OK);
    await mkdir(storeDir, { recursive: true });

    const cli = createDshCli({
      paths,
      pnpmBinDir: pnpmBinDir(),
      registry: layer.url,
      nodeExePath: process.execPath,
      binPath: bin,
      proxyExclusions,
    });

    const startedAt = Date.now();
    log(`0) 直连可达性探测（fetch，不经代理）`);
    const direct = await probeDirect(layer);
    log(`   ${direct.detail}`);
    if (!direct.ok) return { source, ok: false, detail: direct.detail };

    const store = pnpmStorePath();
    const before = await storeFootprint(store);
    log(`   pnpm store：${store ?? '(未取到)'}；安装前 ${before.files} 个文件 / ${(before.bytes / 1024 / 1024).toFixed(1)} MiB`);

    log(`1) 物化 profile（dsh plugin list）`);
    await cli.ensureProfile(PROFILE);
    const installed = await cli.listPlugins(PROFILE);
    const installedVersion = installed.find((plugin) => plugin.name === OFFICIAL_QQBOT_ENTRY.name)?.version;
    log(`   已安装：${installed.map((plugin) => `${plugin.name}@${plugin.version ?? '?'}`).join('、') || '(空)'}`);

    log(`2) 产品编排 installCatalogPlugin（9 步，单源 ${layer.id}，不换源）`);
    const outcome = await installCatalogPlugin(
      {
        entry: OFFICIAL_QQBOT_ENTRY,
        matrix,
        dshVersion: BASELINE.dsh.version,
        nodeVersion: BASELINE.node.version,
        ...(installedVersion === undefined ? {} : { installedVersion }),
        allowDowngrade: false,
      },
      {
        precheck: async () => {
          await access(paths.root, fsConstants.W_OK);
        },
        addPlugin: async (chosen) => {
          const result = await cli.addPlugin(PROFILE, `${OFFICIAL_QQBOT_ENTRY.name}@${OFFICIAL_QQBOT_ENTRY.version}`, {
            registry: chosen.url,
          });
          return result.stdout;
        },
        listPlugins: () => cli.listPlugins(PROFILE),
        readProfileDependency: () => readProfileDependency(profileDir, OFFICIAL_QQBOT_ENTRY.name),
        // 第 7 步：真跑 `--dump-config`，用产品代码判断插件是否真的被加载。
        dumpConfig: () => cli.dumpConfig(PROFILE),
        // 第 8/9 步（配置自检 / 连通）本脚本不提供证据源：按产品规则记 unverified，不伪造成功。
        log,
        plan: [layer],
        attempts: 1,
      },
    );
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`3) 结果（${elapsed} s）：${summarize(outcome)}`);

    const after = await storeFootprint(store);
    const added = after.files - before.files;
    log(
      `   pnpm store 增量：${added} 个文件 / ${((after.bytes - before.bytes) / 1024 / 1024).toFixed(1)} MiB` +
        (added === 0 ? '（本次为缓存命中，字节下载证据以上面第 0 步为准）' : '（本次确实写入了新的 tarball）'),
    );

    let detail =
      `action=${outcome.action} registry=${outcome.registry?.id ?? '-'} 用时 ${elapsed}s store+${added}`;
    let ok = outcome.action === 'install' && outcome.connectivity === 'unverified';
    const failedSteps = outcome.steps.filter((step) => step.status === 'failed');
    if (failedSteps.length > 0) {
      ok = false;
      detail += `；失败步骤：${failedSteps.map((step) => step.id).join(',')}`;
    }

    if (options.repeatInstall) {
      log('4) 同版本再装一次，验证"同版本不重复装"（不应发起任何 pnpm 调用）');
      const again = await installCatalogPlugin(
        {
          entry: OFFICIAL_QQBOT_ENTRY,
          matrix,
          dshVersion: BASELINE.dsh.version,
          nodeVersion: BASELINE.node.version,
          installedVersion: OFFICIAL_QQBOT_ENTRY.version,
        },
        {
          precheck: async () => {
            throw new Error('同版本路径不应调用 precheck');
          },
          addPlugin: async () => {
            throw new Error('同版本路径不应调用 addPlugin');
          },
          listPlugins: () => cli.listPlugins(PROFILE),
          log,
          plan: [layer],
        },
      );
      log(`   action=${again.action}，steps=${again.steps.length}（应为 none / 0）`);
      ok = ok && again.action === 'none' && again.steps.length === 0;
      detail += `；重复安装 action=${again.action}`;
    }

    log(ok ? `=== ${layer.label}：PASS ===` : `=== ${layer.label}：FAIL ===`);
    return { source, ok, detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`=== ${layer.label}：FAIL（${message}）===`);
    return { source, ok: false, detail: message };
  } finally {
    if (options.keep) log(`已保留临时目录：${localAppData}`);
    else await rm(localAppData, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const bin = options.dshBin ?? defaultDshBin();
  if (!existsSync(bin)) {
    console.error(`[install-e2e] 找不到 dsh 入口：${bin}（用 --dsh-bin= 指定，或先完成一次部署）`);
    return 1;
  }
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const matrixPath = join(repoRoot, 'apps', 'desktop', 'resources', 'manifests', 'compat.json');
  const matrix = loadMatrix(JSON.parse(await readFile(matrixPath, 'utf8')));

  log(`基线：dsh ${BASELINE.dsh.version} / qqbot ${OFFICIAL_QQBOT_ENTRY.version} / node ${BASELINE.node.version}`);
  log(`说明：本脚本不关闭系统 VPN；"无 VPN"的可重复性来自剔除代理变量后直连所选源。`);

  const results: RunResult[] = [];
  for (const source of options.sources) results.push(await runSource(source, options, bin, matrix));

  console.log('');
  log('=== 汇总 ===');
  for (const result of results) log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.source}  ${result.detail}`);
  const ok = results.every((result) => result.ok);
  log(ok ? '全部来源通过' : '存在失败来源');
  return ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[install-e2e] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
