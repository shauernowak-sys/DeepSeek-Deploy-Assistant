import { describe, expect, it } from 'vitest';

import { evaluateEnvironment } from '@dda/core';
import { COMPONENT_STATES } from '@dda/spec';

import {
  BASELINE,
  desktopInstalled,
  managedHarness,
  managedNode,
  NODE_MIN,
  probes,
  report,
  stableSystemNode,
  systemHarness,
} from '../helpers/environment-fixtures';

function component(result: ReturnType<typeof report>, id: string) {
  const found = result.components.find((c) => c.id === id);
  if (!found) throw new Error(`missing component ${id}`);
  return found;
}

describe('五态环境检测（真实探针的纯评估层）', () => {
  it('全新环境：组件是「未安装」，不是「检测失败」', () => {
    const result = report();
    expect(component(result, 'node-system').state).toBe('missing');
    expect(component(result, 'node-managed').state).toBe('missing');
    expect(component(result, 'harness-managed').state).toBe('missing');
    expect(component(result, 'harness-system').state).toBe('missing');
    expect(component(result, 'harness-desktop').state).toBe('missing');
    expect(result.probeErrors).toEqual([]);
  });

  it('只允许 PRD 定义的五态，且每项都带检测时间与证据', () => {
    const result = report({ systemNodes: [stableSystemNode()] });
    for (const c of result.components) {
      expect(COMPONENT_STATES).toContain(c.state);
      expect(c.checkedAt).toBe(result.checkedAt);
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });

  it('每个报告有唯一 scanId（并发/重复检测不会混为一谈）', () => {
    const a = report();
    const b = report();
    expect(a.scanId).not.toBe(b.scanId);
  });

  it('系统 Node 满足下限：已安装，并记录 PATH 命中与实际路径', () => {
    const result = report({
      systemNodes: [
        stableSystemNode('22.23.4', 'C:\\Program Files\\nodejs\\node.exe'),
        { ...stableSystemNode('20.11.0', 'C:\\Program Files\\nodejs-old\\node.exe'), source: 'common', onPathOrder: 0 },
      ],
    });
    const node = component(result, 'node-system');
    expect(node.state).toBe('installed');
    expect(node.diagnosis).toBe('multiple-versions');
    expect(result.resolution.pathNode?.path).toContain('nodejs-old');
    expect(result.resolution.reusableSystemNode?.path).toContain('Program Files\\nodejs');
  });

  it('版本过低 → 版本不符（不是未安装）', () => {
    const result = report({ systemNodes: [stableSystemNode('18.20.0')] });
    const node = component(result, 'node-system');
    expect(node.state).toBe('version-mismatch');
    expect(node.diagnosis).toBe('version-too-low');
    expect(node.path).toContain('nodejs');
  });

  it('文件存在但无法执行 → 检测失败（不是未安装，也不是已安装）', () => {
    const result = report({
      systemNodes: [{ path: 'C:\\broken\\node.exe', source: 'common', runnable: false, stable: true, hasNpm: false, error: 'EACCES' }],
    });
    const node = component(result, 'node-system');
    expect(node.state).toBe('probe-failed');
    expect(node.diagnosis).toBe('not-executable');
    expect(node.detail).toContain('无法执行');
  });

  it('版本管理器/临时路径：状态仍是已安装，但 D-6 判定为不可复用', () => {
    const result = report({
      systemNodes: [
        {
          path: 'C:\\Users\\u\\AppData\\Roaming\\nvm\\v22.23.4\\node.exe',
          version: '22.23.4',
          source: 'version-manager',
          runnable: true,
          stable: false,
          hasNpm: true,
        },
      ],
    });
    const node = component(result, 'node-system');
    expect(node.state).toBe('installed');
    expect(node.diagnosis).toBe('unstable-path');
    expect(result.resolution.reusableSystemNode).toBeUndefined();
  });

  it('私有 Node 损坏 → 检测失败，决策层可识别为需要修复', () => {
    const result = report({ managedNode: managedNode('22.23.4', false) });
    const node = component(result, 'node-managed');
    expect(node.state).toBe('probe-failed');
    expect(node.diagnosis).toBe('not-executable');
  });

  it('私有 Harness 版本较旧 → 需升级', () => {
    const result = report({
      managedNode: managedNode(),
      managedHarness: managedHarness('0.2.0-rc.1'),
      route: { kind: 'cli', evidence: [] },
    });
    expect(component(result, 'harness-managed').state).toBe('upgrade-required');
  });

  it('系统 Harness 与锁定版本不同 → 版本不符（不会被当成可复用）', () => {
    const result = report({
      systemNodes: [stableSystemNode()],
      systemHarness: [systemHarness('0.2.1-rc.5')],
      route: { kind: 'cli', evidence: [] },
    });
    const harness = component(result, 'harness-system');
    expect(harness.state).toBe('version-mismatch');
    expect(result.resolution.reusableSystemHarness).toBeUndefined();
  });

  it('系统 Harness 版本一致且稳定 → 可复用，并解析出 JS 入口', () => {
    const result = report({
      systemNodes: [stableSystemNode()],
      systemHarness: [systemHarness()],
      route: { kind: 'cli', evidence: [] },
    });
    const harness = component(result, 'harness-system');
    expect(harness.state).toBe('installed');
    expect(result.resolution.reusableSystemHarness?.binPath).toContain('bin.js');
  });

  it('读不到注册表 → 检测失败，不能显示成「未安装」', () => {
    const result = report({ desktop: { registryRead: false, exeExists: false, profileExists: false } });
    const desktop = component(result, 'harness-desktop');
    expect(desktop.state).toBe('probe-failed');
    expect(desktop.diagnosis).toBe('probe-error');
  });

  it('注册表有记录但主程序缺失 → 检测失败/状态矛盾（路由应降级 unknown）', () => {
    const result = report({
      desktop: { registryRead: true, displayName: 'DeepSeek Harness', installDir: 'C:\\gone', exeExists: false, profileExists: false },
      route: { kind: 'unknown', evidence: [{ signal: 'desktop.installDir', ok: false, raw: 'absent' }] },
    });
    expect(component(result, 'harness-desktop').state).toBe('probe-failed');
    expect(component(result, 'harness-desktop').diagnosis).toBe('ambiguous');
    expect(result.route.kind).toBe('unknown');
  });

  it('网络失败不污染本地组件结论', () => {
    const result = report({
      systemNodes: [stableSystemNode()],
      network: { primaryOk: false, mirrorOk: false, detail: 'offline', targets: [] },
    });
    expect(component(result, 'node-system').state).toBe('installed');
    expect(result.prerequisites.find((p) => p.id === 'network')?.state).toBe('unavailable');
  });

  it('磁盘按数据目录所在盘符计算，并给出充足/不足状态', () => {
    const insufficient = report({ disk: { root: 'D:\\', freeBytes: 100 * 1024 ** 2 } });
    const disk = insufficient.prerequisites.find((p) => p.id === 'disk')!;
    expect(disk.state).toBe('insufficient');
    expect(disk.detail).toContain('D:\\');
  });

  it('已安装 Desktop 会保留为只读组件（不会被修改）', () => {
    const result = report({
      desktop: desktopInstalled('0.2.0'),
      route: { kind: 'desktop', evidence: [] },
      profiles: { home: 'C:\\data\\dsh-home', homeExists: true, webExists: false, desktopExists: true },
    });
    const desktop = component(result, 'harness-desktop');
    expect(desktop.state).toBe('installed');
    expect(desktop.version).toBe('0.2.0');
  });

  it('探针异常写进 probeErrors，且不会被解释成「未安装」', () => {
    const result = report({
      systemNodes: [],
      probeErrors: [{ probe: 'desktop', message: 'Access is denied' }],
      desktop: { registryRead: false, exeExists: false, profileExists: false },
    });
    expect(result.probeErrors).toHaveLength(1);
    expect(component(result, 'harness-desktop').state).toBe('probe-failed');
  });

  it('evaluate 不修改输入探针（检测只读）', () => {
    const input = probes({ systemNodes: [stableSystemNode()] });
    const snapshot = JSON.stringify(input);
    evaluateEnvironment(input, { baseline: BASELINE, nodeMinVersion: NODE_MIN });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
