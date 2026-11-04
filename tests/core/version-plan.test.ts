import { describe, expect, it } from 'vitest';

import { loadMatrix, planPluginChange } from '@dda/core';
import { DdaError } from '@dda/spec';
import type { CompatMatrix } from '@dda/spec';

const QA = '@tencent-connect/dsh-qqbot';

function matrix(entries: Array<{ id: string; qqbot: string; status: 'verified-local' | 'unverified' }>): CompatMatrix {
  return loadMatrix({
    schemaVersion: 1,
    entries: entries.map((entry) => ({
      id: entry.id,
      dsh: '0.2.0-rc.2',
      qqbot: entry.qqbot,
      node: '>= 20.3.0',
      status: entry.status,
      evidence: ['e'],
    })),
  });
}

const BOTH_OK = matrix([
  { id: 'C1-055', qqbot: '0.5.5', status: 'verified-local' },
  { id: 'C1-054', qqbot: '0.5.4', status: 'verified-local' },
]);

const base = {
  name: QA,
  matrix: BOTH_OK,
  dshVersion: '0.2.0-rc.2',
};

describe('D07 同版本 / 全新安装', () => {
  it('未安装 → install，走 add', () => {
    const plan = planPluginChange({ ...base, target: { name: QA, version: '0.5.5' } });
    expect(plan.action).toBe('install');
    expect(plan.method).toBe('add');
    expect(plan.requiresConfirmation).toBe(false);
    expect(plan.comboId).toBe('C1-055');
  });

  it('同版本 → none，不进入任何安装动作', () => {
    const plan = planPluginChange({ ...base, installedVersion: '0.5.5', target: { name: QA, version: '0.5.5' } });
    expect(plan.action).toBe('none');
    expect(plan.method).toBe('add');
  });
});

describe('D07 升级', () => {
  it('白名单内升级 → remove+add，并提示会重建依赖', () => {
    const plan = planPluginChange({ ...base, installedVersion: '0.5.4', target: { name: QA, version: '0.5.5' } });
    expect(plan.action).toBe('upgrade');
    expect(plan.method).toBe('remove-then-add');
    expect(plan.requiresConfirmation).toBe(false);
    expect(plan.warnings.join('')).toContain('重建');
  });

  it('升级到未验证组合 → 第 1 步门禁拒绝', () => {
    const unverified = matrix([{ id: 'C3-latest', qqbot: '0.5.5', status: 'unverified' }]);
    expect(() =>
      planPluginChange({
        name: QA,
        matrix: unverified,
        dshVersion: '0.2.0-rc.2',
        installedVersion: '0.5.4',
        target: { name: QA, version: '0.5.5' },
      }),
    ).toThrowError(/unverified/);
  });
});

describe('D07 降级', () => {
  it('未确认 → 拒绝，并给出"当前 → 目标"', () => {
    try {
      planPluginChange({ ...base, installedVersion: '0.5.5', target: { name: QA, version: '0.5.4' } });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(DdaError);
      expect((error as DdaError).code).toBe('E_DECISION_UNCONFIRMED');
      expect((error as DdaError).message).toContain('0.5.5');
      expect((error as DdaError).message).toContain('0.5.4');
    }
  });

  it('已确认 → downgrade，且标记需要确认与风险提示', () => {
    const plan = planPluginChange({
      ...base,
      installedVersion: '0.5.5',
      target: { name: QA, version: '0.5.4' },
      allowDowngrade: true,
    });
    expect(plan.action).toBe('downgrade');
    expect(plan.method).toBe('remove-then-add');
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.warnings.join('')).toContain('降级');
  });

  it('降级同样必须命中白名单组合', () => {
    const onlyNewer = matrix([{ id: 'C1-055', qqbot: '0.5.5', status: 'verified-local' }]);
    expect(() =>
      planPluginChange({
        name: QA,
        matrix: onlyNewer,
        dshVersion: '0.2.0-rc.2',
        installedVersion: '0.5.5',
        target: { name: QA, version: '0.5.4' },
        allowDowngrade: true,
      }),
    ).toThrowError(/未列入白名单/);
  });
});

describe('D07 目标校验', () => {
  it('目标插件与已安装不是同一个包 → 拒绝', () => {
    expect(() =>
      planPluginChange({ ...base, installedVersion: '1.0.0', target: { name: 'other-plugin', version: '1.0.1' } }),
    ).toThrowError(/不是同一个包/);
  });
});
