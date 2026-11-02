import { describe, expect, it } from 'vitest';

import { detectRoute, isWritableProfile } from '@dda/core';

const base = { homeExists: false, desktopProfileExists: false, dshHome: 'C:\\dsh' } as const;

describe('路线检测', () => {
  it('两者都不存在 → none', () => {
    expect(detectRoute({ ...base }).kind).toBe('none');
  });

  it('只有 CLI → cli', () => {
    expect(detectRoute({ ...base, managedCliVersion: '0.2.0-rc.2', homeExists: true }).kind).toBe('cli');
  });

  it('只有 Desktop（注册表命中）→ desktop', () => {
    const report = detectRoute({
      ...base,
      desktopRegistry: { displayName: 'DeepSeek Harness', installLocation: 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness' },
      desktopDirExists: true,
    });
    expect(report.kind).toBe('desktop');
    expect(report.desktopInstallDir).toContain('DeepSeek Harness');
  });

  it('两者同时存在 → multiple', () => {
    const report = detectRoute({
      ...base,
      managedCliVersion: '0.2.0-rc.2',
      homeExists: true,
      desktopProfileExists: true,
      desktopRegistry: { displayName: 'DeepSeek Harness' },
      desktopDirExists: true,
    });
    expect(report.kind).toBe('multiple');
  });

  it('注册表有但安装目录不存在 → unknown（不得猜成 none 后开始安装）', () => {
    const report = detectRoute({
      ...base,
      desktopRegistry: { displayName: 'DeepSeek Harness' },
      desktopDirExists: false,
    });
    expect(report.kind).toBe('unknown');
  });

  it('每个判定都携带证据', () => {
    const report = detectRoute({ ...base, managedCliVersion: '0.2.0-rc.2' });
    expect(report.evidence.length).toBeGreaterThanOrEqual(6);
    expect(report.evidence.some((e) => e.signal === 'cli.managedVersion' && e.ok)).toBe(true);
  });

  it('desktop profile 永不视为可写', () => {
    expect(isWritableProfile('desktop', true)).toBe(false);
    expect(isWritableProfile('desktop', false)).toBe(false);
    expect(isWritableProfile('web', true)).toBe(true);
  });
});
