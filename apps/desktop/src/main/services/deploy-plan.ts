import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertCombination,
  downloadVerified,
  detectAdmin,
  freeBytes,
  MIN_FREE_BYTES,
} from '@dda/core';
import type { Step, StepContext } from '@dda/core';
import {
  createDshCli,
  detectHarnessRoute,
  detectManagedNode,
  dshBinJs,
  ensurePnpm,
  fileExists,
  installNodeRuntime,
  nodeExe,
  runCommandCapture,
  writePnpmShim,
  type AppPaths,
} from '@dda/adapters';
import { BASELINE, DdaError, ERROR_CODES } from '@dda/spec';
import type { CompatMatrix, RuntimeManifest } from '@dda/spec';

export const QQ_PLUGIN_SPEC = `@tencent-connect/dsh-qqbot@${BASELINE.qqbot.version}`;

export interface DeployPlanDeps {
  paths: AppPaths;
  manifest: RuntimeManifest;
  matrix: CompatMatrix;
  registry: string;
  log: (message: string) => void;
}

/**
 * Pure(ish) plan builder: no Electron imports, so the exact production steps can be
 * executed by an integration test against a throwaway data root.
 */
export function buildDeploySteps(deps: DeployPlanDeps): Step[] {
  const { paths, manifest, matrix, registry, log } = deps;
  const cli = createDshCli({ paths, pnpmBinDir: join(paths.root, 'bin'), registry });
  const getCli = () => cli;

  return [
    {
      id: 'check-disk',
      title: '检查磁盘空间与目录',
      weight: 1,
      async run(ctx: StepContext) {
        const free = await freeBytes('C:\\');
        ctx.log(`可用空间 ${(free / 1024 ** 3).toFixed(1)} GB`);
        if (free < MIN_FREE_BYTES) {
          throw new DdaError(
            ERROR_CODES.E_DISK_FULL,
            `磁盘可用空间不足: ${(free / 1024 ** 3).toFixed(1)} GB`,
            '至少预留 2 GB 后重试',
          );
        }
        await mkdir(paths.root, { recursive: true });
        await mkdir(paths.stateTasks, { recursive: true });
        await mkdir(paths.logs, { recursive: true });
        log(`安装目录: ${paths.root}；管理员: ${await detectAdmin()}`);
      },
    },
    {
      id: 'download-node',
      title: `下载 Node.js ${manifest.version}`,
      weight: 8,
      retries: 2,
      async precondition() {
        return (await detectManagedNode(paths)).installed;
      },
      async run(ctx: StepContext) {
        const dest = join(paths.downloads, `node-v${manifest.version}.zip`);
        ctx.created(paths.downloads);
        const result = await downloadVerified({
          destPath: dest,
          sources: [manifest.source.url, ...manifest.source.mirrors],
          sha256: manifest.source.sha256,
          expectedSize: manifest.source.size,
          signal: ctx.signal,
          onProgress: (p) => {
            ctx.progress(p.totalBytes ? p.receivedBytes / p.totalBytes : 0);
          },
        });
        log(
          `下载完成: ${result.source} (${(result.bytes / 1024 / 1024).toFixed(1)} MB, 续传起点 ${result.resumedFrom})`,
        );
      },
    },
    {
      id: 'extract-node',
      title: '解压 Node.js 运行时',
      weight: 5,
      async precondition() {
        return (await detectManagedNode(paths)).installed;
      },
      async run(ctx: StepContext) {
        ctx.created(paths.nodeDir);
        await installNodeRuntime({
          paths,
          manifest,
          zipPath: join(paths.downloads, `node-v${manifest.version}.zip`),
          log: (m) => ctx.log(m),
        });
      },
    },
    {
      id: 'verify-node',
      title: '校验 Node.js 可执行',
      weight: 2,
      async run(ctx: StepContext) {
        const info = await detectManagedNode(paths);
        if (!info.installed || !info.version) {
          throw new DdaError(ERROR_CODES.E_PROCESS_FAILED, 'Node 运行时不可用', '重试解压步骤');
        }
        ctx.log(`node -v => ${info.version}`);
        if (info.version !== manifest.version) {
          throw new DdaError(
            ERROR_CODES.E_VERSION_UNSUPPORTED,
            `Node 版本不符: ${info.version}，期望 ${manifest.version}`,
            '删除运行时目录后重试',
          );
        }
      },
    },
    {
      id: 'ensure-pnpm',
      title: `安装 pnpm ${BASELINE.pnpm.version}`,
      weight: 6,
      async run(ctx: StepContext) {
        ctx.created(paths.pnpmPrefix);
        const info = await ensurePnpm(paths, { registry, log: (m) => ctx.log(m) });
        ctx.log(`pnpm => ${info.version}`);
      },
    },
    {
      id: 'write-shim',
      title: '生成 pnpm 私有 shim',
      weight: 1,
      async run(ctx: StepContext) {
        const dir = await writePnpmShim(paths);
        ctx.created(dir);
        ctx.log(`shim: ${join(dir, 'pnpm.cmd')}（仅注入子进程 PATH）`);
      },
    },
    {
      id: 'install-dsh',
      title: `安装 Harness ${BASELINE.dsh.version}`,
      weight: 12,
      async precondition() {
        return fileExists(dshBinJs(paths));
      },
      async run(ctx: StepContext) {
        ctx.created(paths.harnessDir);
        await mkdir(paths.harnessDir, { recursive: true });
        const pnpmCli = join(paths.pnpmPrefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
        const result = await runCommandCapture({
          exePath: nodeExe(paths),
          args: [
            pnpmCli,
            'add',
            `@deepseek-ai/dsh@${BASELINE.dsh.version}`,
            '--dir',
            paths.harnessDir,
            '--registry',
            registry,
            '--store-dir',
            join(paths.root, 'cache', 'pnpm-store'),
            '--reporter',
            'append-only',
          ],
          timeoutMs: 30 * 60_000,
          tolerateStderr: /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/,
          onStdout: (chunk) => {
            const line = chunk.trim();
            if (line.startsWith('Progress: resolved')) ctx.log(line);
          },
        });
        if (ctx.isCancelled()) {
          // The child process is not killable mid-flight here; the engine records the cancel
          // at the step boundary and cleanup removes only what this task created.
          ctx.log('检测到取消请求：本步骤将在退出后停止，并清理本次创建的目录');
        }
        log(`pnpm add 退出码=${result.code}`);
      },
    },
    {
      id: 'verify-dsh',
      title: '校验 Harness 版本',
      weight: 2,
      async run(ctx: StepContext) {
        const info = await getCli().version();
        if (!info.installed || info.version !== BASELINE.dsh.version) {
          throw new DdaError(
            ERROR_CODES.E_VERSION_UNSUPPORTED,
            `dsh 版本不符: ${info.version ?? '未安装'}，期望 ${BASELINE.dsh.version}`,
            '重新安装 Harness',
          );
        }
        ctx.log(`dsh --version => ${info.version}`);
      },
    },
    {
      id: 'assert-combo',
      title: '校验版本组合白名单',
      weight: 1,
      async run(ctx: StepContext) {
        const entry = assertCombination(matrix, {
          dsh: BASELINE.dsh.version,
          qqbot: BASELINE.qqbot.version,
          node: BASELINE.node.version,
        });
        ctx.log(`组合 ${entry.id} 状态 ${entry.status}`);
        ctx.log(`证据: ${entry.evidence.join(', ')}`);
      },
    },
    {
      id: 'ensure-profile',
      title: `准备 ${BASELINE.dsh.profile} profile`,
      weight: 3,
      async run(ctx: StepContext) {
        ctx.created(join(paths.dshHome, 'profiles'));
        await getCli().ensureProfile(BASELINE.dsh.profile);
        ctx.log(`profile 目录: ${join(paths.dshHome, 'profiles', BASELINE.dsh.profile)}`);
      },
    },
    {
      id: 'install-qqbot',
      title: `安装 QQ 插件 ${BASELINE.qqbot.version}`,
      weight: 8,
      retries: 2,
      async precondition() {
        const plugins = await getCli().listPlugins(BASELINE.dsh.profile);
        return plugins.some(
          (p) => p.name === '@tencent-connect/dsh-qqbot' && p.version === BASELINE.qqbot.version,
        );
      },
      async run(ctx: StepContext) {
        ctx.log(
          '注意: 该插件的运行时依赖 @tencent-connect/qqbot-connector 为 UNLICENSED，仅在线安装，不打包、不镜像。',
        );
        await getCli().addPlugin(BASELINE.dsh.profile, QQ_PLUGIN_SPEC);
      },
    },
    {
      id: 'verify-plugin',
      title: '确认插件已安装',
      weight: 2,
      async run(ctx: StepContext) {
        const plugins = await getCli().listPlugins(BASELINE.dsh.profile);
        const found = plugins.find((p) => p.name === '@tencent-connect/dsh-qqbot');
        if (!found || found.version !== BASELINE.qqbot.version) {
          throw new DdaError(
            ERROR_CODES.E_PROCESS_FAILED,
            `插件未安装或版本不符: ${JSON.stringify(found ?? null)}`,
            '重试安装步骤',
          );
        }
        ctx.log(`已安装: ${found.name}@${found.version}`);
      },
    },
    {
      id: 'route-report',
      title: '记录路线检测结果',
      weight: 1,
      async run(ctx: StepContext) {
        const version = (await getCli().version()).version;
        const route = await detectHarnessRoute({ dshHome: paths.dshHome, managedDshVersion: version });
        ctx.log(`route=${route.kind}`);
        ctx.log(route.evidence.map((e) => `${e.signal}=${e.raw}`).join(' | '));
      },
    },
  ];
}
