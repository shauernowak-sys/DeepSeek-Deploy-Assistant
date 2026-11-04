import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths, fileExists, probeEnvironment } from '@dda/adapters';
import { decideInstallation } from '@dda/core';
import { BASELINE, COMPONENT_STATES, RuntimeManifestSchema, type RuntimeManifest } from '@dda/spec';

const manifests = join(__dirname, '../../apps/desktop/resources/manifests');
const isWindows = process.platform === 'win32';

describe.skipIf(!isWindows)('真实 Windows 环境检测（非 Mock）', () => {
  it('读取本机真实环境并生成一致的五态报告与决策', async () => {
    const localAppData = process.env.LOCALAPPDATA;
    expect(localAppData, 'LOCALAPPDATA 必须存在').toBeTruthy();
    const paths = appPaths(localAppData!);
    const manifest: RuntimeManifest = RuntimeManifestSchema.parse(
      JSON.parse(await readFile(join(manifests, 'node.json'), 'utf8')),
    );

    const report = await probeEnvironment({
      paths,
      manifest,
      nodeMinVersion: manifest.detect.minVersion,
      registry: 'https://registry.npmmirror.com',
    });

    // 结构与五态约束
    expect(report.schemaVersion).toBe(2);
    expect(report.scanId.length).toBeGreaterThan(8);
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.components.map((c) => c.id).sort()).toEqual(
      ['harness-desktop', 'harness-managed', 'harness-system', 'node-managed', 'node-system', 'pnpm-managed'].sort(),
    );
    for (const c of report.components) {
      expect(COMPONENT_STATES).toContain(c.state);
      expect(c.evidence.length).toBeGreaterThan(0);
    }
    expect(report.prerequisites.map((p) => p.id).sort()).toEqual(['directories', 'disk', 'network', 'os', 'permissions'].sort());
    expect(report.os.arch).toBe(process.arch);
    expect(typeof report.os.admin).toBe('boolean');
    expect(report.resolution.profiles.home).toContain('dsh-home');

    // 系统 Node 的结论必须来自真实执行结果（有候选才有版本）
    const node = report.components.find((c) => c.id === 'node-system')!;
    for (const candidate of node.candidates) {
      if (candidate.runnable) expect(candidate.version).toMatch(/^\d+\.\d+\.\d+/);
    }

    const decision = decideInstallation(report, {
      baseline: { node: BASELINE.node.version, pnpm: BASELINE.pnpm.version, dsh: BASELINE.dsh.version },
      nodeMinVersion: manifest.detect.minVersion,
      targets: {
        managedNodeExe: join(paths.nodeDir, 'node.exe'),
        managedNodeDir: paths.nodeDir,
        managedHarnessBin: join(paths.harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      },
    });

    // 无论本机状态如何，未知/矛盾状态都不能得到可执行方案。
    if (report.route.kind === 'unknown') {
      expect(decision.blocked).toBe(true);
      expect(decision.deployable).toBe(false);
    }
    if (decision.deployable) {
      expect(decision.runtime).toBeTruthy();
      expect(decision.blockers).toEqual([]);
    }
    // 决策必须明确不会做的事（安全边界）。
    expect(decision.untouched.join('')).toContain('PATH');
    expect(decision.untouched.join('')).toContain('desktop profile');

    // 真实机器证据：输出紧凑摘要，便于人工复核（不含密钥）。
    console.log(`[env] checkedAt=${report.checkedAt} scan=${report.scanId}`);
    console.log(`[env] os=${report.os.caption} arch=${report.os.arch} admin=${report.os.admin} route=${report.route.kind}`);
    for (const c of report.components) {
      console.log(`[env] component=${c.id} state=${c.state} diagnosis=${c.diagnosis} version=${c.version ?? '-'} path=${c.path ?? '-'}`);
    }
    for (const p of report.prerequisites) {
      console.log(`[env] prerequisite=${p.id} ok=${p.ok} state=${p.state} detail=${p.detail}`);
    }
    console.log(
      `[decision] overall=${decision.overall} deployable=${decision.deployable} needsChoice=${decision.needsChoice} network=${decision.requiresNetwork} admin=${decision.requiresAdmin}`,
    );
    console.log(`[decision] install=${JSON.stringify(decision.install)} reuse=${JSON.stringify(decision.reuse)} modify=${JSON.stringify(decision.modify)}`);
    console.log(`[decision] blockers=${JSON.stringify(decision.blockers)}`);
    console.log(
      `[decision] runtime=${decision.runtime ? `node:${decision.runtime.node.mode}:${decision.runtime.node.exe} harness:${decision.runtime.harness.mode}` : 'none'}`,
    );
  });

  it('本软件数据目录为空时，优先复用真实系统 Node（D-1/D-6），且检测不创建目录', async () => {
    const localAppData = await mkdtemp(join(tmpdir(), 'dda-real-empty-'));
    const paths = appPaths(localAppData);
    const manifest = RuntimeManifestSchema.parse(JSON.parse(await readFile(join(manifests, 'node.json'), 'utf8')));

    const report = await probeEnvironment({
      paths,
      manifest,
      nodeMinVersion: manifest.detect.minVersion,
      registry: 'https://registry.npmmirror.com',
    });
    const node = report.components.find((c) => c.id === 'node-system')!;
    expect(node.state).toBe('installed');

    const decision = decideInstallation(report, {
      baseline: { node: BASELINE.node.version, pnpm: BASELINE.pnpm.version, dsh: BASELINE.dsh.version },
      nodeMinVersion: manifest.detect.minVersion,
      targets: {
        managedNodeExe: join(paths.nodeDir, 'node.exe'),
        managedNodeDir: paths.nodeDir,
        managedHarnessBin: join(paths.harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      },
    });
    const nodeDecision = decision.components.find((c) => c.component === 'node-system')!;
    expect(nodeDecision.action).toBe('REUSE');
    expect(decision.runtime?.node.mode).toBe('system');
    expect(decision.runtime?.node.exe).toBe(node.path);
    expect(decision.install).not.toContain('运行环境 Node.js');
    // 检测是只读的：数据目录仍不存在。
    expect(await fileExists(paths.root)).toBe(false);
    console.log(`[reuse] systemNode=${node.path} version=${node.version} action=${nodeDecision.action} runtime=${decision.runtime?.node.mode}`);
  });
});
