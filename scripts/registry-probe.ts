/**
 * D06 干净缓存复测工具（不是 CI 步骤，需要网络）。
 *
 *   tsx scripts/registry-probe.ts                      # 用镜像源，全新 store + 全新 cache
 *   tsx scripts/registry-probe.ts --source=official    # 用官方源对照
 *   tsx scripts/registry-probe.ts --keep               # 保留临时目录以便检查
 *
 * 回答两个问题：
 * 1. 全新缓存下安装锁定版本需要多久；
 * 2. 这次安装到底问了哪些 registry（pnpm 的 metadata 缓存按源分目录）。
 *
 * 只做观测，不写任何产品配置，也不改动本机已存在的 pnpm 缓存。
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REGISTRY_NPMMIRROR,
  REGISTRY_OFFICIAL,
  extractTarballHosts,
  formatTarballHosts,
  listMetadataRegistrySources,
} from '@dda/core';

const DEFAULT_PACKAGE = '@tencent-connect/dsh-qqbot@0.5.5';
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@[0-9][0-9A-Za-z.+-]*$/;

interface Options {
  pkg: string;
  source: 'mirror' | 'official';
  keep: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { pkg: DEFAULT_PACKAGE, source: 'mirror', keep: false };
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2) as [string, string | undefined];
    if (key === '--package' && value !== undefined) options.pkg = value;
    else if (key === '--source' && (value === 'mirror' || value === 'official')) options.source = value;
    else if (key === '--keep') options.keep = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!NAME_PATTERN.test(options.pkg)) throw new Error(`只接受精确 name@version，收到: ${options.pkg}`);
  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const registry = options.source === 'official' ? REGISTRY_OFFICIAL : REGISTRY_NPMMIRROR;
  const dir = await mkdtemp(join(tmpdir(), 'dda-registry-probe-'));
  const store = join(dir, 'store');
  const cache = join(dir, 'cache');

  const command =
    `pnpm add ${options.pkg} ` +
    `--registry=${registry} ` +
    '--store-dir store --cache-dir cache ' +
    '--ignore-scripts --reporter=append-only';

  console.log(`[probe] 源: ${registry}`);
  console.log(`[probe] 临时目录: ${dir}（全新 store + 全新 cache）`);

  const startedAt = Date.now();
  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20 * 60_000,
    });
  } catch (error) {
    exitCode = 1;
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message ?? ''}`;
  }
  const durationMs = Date.now() - startedAt;

  const metadata = await listMetadataRegistrySources(cache);
  const hosts = extractTarballHosts(output);

  if (exitCode !== 0) {
    console.log('[probe] 失败输出（末尾 15 行）：');
    for (const line of output.trim().split(/\r?\n/u).slice(-15)) console.log(`  ${line}`);
  }
  console.log(`[probe] 结果: ${exitCode === 0 ? '成功' : '失败'}，耗时 ${(durationMs / 1000).toFixed(1)} s`);
  console.log(`[probe] 本次询问的 registry（metadata 缓存）: ${metadata.registries.join(', ') || '未观察到'}`);
  console.log(`[probe] ${formatTarballHosts(hosts)}`);
  if (metadata.registries.length > 1) {
    console.log('[probe] 注意：即使只配置了一个源，也存在跨源元数据；这与前置验证 §4.3 的观察一致。');
  }

  if (!options.keep) await rm(dir, { recursive: true, force: true });
  else console.log(`[probe] 已保留临时目录：${dir}`);

  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[probe] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
