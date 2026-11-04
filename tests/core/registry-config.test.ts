import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  REGISTRY_NPMMIRROR,
  REGISTRY_OFFICIAL,
  applyRegistrySection,
  isRegistryFallbackConfigured,
  readPluginManagerRegistry,
  removeRegistrySection,
} from '@dda/core';

const USER_PATCH = `# 用户自己的配置，不能被我们删掉
- id: im-qqbot
  config:
    requireMention: true
`;

describe('P-8 把 registry 计划写进 profile 配置', () => {
  it('写入 plugin-manager 条目：镜像为 registry，官方源为兜底', () => {
    const next = applyRegistrySection('[]\n');
    const entries = loadYaml(next) as Array<{ id: string; config?: Record<string, unknown> }>;
    const manager = entries.find((entry) => entry.id === 'plugin-manager');
    expect(manager?.config).toMatchObject({
      registry: REGISTRY_NPMMIRROR,
      fallbackRegistries: [REGISTRY_OFFICIAL],
    });
  });

  it('重复写入是幂等的（部署可重跑）', () => {
    const once = applyRegistrySection('[]\n');
    const twice = applyRegistrySection(once);
    expect(twice).toBe(once);
  });

  it('不破坏用户自己的条目与注释', () => {
    const next = applyRegistrySection(USER_PATCH);
    expect(next).toContain('# 用户自己的配置，不能被我们删掉');
    const entries = loadYaml(next) as Array<{ id: string }>;
    expect(entries.map((entry) => entry.id)).toEqual(['im-qqbot', 'plugin-manager']);
  });

  it('能回读并判定"兜底已生效"', () => {
    const next = applyRegistrySection('[]\n');
    const config = readPluginManagerRegistry(next);
    expect(config.present).toBe(true);
    expect(config.registry).toBe(REGISTRY_NPMMIRROR);
    expect(config.fallbackRegistries).toEqual([REGISTRY_OFFICIAL]);
    expect(isRegistryFallbackConfigured(config)).toBe(true);
  });

  it('只有 registry、没有官方兜底时判为未生效（这正是 P-8 的现网状态）', () => {
    const broken = `- id: plugin-manager
  config:
    registry: ${REGISTRY_NPMMIRROR}
    fallbackRegistries:
      - ${REGISTRY_NPMMIRROR}
`;
    expect(isRegistryFallbackConfigured(readPluginManagerRegistry(broken))).toBe(false);
  });

  it('移除后回到合法空配置，用户条目保留', () => {
    const applied = applyRegistrySection(USER_PATCH);
    const removed = removeRegistrySection(applied);
    expect(removed).not.toContain('plugin-manager');
    expect(removed).toContain('im-qqbot');
    expect(() => loadYaml(removed)).not.toThrow();
  });
});
