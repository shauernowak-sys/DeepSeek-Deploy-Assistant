import { describe, expect, it } from 'vitest';

import { verifyComposedConfig, type ExpectedRoute } from '@dda/core';

/** Trimmed from a real `dsh --profile web --dump-config` (the `!!js` tags must not break parsing). */
const DUMP = `# == @deepseek-ai/dsh-base
- id: llm
  name: '@deepseek-ai/dsh-llm'
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      dda-custom:
        displayName: My Gateway
        api: openai-completions
        baseURL: https://gateway.example.com/v1
        apiKeyEnv: DDA_GATEWAY_KEY
        models:
          - id: gw-model-a
            name: My Gateway
            contextWindow: 131072
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: dda-custom
    model: gw-model-a
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    enabled: !!js process.env.DSH_TOOLS_MODE
`;

const customExpected: ExpectedRoute = {
  provider: 'dda-custom',
  model: 'gw-model-a',
  baseUrl: 'https://gateway.example.com/v1',
  apiKeyEnv: 'DDA_GATEWAY_KEY',
};

describe('dump-config 回读校验', () => {
  it('结构化解析：自定义路由与默认模型都匹配', () => {
    const result = verifyComposedConfig(DUMP, customExpected);
    expect(result.method).toBe('structured');
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('默认模型被其他配置覆盖时报错', () => {
    const result = verifyComposedConfig(DUMP, { ...customExpected, provider: 'deepseek-official', model: 'deepseek-flash' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/默认 provider/);
  });

  it('路由缺少模型条目时报错', () => {
    const result = verifyComposedConfig(DUMP, { ...customExpected, model: 'gw-model-b' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/gw-model-b/);
  });

  it('apiKeyEnv 不匹配时报错', () => {
    const result = verifyComposedConfig(DUMP, { ...customExpected, apiKeyEnv: 'OTHER_KEY' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/apiKeyEnv/);
  });

  it('DeepSeek 官方路由：校验 llm-deepseek 配置', () => {
    const dump = `- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
`;
    const result = verifyComposedConfig(dump, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com/anthropic/',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('输出无法解析时退回文本校验（仍能发现缺失）', () => {
    const broken = 'provider: dda-custom\nmodel: gw-model-a\n';
    const ok = verifyComposedConfig(broken, customExpected);
    expect(ok.method).toBe('textual');
    expect(ok.ok).toBe(false);
    expect(ok.problems.join(' ')).toMatch(/apiKeyEnv/);

    const textualHit = verifyComposedConfig(
      'provider: dda-custom\nmodel: gw-model-a\napiKeyEnv: DDA_GATEWAY_KEY\n',
      customExpected,
    );
    expect(textualHit.method).toBe('textual');
    expect(textualHit.ok).toBe(true);
  });
});
