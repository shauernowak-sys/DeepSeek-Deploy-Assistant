import { describe, expect, it } from 'vitest';

import {
  applyManagedBlock,
  buildManagedEntries,
  DEEPSEEK_TEMPLATE,
  hasManagedBlock,
  MANAGED_BEGIN,
  MANAGED_END,
  providerRouteOf,
  removeManagedBlock,
  type ApiProviderConfig,
} from '@dda/core';

const DEFAULT_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

const custom: ApiProviderConfig = {
  template: 'openai-compatible',
  label: 'My Gateway',
  protocol: 'openai-completions',
  baseUrl: 'https://gateway.example.com/v1',
  model: 'gw-model-a',
  credentialRef: 'DDA_GATEWAY_KEY',
  contextWindow: 131072,
};

describe('Harness patch：DeepSeek 官方模板', () => {
  it('生成 dsh 实际接受的字段（llm-deepseek + agent-default-model）', () => {
    const entries = buildManagedEntries(DEEPSEEK_TEMPLATE);
    expect(entries.map((e) => e.id)).toEqual(['llm-deepseek', 'agent-default-model']);
    expect(entries[0]!.config).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com/anthropic',
    });
    expect(entries[1]!.config).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' });
    expect(providerRouteOf(DEEPSEEK_TEMPLATE)).toBe('deepseek-official');
  });
});

describe('Harness patch：OpenAI 兼容网关', () => {
  it('生成 llm-pi-ai 路由（api/baseURL/apiKeyEnv/models）', () => {
    const entries = buildManagedEntries(custom);
    expect(entries.map((e) => e.id)).toEqual(['llm-pi-ai', 'agent-default-model']);
    const providers = (entries[0]!.config as { providers: Record<string, Record<string, unknown>> }).providers;
    expect(providers['dda-custom']).toEqual({
      displayName: 'My Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.example.com/v1',
      apiKeyEnv: 'DDA_GATEWAY_KEY',
      models: [{ id: 'gw-model-a', name: 'My Gateway', contextWindow: 131072 }],
    });
    expect(entries[1]!.config).toEqual({ provider: 'dda-custom', model: 'gw-model-a' });
  });
});

describe('Harness patch：写入与移除', () => {
  it('默认 [] 文件：保留注释，只替换空数组标记', () => {
    const out = applyManagedBlock(DEFAULT_PATCH, DEEPSEEK_TEMPLATE);
    expect(out).toContain('# Your patch layer for this dsh profile');
    expect(out).not.toMatch(/^\[\]$/m);
    expect(out).toContain(MANAGED_BEGIN);
    expect(out).toContain(MANAGED_END);
    expect(out).toContain('provider: deepseek-official');
    expect(hasManagedBlock(out)).toBe(true);
  });

  it('用户已有条目：追加而不是覆盖', () => {
    const userPatch = '- id: my-plugin\n  config:\n    foo: bar\n';
    const out = applyManagedBlock(userPatch, custom);
    expect(out).toContain('- id: my-plugin');
    expect(out).toContain('foo: bar');
    expect(out).toContain('dda-custom');
    const topLevelIds = out.match(/^- id: /gm) ?? [];
    expect(topLevelIds.length).toBe(3);
  });

  it('重复写入幂等：块被替换而不是叠加', () => {
    const once = applyManagedBlock(DEFAULT_PATCH, DEEPSEEK_TEMPLATE);
    const twice = applyManagedBlock(once, custom);
    expect((twice.match(/dda:managed:begin/g) ?? []).length).toBe(1);
    expect(twice).toContain('dda-custom');
    expect(twice).not.toContain('provider: deepseek-official');
  });

  it('移除后仍是合法的空数组补丁', () => {
    const written = applyManagedBlock(DEFAULT_PATCH, custom);
    const removed = removeManagedBlock(written);
    expect(removed).not.toContain('dda-custom');
    expect(removed).not.toContain('dda:managed');
    expect(removed.trimEnd().endsWith('[]')).toBe(true);
  });

  it('顶层不是数组时拒绝写入（避免破坏用户配置）', () => {
    expect(() => applyManagedBlock('foo: bar\n', custom)).toThrow(/数组/);
  });
});
