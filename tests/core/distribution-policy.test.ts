import { describe, expect, it } from 'vitest';

import { assertDistributionAllowed, describeDistributionBlocker, isDistributionAllowed } from '@dda/core';
import {
  BASELINE,
  DISTRIBUTION_MODES,
  QQ_PLUGIN_DISTRIBUTION,
  type DistributionMode,
} from '@dda/spec';

const ALWAYS_ALLOWED: DistributionMode = 'online-install';
const LICENSE_BLOCKED: DistributionMode[] = ['offline-bundle', 'mirror', 'rebundle'];

describe('Gate 4 ② 降级：分发边界策略', () => {
  it('在线安装恒允许（我方不复制任何字节）', () => {
    expect(isDistributionAllowed(QQ_PLUGIN_DISTRIBUTION, ALWAYS_ALLOWED)).toBe(true);
    expect(() => assertDistributionAllowed(QQ_PLUGIN_DISTRIBUTION, ALWAYS_ALLOWED)).not.toThrow();
  });

  it.each(LICENSE_BLOCKED)('「%s」被拒绝，且点名到具体包与许可', (mode) => {
    expect(isDistributionAllowed(QQ_PLUGIN_DISTRIBUTION, mode)).toBe(false);
    let caught: unknown;
    try {
      assertDistributionAllowed(QQ_PLUGIN_DISTRIBUTION, mode);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as { code?: string; message: string; hint?: string };
    expect(error.code).toBe('E_DISTRIBUTION_BLOCKED');
    expect(error.message).toContain(`@tencent-connect/qqbot-connector@${BASELINE.qqbot.connector}`);
    expect(error.message).toContain('UNLICENSED');
    expect(error.hint).toContain('在线安装');
  });

  it('三种分发方式都有阻断记录，且与允许清单不重叠', () => {
    const blockedModes = QQ_PLUGIN_DISTRIBUTION.blocked.map((entry) => entry.mode);
    for (const mode of LICENSE_BLOCKED) expect(blockedModes).toContain(mode);
    for (const mode of QQ_PLUGIN_DISTRIBUTION.allowed) expect(blockedModes).not.toContain(mode);
    expect(new Set(blockedModes).size).toBe(blockedModes.length);
  });

  it('策略覆盖了全部四种分发方式', () => {
    const covered = new Set<DistributionMode>([
      ...QQ_PLUGIN_DISTRIBUTION.allowed,
      ...QQ_PLUGIN_DISTRIBUTION.blocked.map((entry) => entry.mode),
    ]);
    for (const mode of DISTRIBUTION_MODES) expect(covered.has(mode)).toBe(true);
  });

  it('对外说明如实写明"不提供离线安装"，且不出现离线承诺', () => {
    const notice = QQ_PLUGIN_DISTRIBUTION.notice;
    expect(notice).toContain('仅支持在线安装');
    expect(notice).toContain('不提供离线安装');
    expect(notice).toContain('UNLICENSED');
    expect(notice).not.toMatch(/支持离线|离线可用|断网安装/);
  });

  it('插件版本来自锁定的基线，不与清单漂移', () => {
    expect(QQ_PLUGIN_DISTRIBUTION.version).toBe(BASELINE.qqbot.version);
    for (const entry of QQ_PLUGIN_DISTRIBUTION.blocked) {
      expect(entry.version).toBe(BASELINE.qqbot.connector);
    }
  });

  it('未知阻断项也给出可读文案（防御：策略漏配时不抛内部错误）', () => {
    const unlisted: DistributionMode[] = ['offline-bundle'];
    const policy = { ...QQ_PLUGIN_DISTRIBUTION, blocked: [] as typeof QQ_PLUGIN_DISTRIBUTION.blocked };
    expect(unlisted.length).toBe(1);
    expect(describeDistributionBlocker(policy, 'offline-bundle')).toContain('未把「离线包」列入允许清单');
  });
});
