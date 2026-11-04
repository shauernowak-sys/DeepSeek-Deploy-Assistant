import { mkdir } from 'node:fs/promises';
import { join, parse } from 'node:path';

import {
  assertCombination,
  assertDistributionAllowed,
  downloadVerified,
  detectAdmin,
  freeBytes,
  MIN_FREE_BYTES,
  satisfiesMin,
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
  npmCliFor,
  runCommand,
  runCommandCapture,
  writePnpmShim,
  type AppPaths,
  type DshCli,
} from '@dda/adapters';
import { BASELINE, DdaError, ERROR_CODES, QQ_PLUGIN_DISTRIBUTION, type RuntimeSelection } from '@dda/spec';
import type { CompatMatrix, RuntimeManifest } from '@dda/spec';

export const QQ_PLUGIN_SPEC = `@tencent-connect/dsh-qqbot@${BASELINE.qqbot.version}`;

export interface DeployPlanDeps {
  paths: AppPaths;
  manifest: RuntimeManifest;
  matrix: CompatMatrix;
  registry: string;
  log: (message: string) => void;
  /** Injectable so a unit test can exercise the plan's recording rules without a real Harness. */
  cli?: DshCli;
  /** 门禁确认的运行时；缺省为私有运行时（兼容回滚等只读路径）。 */
  runtime?: RuntimeSelection;
  qqMode?: 'official' | 'personal';
}

/**
 * Pure(ish) plan builder: no Electron imports, so the exact production steps can be
 * executed by an integration test against a throwaway data root.
 */
export function buildDeploySteps(deps: DeployPlanDeps): Step[] {
  const { paths, manifest, matrix, registry, log } = deps;
  const nodePath = deps.runtime?.node.exe ?? nodeExe(paths);
  const harnessBin = deps.runtime?.harness.bin ?? dshBinJs(paths);
  const reuseSystemNode = deps.runtime?.node.mode === 'system';
  const reuseSystemHarness = deps.runtime?.harness.mode === 'system';
  const cli =
    deps.cli ??
    createDshCli({
      paths,
      pnpmBinDir: join(paths.root, 'bin'),
      registry,
      nodeExePath: nodePath,
      binPath: harnessBin,
    });
  const getCli = () => cli;

  const nodeSteps: Step[] = reuseSystemNode
    ? [
        {
          id: 'verify-node',
          title: '校验复用的系统 Node.js',
          weight: 2,
          async run(ctx: StepContext) {
            const { stdout } = await runCommand({ exePath: nodePath, args: ['-v'], timeoutMs: 15_000 });
            const version = stdout.trim().replace(/^v/, '');
            ctx.log(`复用系统 Node：${nodePath} => ${version}（不会修改它）`);
            if (!satisfiesMin(version, manifest.detect.minVersion)) {
              throw new DdaError(
                ERROR_CODES.E_VERSION_UNSUPPORTED,
                `系统 Node ${version} 低于要求 ${manifest.detect.minVersion}`,
                '重新检测后改为使用私有运行时',
              );
            }
          },
        },
      ]
    : [
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
      ];

  const harnessSteps: Step[] = reuseSystemHarness
    ? [
        {
          id: 'verify-dsh',
          title: '校验复用的 Harness',
          weight: 2,
          async run(ctx: StepContext) {
            const info = await getCli().version();
            if (!info.installed || info.version !== BASELINE.dsh.version) {
              throw new DdaError(
                ERROR_CODES.E_VERSION_UNSUPPORTED,
                `系统 Harness 版本不符: ${info.version ?? '未安装'}，期望 ${BASELINE.dsh.version}`,
                '重新检测后改为安装隔离副本（不会覆盖原安装）',
              );
            }
            ctx.log(`复用系统 Harness：${harnessBin} => ${info.version}`);
          },
        },
      ]
    : [
        {
          id: 'install-dsh',
          title: `安装 Harness ${BASELINE.dsh.version}`,
          weight: 12,
          async precondition() {
            return fileExists(harnessBin);
          },
          async run(ctx: StepContext) {
            ctx.created(paths.harnessDir);
            await mkdir(paths.harnessDir, { recursive: true });
            const pnpmCli = join(paths.pnpmPrefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
            const result = await runCommandCapture({
              exePath: nodePath,
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
      ];

  return [
    {
      id: 'check-disk',
      title: '检查磁盘空间与目录',
      weight: 1,
      async run(ctx: StepContext) {
        const drive = parse(paths.root).root || 'C:\\';
        const free = await freeBytes(drive);
        ctx.log(`${drive} 可用空间 ${(free / 1024 ** 3).toFixed(1)} GB`);
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
        log(
          `安装目录: ${paths.root}；管理员: ${await detectAdmin()}；运行时: node=${deps.runtime?.node.mode ?? 'managed'} harness=${deps.runtime?.harness.mode ?? 'managed'}`,
        );
      },
    },
    ...nodeSteps,
    {
      id: 'ensure-pnpm',
      title: `安装 pnpm ${BASELINE.pnpm.version}`,
      weight: 6,
      async run(ctx: StepContext) {
        ctx.created(paths.pnpmPrefix);
        const info = await ensurePnpm(paths, {
          registry,
          log: (m) => ctx.log(m),
          nodeExePath: nodePath,
          npmCliPath: reuseSystemNode ? npmCliFor(nodePath) : undefined,
        });
        ctx.log(`pnpm => ${info.version}`);
      },
    },
    {
      id: 'write-shim',
      title: '生成 pnpm 私有 shim',
      weight: 1,
      async run(ctx: StepContext) {
        const dir = await writePnpmShim(paths, nodePath);
        ctx.created(dir);
        ctx.log(`shim: ${join(dir, 'pnpm.cmd')}（仅注入子进程 PATH）`);
      },
    },
    ...harnessSteps,
    {
      id: 'assert-combo',
      title: '校验版本组合白名单',
      weight: 1,
      async run(ctx: StepContext) {
        const entry = assertCombination(matrix, {
          dsh: BASELINE.dsh.version,
          qqbot: BASELINE.qqbot.version,
          node: deps.runtime?.node.version ?? BASELINE.node.version,
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
        // `dsh-home` belongs to the user: even when this step creates it, it is NOT an installation
        // artifact. Recording it in `created[]` would make "cancel + cleanup" delete the Harness
        // profile (config, plugins, credentials) that the product must never touch.
        await getCli().ensureProfile(BASELINE.dsh.profile);
        ctx.log(`profile 目录: ${join(paths.dshHome, 'profiles', BASELINE.dsh.profile)}`);
      },
    },
    ...(deps.qqMode === 'personal' ? [] : [{
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
        // Gate 4 ② 降级后：只允许在线安装；离线包/镜像/重打包在许可上不可行，先拦后装。
        assertDistributionAllowed(QQ_PLUGIN_DISTRIBUTION, 'online-install');
        ctx.log(QQ_PLUGIN_DISTRIBUTION.notice);
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
    }]),
    {
      id: 'route-report',
      title: '记录路线检测结果',
      weight: 1,
      async run(ctx: StepContext) {
        const version = (await getCli().version()).version;
        const route = await detectHarnessRoute({
          dshHome: paths.dshHome,
          managedDshVersion: reuseSystemHarness ? undefined : version,
          pathDshVersion: reuseSystemHarness ? version : undefined,
        });
        ctx.log(`route=${route.kind}`);
        ctx.log(route.evidence.map((e) => `${e.signal}=${e.raw}`).join(' | '));
      },
    },
  ];
}
