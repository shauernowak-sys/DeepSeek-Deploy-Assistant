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
import type { CompatMatrix, MarketInstallProgressEvent, PluginState } from '@dda/spec';

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
    expect(outcome.registry?.id).toBe('l3-official');
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

describe('D06 tarball host 记录进入安装结果', () => {
  it('从 dsh 输出统计 host，并写进步骤明细与 outcome', async () => {
    const addPlugin: PluginInstallDeps['addPlugin'] = async () =>
      [
        'https://registry.npmmirror.com/@tencent-connect/dsh-qqbot/-/dsh-qqbot-0.5.5.tgz',
        'https://registry.npmmirror.com/yaml/-/yaml-2.8.1.tgz',
        'https://registry.npmjs.org/@tencent-connect/qqbot-connector/-/qqbot-connector-1.2.0.tgz',
      ].join('\n');

    const outcome = await installCatalogPlugin(
      request(VERIFIED_MATRIX, '0.2.0-rc.2'),
      deps({ addPlugin }),
    );

    expect(outcome.tarballHosts.total).toBe(3);
    expect(outcome.tarballHosts.hosts).toEqual([
      { host: 'registry.npmmirror.com', count: 2 },
      { host: 'registry.npmjs.org', count: 1 },
    ]);
    expect(outcome.steps.find((item) => item.id === 'install')?.detail).toContain('registry.npmjs.org');
  });
});

describe('D07/D08 版本切换与备份（同版本 / 降级 / 升级）', () => {
  it('同版本 → 不发起任何安装调用，也不进 registry 流程', async () => {
    const addPlugin = vi.fn(async () => '');
    const outcome = await installCatalogPlugin(
      { ...request(VERIFIED_MATRIX, '0.2.0-rc.2'), installedVersion: '0.5.5' },
      deps({ addPlugin }),
    );

    expect(outcome.action).toBe('none');
    expect(outcome.steps).toEqual([]);
    expect(addPlugin).not.toHaveBeenCalled();
  });

  it('降级未确认 → 拒绝，错误含"当前 → 目标"，且没有任何安装动作', async () => {
    const addPlugin = vi.fn(async () => '');
    const error = await failureOf(
      installCatalogPlugin(
        { ...request(VERIFIED_MATRIX, '0.2.0-rc.2'), installedVersion: '0.5.6' },
        deps({ addPlugin }),
      ),
    );

    expect((error as { code?: string }).code).toBe('E_DECISION_UNCONFIRMED');
    expect(error.message).toContain('0.5.6');
    expect(error.message).toContain('0.5.5');
    expect(addPlugin).not.toHaveBeenCalled();
  });

  it('升级 → 先备份、再卸载、最后安装，结果记录 action 与备份目录', async () => {
    const events: string[] = [];
    const outcome = await installCatalogPlugin(
      { ...request(VERIFIED_MATRIX, '0.2.0-rc.2'), installedVersion: '0.5.4' },
      deps({
        backupProfile: async () => {
          events.push('backup');
          return 'C:/state/backups/plugin-x';
        },
        removePlugin: async () => {
          events.push('remove');
        },
        addPlugin: async () => {
          events.push('add');
          return '';
        },
      }),
    );

    expect(outcome.action).toBe('upgrade');
    expect(outcome.backupDir).toBe('C:/state/backups/plugin-x');
    expect(events).toEqual(['backup', 'remove', 'add']);
  });

  it('缺少备份/卸载能力时拒绝做版本切换（不允许无备份 remove+add）', async () => {
    const error = await failureOf(
      installCatalogPlugin(
        { ...request(VERIFIED_MATRIX, '0.2.0-rc.2'), installedVersion: '0.5.4' },
        deps({ backupProfile: undefined, removePlugin: undefined }),
      ),
    );

    expect(error.message).toContain('缺少 profile 备份或卸载能力');
  });

  it('安装步骤重试时备份只做一次、卸载只做一次', async () => {
    let installCalls = 0;
    const backup = vi.fn(async () => 'C:/state/backups/plugin-once');
    const remove = vi.fn(async () => undefined);

    await installCatalogPlugin(
      { ...request(VERIFIED_MATRIX, '0.2.0-rc.2'), installedVersion: '0.5.4' },
      deps({
        backupProfile: backup,
        removePlugin: remove,
        addPlugin: async () => {
          installCalls += 1;
          if (installCalls === 1) throw new Error('ERR_PNPM_FETCH_503 down');
          return '';
        },
        plan: [registryPlan()[0]!],
      }),
    );

    expect(backup).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(installCalls).toBe(2);
  });
});

describe('D05 离线安装（D03 本地模式）', () => {
  it('提供 localSpec 时跳过 registry，直接装本地 tgz', async () => {
    const addPlugin = vi.fn(async () => '');
    const installLocal = vi.fn(async () => '');
    const outcome = await installCatalogPlugin(
      { ...request(VERIFIED_MATRIX, '0.2.0-rc.2'), localSpec: 'C:/cache/plugin-0.5.5.tgz' },
      deps({ addPlugin, installLocal }),
    );

    expect(outcome.installSource).toBe('local-file');
    expect(outcome.spec).toBe('C:/cache/plugin-0.5.5.tgz');
    expect(outcome.registry).toBeUndefined();
    expect(addPlugin).not.toHaveBeenCalled();
    expect(installLocal).toHaveBeenCalledTimes(1);
    expect(outcome.steps.find((step) => step.id === 'registry')?.status).toBe('skipped');
  });

  it('离线模式缺少 installLocal → 第 5 步失败', async () => {
    await expect(
      installCatalogPlugin(
        { ...request(VERIFIED_MATRIX, '0.2.0-rc.2'), localSpec: 'C:/cache/plugin-0.5.5.tgz' },
        deps(),
      ),
    ).rejects.toThrowError(/第 5 步（install）失败/);
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

  it('真实进度事件按步骤与实际来源发出，且不携带命令输出', async () => {
    const events: MarketInstallProgressEvent[] = [];
    await installCatalogPlugin(
      request(VERIFIED_MATRIX, '0.2.0-rc.2'),
      deps({ onProgress: (event) => events.push(event) }),
    );

    expect(events[0]?.phase).toBe('starting');
    const stepIndexes = events
      .filter((event) => event.phase === 'step')
      .map((event) => event.step?.index);
    expect(stepIndexes).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]));
    expect(
      events.some((event) => event.phase === 'source' && event.source?.label === '国内镜像 npmmirror'),
    ).toBe(true);
    expect(events.some((event) => event.phase === 'source' && event.source?.ok === true)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/stdout|stderr|token|secret/i);
  });

  it('提供 dump-config / 配置自检 / 连通探测时逐项落到证据上', async () => {
    const outcome = await installCatalogPlugin(
      request(VERIFIED_MATRIX, '0.2.0-rc.2'),
      deps({
        dumpConfig: async () =>
          "- id: im-qqbot\n  name: '@tencent-connect/dsh-qqbot'\n  config:\n    appId: __FROM_ENV__\n",
        checkConfig: async () => ({ configured: true, problems: [] }),
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

  it('首次安装还没配置：第 8 步不判失败，但明确记录「尚未配置」', async () => {
    const outcome = await installCatalogPlugin(
      request(VERIFIED_MATRIX, '0.2.0-rc.2'),
      deps({
        dumpConfig: async () => "- id: im-qqbot\n  name: '@tencent-connect/dsh-qqbot'\n",
        checkConfig: async () => ({ configured: false, problems: [] }),
      }),
    );
    const config = outcome.steps.find((item) => item.id === 'config');
    expect(config?.status).toBe('succeeded');
    expect(config?.detail).toContain('尚未配置');
  });

  it('已经配置但字段不合法：第 8 步失败并带出原因', async () => {
    await expect(
      installCatalogPlugin(
        request(VERIFIED_MATRIX, '0.2.0-rc.2'),
        deps({
          dumpConfig: async () => "- id: im-qqbot\n  name: '@tencent-connect/dsh-qqbot'\n",
          checkConfig: async () => ({ configured: true, problems: ['缺少 access 配置'] }),
        }),
      ),
    ).rejects.toThrowError(/第 8 步（config）失败：缺少 access 配置/);
  });
});
