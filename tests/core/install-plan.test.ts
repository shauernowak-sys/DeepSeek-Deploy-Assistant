import { marketInstallTarget as officialInstallTarget } from '@deepseek-ai/dsh-plugin-market-index';
import { describe, expect, it, vi } from 'vitest';

import { OFFICIAL_QQBOT_ENTRY } from '../../catalog/entries/official-qqbot';
import {
  explainInstallFailure,
  installCatalogPlugin,
  loadMatrix,
  marketInstallTarget,
  registryPlan,
  type PluginInstallDeps,
} from '@dda/core';
import type { CompatMatrix, PluginState } from '@dda/spec';

const VERIFIED_MATRIX: CompatMatrix = loadMatrix({
  schemaVersion: 1,
  entries: [
    {
      id: 'C1-prime',
      dsh: '0.2.0-rc.2',
      qqbot: '0.5.5',
      node: '>= 20.3.0',
      status: 'verified-local',
      evidence: ['e'],
    },
  ],
});

const UNVERIFIED_MATRIX: CompatMatrix = loadMatrix({
  schemaVersion: 1,
  entries: [
    {
      id: 'C3-latest',
      dsh: '0.2.1-rc.5',
      qqbot: '0.5.5',
      node: '>= 20.3.0',
      status: 'unverified',
      evidence: ['e'],
    },
  ],
});

function deps(overrides: Partial<PluginInstallDeps> = {}): PluginInstallDeps {
  return {
    precheck: async () => undefined,
    addPlugin: async () => undefined,
    listPlugins: async () => [{ name: '@tencent-connect/dsh-qqbot', version: '0.5.5', installed: true }],
    ...overrides,
  };
}

const request = (matrix: CompatMatrix, dshVersion: string) => ({
  entry: OFFICIAL_QQBOT_ENTRY,
  matrix,
  dshVersion,
});

/** 断言安装失败并取回错误对象（直接把 catch 结果当 Error 会让类型变成联合）。 */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('预期安装失败，但实际成功');
}

describe('D03 规格产出：与官方 marketInstallTarget 等价位', () => {
  it('npm 源', () => {
    const local = marketInstallTarget('@tencent-connect/dsh-qqbot', {
      version: '0.5.5',
      source: { type: 'npm' },
    });
    const official = officialInstallTarget('@tencent-connect/dsh-qqbot', {
      version: '0.5.5',
      source: { type: 'npm' },
    });
    expect(local).toEqual(official);
  });

  it('npm 源 + registry 覆盖', () => {
    const source = { type: 'npm' as const, registry: 'https://registry.npmmirror.com/' };
    expect(marketInstallTarget('pkg', { version: '1.2.3', source })).toEqual(
      officialInstallTarget('pkg', { version: '1.2.3', source }),
    );
  });

  it('git 源（含子目录）', () => {
    const source = {
      type: 'git' as const,
      url: 'https://github.com/tencent-connect/dsh-qqbot',
      commit: 'a'.repeat(40),
      path: 'packages/plugin',
    };
    expect(marketInstallTarget('pkg', { version: '1.0.0', source })).toEqual(
      officialInstallTarget('pkg', { version: '1.0.0', source }),
    );
  });
});

describe('D03 验收①：非白名单组合在第一步即被拒', () => {
  it('compat 为 unverified → 第 1 步失败，且没有任何安装调用', async () => {
    const addPlugin = vi.fn(async () => undefined);
    await expect(
      installCatalogPlugin(request(UNVERIFIED_MATRIX, '0.2.1-rc.5'), deps({ addPlugin })),
    ).rejects.toThrowError(/第 1 步（compat）失败/);
    expect(addPlugin).not.toHaveBeenCalled();
  });

  it('错误消息指出具体组合与状态', async () => {
    const error = await failureOf(installCatalogPlugin(request(UNVERIFIED_MATRIX, '0.2.1-rc.5'), deps()));
    expect(error.message).toContain('C3-latest');
    expect(error.message).toContain('unverified');
  });
});

describe('D03 验收②：任一步失败可定位，且只重试该步', () => {
  it('第 2 步可重试：两次都失败 → 报第 2 步，且未进入安装', async () => {
    const precheck = vi.fn(async () => {
      throw new Error('磁盘余量不足');
    });
    const addPlugin = vi.fn(async () => undefined);

    const error = await failureOf(
      installCatalogPlugin(request(VERIFIED_MATRIX, '0.2.0-rc.2'), deps({ precheck, addPlugin })),
    );

    expect(error.message).toContain('第 2 步（precheck）失败');
    expect(precheck).toHaveBeenCalledTimes(2);
    expect(addPlugin).not.toHaveBeenCalled();
  });

  it('单源计划下第 5 步瞬时失败会重试该步（attempts=2）', async () => {
    let calls = 0;
    const addPlugin = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ERR_PNPM_FETCH_503 down');
    });

    const outcome = await installCatalogPlugin(
      request(VERIFIED_MATRIX, '0.2.0-rc.2'),
      deps({ addPlugin, plan: [registryPlan()[0]!] }),
    );

    const step = (id: string) => outcome.steps.find((item) => item.id === id);
    expect(step('install')?.attempts).toBe(2);
    expect(step('precheck')?.attempts).toBe(1);
    expect(step('compat')?.attempts).toBe(1);
    expect(addPlugin).toHaveBeenCalledTimes(2);
  });

  it('双源计划下第 5 步换源成功，该步只记 1 次尝试', async () => {
    let calls = 0;
    const addPlugin = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ERR_PNPM_FETCH_503 down');
    });

    const outcome = await installCatalogPlugin(
      request(VERIFIED_MATRIX, '0.2.0-rc.2'),
      deps({ addPlugin }),
    );

    expect(outcome.steps.find((item) => item.id === 'install')?.attempts).toBe(1);
    expect(addPlugin).toHaveBeenCalledTimes(2);
  });

  it('第 6 步失败：版本与 catalog 不一致时拒绝（不允许"装上了就算成功"）', async () => {
    const listPlugins = async (): Promise<PluginState[]> => [
      { name: '@tencent-connect/dsh-qqbot', version: '0.5.4', installed: true },
    ];

    await expect(
      installCatalogPlugin(request(VERIFIED_MATRIX, '0.2.0-rc.2'), deps({ listPlugins })),
    ).rejects.toThrowError(/第 6 步（verify-install）失败/);
  });
});

describe('D03 验收③：registry 不可达时回退到第二源', () => {
  it('镜像 503 → 官方源成功，结果记录实际来源', async () => {
    const seen: string[] = [];
    const addPlugin: PluginInstallDeps['addPlugin'] = async (layer) => {
      seen.push(layer.id);
      if (layer.id === 'l2-npmmirror') throw new Error('ERR_PNPM_FETCH_503 Service Unavailable');
    };

    const outcome = await installCatalogPlugin(
      request(VERIFIED_MATRIX, '0.2.0-rc.2'),
      deps({ addPlugin }),
    );

    expect(seen).toEqual(['l2-npmmirror', 'l3-official']);
    expect(outcome.registry.id).toBe('l3-official');
  });
});

describe('D03 验收④：peerDeps 缺失给出可读原因', () => {
  it('宿主包缺失 → 说明由 Harness 提供且"宿主版本不匹配"', () => {
    const message =
      'ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependencies\nmissing peer @deepseek-ai/dsh-llm@>=0.1.0-rc.6';
    const explanation = explainInstallFailure(message, { name: '@tencent-connect/dsh-qqbot' });
    expect(explanation).toContain('@deepseek-ai/dsh-llm');
    expect(explanation).toContain('宿主');
    expect(explanation).toContain('不匹配');
  });

  it('非 peer 错误不做错误归因（返回 undefined）', () => {
    expect(explainInstallFailure('ERR_PNPM_FETCH_503 down', { name: 'x' })).toBeUndefined();
  });

  it('安装步骤抛 peer 错误时，错误消息包含包名与原因', async () => {
    const addPlugin: PluginInstallDeps['addPlugin'] = async () => {
      throw new Error('ERR_PNPM_PEER_DEP_ISSUES missing peer @deepseek-ai/dsh-agent@>=0.1.0-rc.6');
    };

    const error = await failureOf(
      installCatalogPlugin(request(VERIFIED_MATRIX, '0.2.0-rc.2'), deps({ addPlugin })),
    );

    expect(error.message).toContain('@deepseek-ai/dsh-agent');
    expect(error.message).toContain('宿主版本与插件不匹配');
  });
});

describe('D03 验收⑤：成功路径与证据等级', () => {
  it('成功时前 6 步 succeeded，7–9 步缺证据记 unverified（不得伪造成功）', async () => {
    const outcome = await installCatalogPlugin(request(VERIFIED_MATRIX, '0.2.0-rc.2'), deps());

    const status = (id: string) => outcome.steps.find((item) => item.id === id)?.status;
    expect(outcome.spec).toBe('@tencent-connect/dsh-qqbot@0.5.5');
    expect(status('compat')).toBe('succeeded');
    expect(status('verify-install')).toBe('succeeded');
    expect(status('verify-load')).toBe('unverified');
    expect(status('config')).toBe('unverified');
    expect(status('connectivity')).toBe('unverified');
    expect(outcome.connectivity).toBe('unverified');
  });

  it('提供 dump-config / 配置自检 / 连通探测时逐项落到证据上', async () => {
    const outcome = await installCatalogPlugin(
      request(VERIFIED_MATRIX, '0.2.0-rc.2'),
      deps({
        dumpConfig: async () =>
          "- id: im-qqbot\n  name: '@tencent-connect/dsh-qqbot'\n  config:\n    appId: __FROM_ENV__\n",
        checkConfig: async () => [],
        probeConnectivity: async () => ({ verified: false, detail: '真实收发未验证' }),
      }),
    );

    const status = (id: string) => outcome.steps.find((item) => item.id === id)?.status;
    expect(status('verify-load')).toBe('succeeded');
    expect(status('config')).toBe('succeeded');
    expect(outcome.connectivity).toBe('unverified');
    expect(outcome.connectivityDetail).toContain('未验证');
  });

  it('dump-config 中该插件为 disabled → 第 7 步失败', async () => {
    await expect(
      installCatalogPlugin(
        request(VERIFIED_MATRIX, '0.2.0-rc.2'),
        deps({
          dumpConfig: async () =>
            "- id: im-qqbot\n  name: '@tencent-connect/dsh-qqbot'\n  disabled: true\n",
        }),
      ),
    ).rejects.toThrowError(/第 7 步（verify-load）失败/);
  });
});
