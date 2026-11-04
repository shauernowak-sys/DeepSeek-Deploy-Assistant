/**
 * D08 回滚验收的可重放证据脚本（需要网络；不进 CI）。
 *
 *   tsx scripts/d08-restore-e2e.ts            # 用临时 DSH_HOME，跑完清理
 *   tsx scripts/d08-restore-e2e.ts --keep     # 保留临时目录
 *
 * 流程：安装 → 记录 list → 备份（产品代码）→ 卸载 → 恢复（产品代码）→ 按还原后的 lockfile 重建 →
 * 再次 list，与备份前逐行比较。用来证明"回滚后 listPlugins 与备份前一致"。
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProfileBackup, restoreProfileBackup } from '@dda/core';

const SPEC = '@tencent-connect/dsh-qqbot@0.5.5';
const REGISTRY = 'https://registry.npmmirror.com/';
const DEFAULT_DSH_BIN = join(
  process.env.LOCALAPPDATA ?? '',
  'DeepSeekDeployAssistant',
  'harness',
  '0.2.0-rc.2',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
);

function dshBin(): string {
  const override = process.argv.find((arg) => arg.startsWith('--dsh-bin='))?.slice('--dsh-bin='.length);
  const bin = override ?? DEFAULT_DSH_BIN;
  if (!existsSync(bin)) throw new Error(`找不到 dsh 入口：${bin}（用 --dsh-bin= 指定）`);
  return bin;
}

function runDsh(bin: string, home: string, args: string[]): string {
  return execFileSync(process.execPath, [bin, ...args], {
    env: { ...process.env, DSH_HOME: home, npm_config_registry: REGISTRY },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
}

function pnpmInstallOffline(profileDir: string): string {
  const command = 'pnpm install --offline --frozen-lockfile --force';
  return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: profileDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
}

/** 只比较插件依赖行，忽略表头与 profile 路径。 */
function pluginLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[└├]── @?[\w./@-]+@[\d.]+/u.test(line))
    .sort();
}

async function main(): Promise<number> {
  const keep = process.argv.includes('--keep');
  const bin = dshBin();
  const home = await mkdtemp(join(tmpdir(), 'dda-d08-e2e-'));
  const profileDir = join(home, 'profiles', 'web');
  const backupsRoot = join(home, 'state', 'backups');

  let ok = false;
  try {
    console.log('[d08] 1) 安装');
    runDsh(bin, home, ['plugin', '--profile', 'web', 'add', SPEC]);
    const before = pluginLines(runDsh(bin, home, ['plugin', '--profile', 'web', 'list']));
    console.log(`[d08]    备份前 list: ${before.join(' | ') || '(空)'}`);

    console.log('[d08] 2) 备份（产品代码 createProfileBackup）');
    const backup = await createProfileBackup({ profileDir, backupsRoot });
    console.log(`[d08]    备份目录: ${backup.dir}`);
    console.log(`[d08]    文件: ${backup.files.join(', ')}；缺失: ${backup.missing.join(', ') || '(无)'}`);

    console.log('[d08] 3) 卸载');
    runDsh(bin, home, ['plugin', '--profile', 'web', 'remove', '@tencent-connect/dsh-qqbot']);
    const removed = pluginLines(runDsh(bin, home, ['plugin', '--profile', 'web', 'list']));
    console.log(`[d08]    卸载后 list: ${removed.join(' | ') || '(空)'}`);

    console.log('[d08] 4) 恢复（产品代码 restoreProfileBackup）');
    const restored = await restoreProfileBackup(backup.dir, profileDir);
    console.log(`[d08]    已还原: ${restored.restored.join(', ')}`);
    console.log(`[d08]    重建参数: ${restored.rebuildArgs.join(' ')}`);

    console.log('[d08] 5) 按还原后的 lockfile 重建依赖');
    pnpmInstallOffline(profileDir);

    console.log('[d08] 6) 再次 list 并比较');
    const after = pluginLines(runDsh(bin, home, ['plugin', '--profile', 'web', 'list']));
    console.log(`[d08]    恢复后 list: ${after.join(' | ') || '(空)'}`);

    ok = JSON.stringify(before) === JSON.stringify(after) && before.length > 0;
    console.log(`[d08] 结果: ${ok ? 'PASS（与备份前一致）' : 'FAIL（与备份前不一致）'}`);
  } finally {
    if (keep) console.log(`[d08] 已保留临时目录：${home}`);
    else await rm(home, { recursive: true, force: true });
  }

  return ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[d08] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
