import { parseComposedDump } from '../api/verify';
import { applyManagedSection, managedSection, type ManagedPatchEntry } from '../api/harness-patch';

import { REGISTRY_NPMMIRROR, REGISTRY_OFFICIAL } from './registries';

/**
 * P-8：把 registry 计划写成 Harness 自己的配置，而不是只靠 `npm_config_registry`。
 *
 * Harness 插件管理服务只有在「pnpm 自身 registry 是官方源，或在 fallback 列表里」时才把它
 * 算进计划；我们把 pnpm 固定到镜像后，它的默认 fallback（也是镜像）等于没有兜底。
 * 因此显式写：`registry = npmmirror`、`fallbackRegistries = [npmjs]` → 计划为「镜像 → 官方」。
 *
 * 这段配置只影响**插件**的查询与安装（plugin-manager 条目），不影响本软件的其它下载。
 */
export const PLUGIN_MANAGER_ENTRY_ID = 'plugin-manager';
export const REGISTRY_MANAGED_SECTION = 'registry';

export function buildPluginManagerEntry(): ManagedPatchEntry {
  return {
    id: PLUGIN_MANAGER_ENTRY_ID,
    config: {
      registry: REGISTRY_NPMMIRROR,
      fallbackRegistries: [REGISTRY_OFFICIAL],
    },
  };
}

export function applyRegistrySection(existing: string): string {
  return applyManagedSection(existing, [buildPluginManagerEntry()], REGISTRY_MANAGED_SECTION);
}

export function removeRegistrySection(existing: string): string {
  const section = managedSection(REGISTRY_MANAGED_SECTION);
  const start = existing.indexOf(section.begin);
  if (start < 0) return existing;
  const end = existing.indexOf(section.end, start);
  if (end < 0) return existing;
  const before = existing.slice(0, start).trimEnd();
  const after = existing.slice(end + section.end.length).trimStart();
  if (before === '' && after === '') return '[]\n';
  return `${before}\n${after}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export interface PluginManagerRegistryConfig {
  present: boolean;
  registry?: string;
  fallbackRegistries: string[];
}

/** 读回配置（用于部署后自检 / 诊断），不假设文件里只有我们的块。 */
export function readPluginManagerRegistry(patchText: string): PluginManagerRegistryConfig {
  const entries = parseComposedDump(patchText);
  if (!entries) return { present: false, fallbackRegistries: [] };

  // 后写的条目覆盖先写的，取最后一条。
  const found = [...entries].reverse().find((entry) => entry.id === PLUGIN_MANAGER_ENTRY_ID);
  if (found === undefined) return { present: false, fallbackRegistries: [] };

  const config = (found.config ?? {}) as { registry?: unknown; fallbackRegistries?: unknown };
  const fallbackRegistries = Array.isArray(config.fallbackRegistries)
    ? config.fallbackRegistries.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    present: true,
    ...(typeof config.registry === 'string' ? { registry: config.registry } : {}),
    fallbackRegistries,
  };
}

/** 回退是否真正生效：镜像在集合里，且官方源作为兜底存在。 */
export function isRegistryFallbackConfigured(config: PluginManagerRegistryConfig): boolean {
  if (!config.present) return false;
  const normalize = (url: string): string => (url.endsWith('/') ? url : `${url}/`);
  const registry = config.registry === undefined ? undefined : normalize(config.registry);
  const fallbacks = config.fallbackRegistries.map(normalize);
  return registry === REGISTRY_NPMMIRROR && fallbacks.includes(REGISTRY_OFFICIAL);
}
