import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertPluginInstallAllowed, loadMatrix, parseExactPluginSpec } from '@dda/core';
import { PERSONAL_QQ_ADAPTER } from '@dda/spec';

const MANIFESTS = join(__dirname, '..', '..', 'apps', 'desktop', 'resources', 'manifests');
const OFFICIAL_SPEC = '@tencent-connect/dsh-qqbot@0.5.5';

async function matrix() {
  return loadMatrix(JSON.parse(await readFile(join(MANIFESTS, 'compat.json'), 'utf8')));
}

describe('P-10 安装入口收敛：只接受精确 name@version', () => {
  it('解析精确 spec', () => {
    expect(parseExactPluginSpec(OFFICIAL_SPEC)).toEqual({
      name: '@tencent-connect/dsh-qqbot',
      version: '0.5.5',
    });
  });

  it.each([
    '@tencent-connect/dsh-qqbot', // 无版本
    '@tencent-connect/dsh-qqbot@latest', // latest
    '@tencent-connect/dsh-qqbot@^0.5.0', // 范围
    '@tencent-connect/dsh-qqbot@0.5.x', // 范围
    'github:tencent-connect/dsh-qqbot', // git
    './local-plugin', // 本地路径
    '@tencent-connect/dsh-qqbot@0.5.5 --registry=https://evil.invalid', // 注入额外参数
  ])('拒绝 %s', (spec) => {
    expect(() => parseExactPluginSpec(spec)).toThrowError(/精确/);
  });
});

describe('P-10 安装入口收敛：允许清单 + compat 组合', () => {
  it('官方插件命中 verified-local 组合时放行', async () => {
    const target = assertPluginInstallAllowed({
      matrix: await matrix(),
      spec: OFFICIAL_SPEC,
      dshVersion: '0.2.0-rc.2',
      catalogSpecs: [OFFICIAL_SPEC],
    });
    expect(target.version).toBe('0.5.5');
  });

  it('非白名单版本组合被拒（即使格式正确）', async () => {
    expect(() =>
      assertPluginInstallAllowed({
        matrix: JSON.parse('{"schemaVersion":1,"entries":[]}'),
        spec: OFFICIAL_SPEC,
        dshVersion: '0.2.0-rc.2',
        catalogSpecs: [OFFICIAL_SPEC],
      }),
    ).toThrowError(/组合未列入白名单/);
  });

  it('未列入 catalog 的 spec 被拒（P-10 的原始漏洞）', async () => {
    expect(() =>
      assertPluginInstallAllowed({
        matrix: JSON.parse('{"schemaVersion":1,"entries":[]}'),
        spec: '@tencent-connect/dsh-qqbot@0.5.4',
        dshVersion: '0.2.0-rc.2',
        catalogSpecs: [OFFICIAL_SPEC],
      }),
    ).toThrowError(/不在允许清单内/);
  });

  it('适配插件只在显式适配白名单内放行（不受 compat 矩阵约束）', async () => {
    expect(() =>
      assertPluginInstallAllowed({
        matrix: JSON.parse('{"schemaVersion":1,"entries":[]}'),
        spec: PERSONAL_QQ_ADAPTER.spec,
        dshVersion: '0.2.0-rc.2',
        catalogSpecs: [OFFICIAL_SPEC],
      }),
    ).toThrowError(/不在允许清单内/);

    expect(() =>
      assertPluginInstallAllowed({
        matrix: JSON.parse('{"schemaVersion":1,"entries":[]}'),
        spec: PERSONAL_QQ_ADAPTER.spec,
        dshVersion: '0.2.0-rc.2',
        catalogSpecs: [OFFICIAL_SPEC],
        adapterSpecs: [PERSONAL_QQ_ADAPTER.spec],
      }),
    ).not.toThrow();
  });
});
