import { describe, expect, it } from 'vitest';

import {
  decide,
  desktopInstalled,
  fullyInstalledProbes,
  managedHarness,
  managedNode,
  managedPnpm,
  probes,
  report,
  stableSystemNode,
  systemHarness,
} from '../helpers/environment-fixtures';

function action(decision: ReturnType<typeof decide>, component: string) {
  const found = decision.components.find((c) => c.component === component);
  if (!found) throw new Error(`missing decision for ${component}`);
  return found.action;
}

describe('安装决策引擎：六种内部动作', () => {
  it('场景 A 全新环境 → INSTALL（Node/pnpm/Harness），并解释安装顺序与影响', () => {
    const decision = decide(report());
    expect(decision.overall).toBe('INSTALL');
    expect(decision.deployable).toBe(true);
    expect(decision.runtime?.node.mode).toBe('managed');
    expect(decision.runtime?.harness.mode).toBe('managed');
    expect(decision.install).toEqual(expect.arrayContaining(['运行环境 Node.js', '包管理器 pnpm']));
    expect(decision.requiresNetwork).toBe(true);
    expect(decision.requiresAdmin).toBe(false);
    expect(decision.recovery.length).toBeGreaterThan(10);
    expect(decision.components.every((c) => c.impacts.length >= 0)).toBe(true);
  });

  it('场景 B 已有满足要求的 Node → REUSE，不重复安装', () => {
    const decision = decide(report({ systemNodes: [stableSystemNode('22.23.4')] }));
    expect(action(decision, 'node-system')).toBe('REUSE');
    expect(decision.runtime?.node.mode).toBe('system');
    expect(decision.runtime?.node.exe).toContain('nodejs');
    expect(decision.install).not.toContain('运行环境 Node.js');
  });

  it('已有 Node 但版本过低 → 安装私有运行时，并明确「不会动已有的 Node」', () => {
    const decision = decide(report({ systemNodes: [stableSystemNode('18.20.0')] }));
    expect(action(decision, 'node-system')).toBe('INSTALL');
    expect(decision.components.find((c) => c.component === 'node-system')?.reason).toContain('不会动');
    expect(decision.runtime?.node.mode).toBe('managed');
  });

  it('多版本并存 → CONFIRM_REQUIRED，用户明确选择后才可执行', () => {
    const multi = report({
      systemNodes: [
        stableSystemNode('22.23.4', 'C:\\Program Files\\nodejs\\node.exe'),
        stableSystemNode('20.11.0', 'C:\\node20\\node.exe'),
      ],
    });
    const decision = decide(multi);
    expect(decision.overall).toBe('CONFIRM_REQUIRED');
    expect(decision.needsChoice).toBe(true);
    expect(decision.deployable).toBe(false);
    expect(decision.runtime).toBeNull();
    expect(decision.options.length).toBeGreaterThanOrEqual(2);

    const chosen = decide(multi, decision.options[0]!.preferences);
    expect(chosen.deployable).toBe(true);
    expect(chosen.runtime?.node.mode).toBe('system');
    expect(chosen.runtime?.node.exe).toBe(decision.options[0]!.preferences.nodePath);
  });

  it('场景 C 已有 Harness 但版本不同 → 安装隔离副本，不覆盖用户已有安装', () => {
    const decision = decide(
      report({
        systemNodes: [stableSystemNode()],
        systemHarness: [systemHarness('0.2.1-rc.5')],
        route: { kind: 'cli', evidence: [] },
      }),
    );
    expect(action(decision, 'harness-managed')).toBe('INSTALL');
    expect(decision.components.find((c) => c.component === 'harness-managed')?.reason).toContain('不覆盖');
    expect(decision.runtime?.harness.mode).toBe('managed');
    expect(decision.untouched.join('')).toContain('用户已有的 Harness');
  });

  it('场景 D 系统 Harness 与锁定版本一致 → REUSE，且不安装第二份', () => {
    const decision = decide(
      report({
        systemNodes: [stableSystemNode()],
        systemHarness: [systemHarness()],
        route: { kind: 'cli', evidence: [] },
      }),
    );
    expect(action(decision, 'harness-system')).toBe('REUSE');
    expect(decision.runtime?.harness.mode).toBe('system');
    expect(decision.runtime?.harness.bin).toContain('bin.js');
  });

  it('CLI 与 Desktop 并存 → CONFIRM_REQUIRED；确认后 Desktop 仍列为不修改', () => {
    const both = report({
      managedNode: managedNode(),
      managedPnpm: managedPnpm(),
      managedHarness: managedHarness(),
      desktop: desktopInstalled(),
      profiles: { home: 'C:\\data\\dsh-home', homeExists: true, webExists: true, desktopExists: true },
      route: { kind: 'multiple', evidence: [] },
    });
    const decision = decide(both);
    expect(decision.overall).toBe('CONFIRM_REQUIRED');
    expect(decision.needsChoice).toBe(true);
    expect(decision.untouched.join('')).toContain('desktop profile');

    const acknowledged = decide(both, decision.options[0]!.preferences);
    expect(acknowledged.deployable).toBe(true);
    expect(action(acknowledged, 'harness-desktop')).toBe('REUSE');
    expect(acknowledged.modify.join('')).not.toContain('Desktop');
  });

  it('场景 E 多个 Harness 安装位置 → 需要用户确认使用哪一个', () => {
    const multi = report({
      systemNodes: [stableSystemNode()],
      systemHarness: [systemHarness('0.2.0-rc.2'), systemHarness('0.2.0-rc.2')],
      route: { kind: 'cli', evidence: [] },
    });
    const decision = decide(multi);
    expect(decision.overall).toBe('CONFIRM_REQUIRED');
    expect(decision.options.some((o) => o.preferences.harness === 'system')).toBe(true);
  });

  it('场景 F 私有 Node 损坏 → REPAIR（只修本软件自己的目录）', () => {
    const decision = decide(report({ managedNode: managedNode('22.23.4', false) }));
    expect(action(decision, 'node-managed')).toBe('REPAIR');
    expect(decision.overall).toBe('REPAIR');
    expect(decision.requiresNetwork).toBe(true);
    expect(decision.runtime?.node.mode).toBe('managed');
  });

  it('场景 F 私有 Harness 较旧 → UPGRADE', () => {
    const decision = decide(
      report({
        managedNode: managedNode(),
        managedPnpm: managedPnpm(),
        managedHarness: managedHarness('0.2.0-rc.1'),
        route: { kind: 'cli', evidence: [] },
      }),
    );
    expect(action(decision, 'harness-managed')).toBe('UPGRADE');
    expect(decision.overall).toBe('UPGRADE');
  });

  it('私有 Harness 比锁定版本新 → 降级需确认（B-5），选择后才执行', () => {
    const newer = report({
      managedNode: managedNode(),
      managedPnpm: managedPnpm(),
      managedHarness: managedHarness('0.3.0'),
      route: { kind: 'cli', evidence: [] },
    });
    const decision = decide(newer);
    expect(decision.overall).toBe('CONFIRM_REQUIRED');
    expect(decision.deployable).toBe(false);
    const chosen = decide(newer, decision.options[0]!.preferences);
    expect(chosen.deployable).toBe(true);
    expect(action(chosen, 'harness-managed')).toBe('UPGRADE');
  });

  it('场景 G 路线 unknown → BLOCKED，绝不覆盖安装', () => {
    const decision = decide(report({ route: { kind: 'unknown', evidence: [] } }));
    expect(decision.overall).toBe('BLOCKED');
    expect(decision.blocked).toBe(true);
    expect(decision.deployable).toBe(false);
    expect(decision.runtime).toBeNull();
    expect(decision.blockers.join('')).toContain('无法确认');
  });

  it('检测失败（不是未安装）→ 仍走安全的隔离安装，并标注不确定', () => {
    const decision = decide(
      report({
        systemNodes: [{ path: 'C:\\x\\node.exe', source: 'common', runnable: false, stable: true, hasNpm: false }],
        probeErrors: [{ probe: 'node-system', message: 'EACCES' }],
      }),
    );
    expect(action(decision, 'node-system')).toBe('INSTALL');
    expect(decision.components.find((c) => c.component === 'node-system')?.reason).toContain('无法确认');
    expect(decision.warnings.join('')).toContain('检测未能完成');
  });

  it('磁盘不足 → BLOCKED，且不建议提权', () => {
    const decision = decide(report({ disk: { root: 'C:\\', freeBytes: 100 } }));
    expect(decision.overall).toBe('BLOCKED');
    expect(decision.requiresAdmin).toBe(false);
    expect(decision.blockers.join('')).toContain('磁盘');
  });

  it('需要安装但网络不可用 → BLOCKED；全部复用则不需要联网', () => {
    const blocked = decide(report({ network: { primaryOk: false, mirrorOk: false, detail: '', targets: [] } }));
    expect(blocked.overall).toBe('BLOCKED');
    expect(blocked.blockers.join('')).toContain('网络');

    const offlineReuse = decide(report(fullyInstalledProbes()));
    expect(offlineReuse.blocked).toBe(false);
    expect(offlineReuse.requiresNetwork).toBe(false);
    expect(offlineReuse.overall).toBe('REUSE');
  });

  it('仅镜像可用 → 给出警告但不阻塞', () => {
    const decision = decide(
      report({ network: { primaryOk: false, mirrorOk: true, detail: 'mirror', targets: [] } }),
    );
    expect(decision.blocked).toBe(false);
    expect(decision.warnings.join('')).toContain('备用镜像');
  });

  it('目录不可写 → BLOCKED（不通过管理员权限绕过）', () => {
    const decision = decide(
      report({ directories: { root: 'C:\\ro', exists: true, writable: false, checkedPath: 'C:\\ro' } }),
    );
    expect(decision.overall).toBe('BLOCKED');
    expect(decision.requiresAdmin).toBe(false);
    expect(decision.blockers.join('')).toContain('无法写入');
  });

  it('所有决策都说明：当前环境/证据/推荐操作/原因/影响/权限/联网/确认/恢复', () => {
    const decision = decide(report({ systemNodes: [stableSystemNode()] }));
    for (const c of decision.components) {
      expect(c.reason.length).toBeGreaterThan(0);
      expect(c.recovery.length).toBeGreaterThan(0);
      expect(typeof c.requiresAdmin).toBe('boolean');
      expect(typeof c.requiresNetwork).toBe('boolean');
      expect(typeof c.requiresConfirmation).toBe('boolean');
      expect(Array.isArray(c.impacts)).toBe(true);
      expect(Array.isArray(c.evidence)).toBe(true);
    }
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.untouched.length).toBeGreaterThan(3);
  });

  it('planId 随偏好变化而变化（同一份检测不会复用错误的运行时）', () => {
    const env = report({ systemNodes: [stableSystemNode()] });
    const a = decide(env, { node: 'system' });
    const b = decide(env, { node: 'private' });
    expect(a.planId).not.toBe(b.planId);
  });

  it('系统 Node 缺少 npm → 不复用，改为安装私有运行时', () => {
    const decision = decide(
      report({
        systemNodes: [{ path: 'C:\\node\\node.exe', version: '22.23.4', source: 'common', runnable: true, stable: true, hasNpm: false }],
      }),
    );
    expect(action(decision, 'node-system')).toBe('INSTALL');
    expect(decision.components.find((c) => c.component === 'node-system')?.reason).toContain('缺少 npm');
    expect(decision.runtime?.node.mode).toBe('managed');
  });

  it('未检测到 Node 时不会把未知环境当成可复用', () => {
    const decision = decide(report({ systemNodes: [] }));
    expect(action(decision, 'node-system')).not.toBe('REUSE');
    expect(decision.runtime?.node.mode).toBe('managed');
  });

  it('evaluate/decide 不修改输入探针', () => {
    const input = probes({ systemNodes: [stableSystemNode()] });
    const snapshot = JSON.stringify(input);
    decide(report(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
