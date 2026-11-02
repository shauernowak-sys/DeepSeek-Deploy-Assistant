import { describe, expect, it } from 'vitest';

import { assertCombination, compareVersions, loadMatrix, satisfiesMin } from '@dda/core';

const matrix = loadMatrix({
  schemaVersion: 1,
  entries: [
    {
      id: 'C1-prime',
      dsh: '0.2.0-rc.2',
      qqbot: '0.5.5',
      node: '>= 20.3.0',
      status: 'verified-local',
      evidence: ['docs/M0-技术验证报告.md#5'],
    },
    {
      id: 'C1-rc8',
      dsh: '0.1.0-rc.8',
      qqbot: '0.5.5',
      node: '>= 20.3.0',
      status: 'blocked',
      evidence: ['docs/M0-技术验证报告.md#4'],
    },
    {
      id: 'C3-latest',
      dsh: '0.2.1-rc.5',
      qqbot: '0.5.5',
      node: '>= 20.3.0',
      status: 'unverified',
      evidence: ['npm registry'],
    },
  ],
});

describe('版本比较', () => {
  it('遵循 SemVer（含 prerelease 优先于正式版）', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('0.2.0-rc.2', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.10')).toBe(-1);
    expect(compareVersions('22.23.4', '20.3.0')).toBe(1);
  });

  it('satisfiesMin 用于最低版本判定', () => {
    expect(satisfiesMin('22.23.4', '20.3.0')).toBe(true);
    expect(satisfiesMin('20.0.0', '20.3.0')).toBe(false);
  });
});

describe('兼容矩阵门禁', () => {
  it('放行 verified-local 组合', () => {
    const entry = assertCombination(matrix, { dsh: '0.2.0-rc.2', qqbot: '0.5.5', node: '22.23.4' });
    expect(entry.id).toBe('C1-prime');
  });

  it('拒绝 blocked 组合（M0 证实崩溃的 0.1.0-rc.8）', () => {
    expect(() => assertCombination(matrix, { dsh: '0.1.0-rc.8', qqbot: '0.5.5', node: '22.23.4' })).toThrowError(
      /blocked/,
    );
  });

  it('拒绝 unverified 组合（npm latest）', () => {
    expect(() => assertCombination(matrix, { dsh: '0.2.1-rc.5', qqbot: '0.5.5', node: '22.23.4' })).toThrowError(
      /unverified/,
    );
  });

  it('拒绝未登记组合', () => {
    expect(() => assertCombination(matrix, { dsh: '9.9.9', qqbot: '0.5.5', node: '22.23.4' })).toThrowError(
      /未列入白名单/,
    );
  });

  it('拒绝 Node 版本不满足', () => {
    expect(() => assertCombination(matrix, { dsh: '0.2.0-rc.2', qqbot: '0.5.5', node: '18.0.0' })).toThrowError(
      /不满足/,
    );
  });

  it('矩阵结构非法时拒绝加载', () => {
    expect(() => loadMatrix({ schemaVersion: 1, entries: [] })).toThrowError(/兼容矩阵校验失败/);
    expect(() => loadMatrix({ schemaVersion: 1, entries: [{ id: 'x' }] })).toThrowError(/兼容矩阵校验失败/);
  });
});
