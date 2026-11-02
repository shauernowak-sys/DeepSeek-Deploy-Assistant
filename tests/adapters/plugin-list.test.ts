import { describe, expect, it } from 'vitest';

import { parsePluginList } from '@dda/adapters';
import { mask } from '../../apps/desktop/src/main/security/secrets';

/** Real output shape captured in M0 (logs/05-plugin-list.log). */
const SAMPLE = `Legend: production dependency, optional only, dev only

dsh-profile-web C:\\dda-m0-lab\\dsh-home-c\\profiles\\web (PRIVATE)
│
│   dependencies:
└── @tencent-connect/dsh-qqbot@0.5.5

1 package
`;

describe('parsePluginList', () => {
  it('解析 pnpm 依赖树中的顶层插件', () => {
    const plugins = parsePluginList(SAMPLE);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe('@tencent-connect/dsh-qqbot');
    expect(plugins[0]?.version).toBe('0.5.5');
    expect(plugins[0]?.installed).toBe(true);
  });

  it('空输出 / 未安装时不伪造已安装', () => {
    expect(parsePluginList('')).toEqual([]);
    expect(parsePluginList('No dependencies')).toEqual([]);
  });

  it('忽略缩进子依赖行，只取顶层', () => {
    const nested = `└── @tencent-connect/dsh-qqbot@0.5.5
    └── qrcode@1.5.4
`;
    const plugins = parsePluginList(nested);
    expect(plugins.map((p) => p.name)).toEqual(['@tencent-connect/dsh-qqbot']);
  });
});

describe('secret mask', () => {
  it('不泄露完整密钥', () => {
    expect(mask('sk-1234567890abcdef')).toBe('sk-****cdef');
    expect(mask('short')).toBe('****');
  });
});
