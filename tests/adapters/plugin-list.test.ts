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

  it('FORCE_COLOR 时去掉颜色码，仍只认顶层插件', () => {
    // 2026-11-08 实机：FORCE_COLOR=1 时 pnpm 把 SGR 插在树形符和版本号两侧。
    const colored = [
      'Legend: production dependency, \u001b[34moptional only\u001b[39m, \u001b[33mdev only\u001b[39m',
      '',
      '\u001b[1mdsh-profile-web \u001b[2mC:\\\\somewhere\\profiles\\web\u001b[22m (PRIVATE)',
      '\u001b[2m│\u001b[22m',
      '\u001b[2m│   \u001b[22m\u001b[96mdependencies:\u001b[39m',
      '\u001b[2m└── \u001b[22m@tencent-connect/dsh-qqbot\u001b[90m@0.5.5\u001b[39m',
      '    \u001b[2m└── \u001b[22mqrcode\u001b[90m@1.5.4\u001b[39m',
      '\u001b[2m├── \u001b[22m@deepseek-ai/dsh-llm\u001b[90m@0.1.0-rc.6\u001b[39m',
      '',
      '\u001b[2m2 packages\u001b[22m',
    ].join('\n');
    const plugins = parsePluginList(colored);
    expect(plugins.map((plugin) => `${plugin.name}@${plugin.version}`)).toEqual([
      '@tencent-connect/dsh-qqbot@0.5.5',
      '@deepseek-ai/dsh-llm@0.1.0-rc.6',
    ]);
  });
});

describe('secret mask', () => {
  it('不泄露完整密钥', () => {
    expect(mask('sk-1234567890abcdef')).toBe('sk-****cdef');
    expect(mask('short')).toBe('****');
  });
});
