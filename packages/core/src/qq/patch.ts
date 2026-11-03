import { DEFAULT_QQ_ACCESS, DEFAULT_QQ_SETTINGS, type QqCredentialMode, type QqSettings } from '@dda/spec';

import { parseComposedDump } from '../api/verify';
import {
  applyManagedSection,
  QQ_MANAGED_SECTION,
  removeManagedSection,
  type ManagedPatchEntry,
} from '../api/harness-patch';

/**
 * `im-qqbot` is inserted by the plugin's own bundle patch with `appId: __FROM_ENV__`.
 * Our profile-layer entry overrides it — and **replacing an entry replaces its whole `config`**
 * (verified with `--dump-config`: any key we omit disappears), so every field we care about must be
 * written explicitly. Otherwise settings silently fall back to schema defaults (e.g. streaming=true).
 */
export const QQ_ENTRY_ID = 'im-qqbot';
export const QQ_PLUGIN_NAME = '@tencent-connect/dsh-qqbot';
/** The plugin resolves these names through `resolveEnv()`; values never touch disk. */
export const QQ_APPID_ENV = 'QQBOT_APPID';
export const QQ_SECRET_ENV = 'QQBOT_SECRET';
export const QQ_ENV_PLACEHOLDER = '__FROM_ENV__';

export interface QqEntryContext {
  /**
   * `env` → appId/appSecret 写成 `__FROM_ENV__`，真实值由启动环境注入（我们的 DPAPI 方案）；
   * `qr`  → 两个字段整体省略，让插件走官方扫码（插件成功后自己写回 profile）。
   */
  mode: QqCredentialMode;
  /** qr 模式且插件已写入真实凭据时原样保留，避免我们下一次保存把它们抹掉。 */
  preserved?: { appId?: string; appSecret?: string };
}

function normalizeList(list: string[]): string[] {
  return list.map((item) => item.trim()).filter((item) => item.length > 0);
}

export function buildQqEntry(settings: QqSettings, context: QqEntryContext): ManagedPatchEntry {
  const config: Record<string, unknown> = {};

  if (context.mode === 'env') {
    config.appId = QQ_ENV_PLACEHOLDER;
    config.appSecret = QQ_ENV_PLACEHOLDER;
  } else {
    // Preserve what the official QR flow wrote (never invent values).
    if (context.preserved?.appId) config.appId = context.preserved.appId;
    if (context.preserved?.appSecret) config.appSecret = context.preserved.appSecret;
  }

  const merged: QqSettings = {
    ...DEFAULT_QQ_SETTINGS,
    ...settings,
    access: { ...DEFAULT_QQ_ACCESS, ...settings.access },
  };
  config.requireMention = merged.requireMention;
  if (merged.groupPrompt?.trim()) config.groupPrompt = merged.groupPrompt.trim();
  if (merged.directPrompt?.trim()) config.directPrompt = merged.directPrompt.trim();
  config.streaming = merged.streaming;
  config.textChunkLimit = merged.textChunkLimit;
  config.historyLimit = merged.historyLimit;
  config.access = {
    c2cMode: merged.access.c2cMode,
    c2cAllow: normalizeList(merged.access.c2cAllow),
    groupMode: merged.access.groupMode,
    groupAllow: normalizeList(merged.access.groupAllow),
  };
  // 视觉理解（vision）默认关闭且需要另配视觉模型，本轮不开放（决策 D5）。
  config.media = { enabled: merged.mediaEnabled };
  config.sendFile = { restrictPaths: merged.sendFileRestrictPaths };

  return { id: QQ_ENTRY_ID, config };
}

export function applyQqSection(existing: string, settings: QqSettings, context: QqEntryContext): string {
  return applyManagedSection(existing, [buildQqEntry(settings, context)], QQ_MANAGED_SECTION);
}

export function removeQqSection(existing: string): string {
  return removeManagedSection(existing, QQ_MANAGED_SECTION);
}

interface RawEntry {
  id?: unknown;
  config?: unknown;
}

/** Reads the `im-qqbot` entry out of a patch layer **or** a composed dump (`!!js` tolerant). */export function readQqEntry(text: string): { present: boolean; config: Record<string, unknown> } {
  const entries = parseComposedDump(text);
  if (!entries) return { present: false, config: {} };
  // Later entries win in Harness' patch semantics, so the last match is the effective one.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const raw = entries[index]!;
    if (raw.id === QQ_ENTRY_ID) {
      const config =
        raw.config != null && typeof raw.config === 'object' ? (raw.config as Record<string, unknown>) : {};
      return { present: true, config };
    }
  }
  return { present: false, config: {} };
}

export interface QqStoredCredentials {
  appId?: string;
  appSecret?: string;
  /** True when the plugin (QR flow) left a literal secret in the profile file. */
  plaintext: boolean;
}

const isPlaceholder = (value: unknown): boolean =>
  typeof value !== 'string' || value.length === 0 || value === QQ_ENV_PLACEHOLDER || value.startsWith('process.env');

export function readStoredCredentials(text: string): QqStoredCredentials {
  const { config } = readQqEntry(text);
  const literalId = typeof config.appId === 'string' && !isPlaceholder(config.appId) ? config.appId : undefined;
  const literalSecret =
    typeof config.appSecret === 'string' && !isPlaceholder(config.appSecret) ? config.appSecret : undefined;
  return { appId: literalId, appSecret: literalSecret, plaintext: Boolean(literalId && literalSecret) };
}

/** Settings currently saved in the patch layer, falling back to plugin defaults. */
export function readQqSettings(text: string): QqSettings {
  const { config } = readQqEntry(text);
  const access = (config.access ?? {}) as Record<string, unknown>;
  const media = (config.media ?? {}) as Record<string, unknown>;
  const sendFile = (config.sendFile ?? {}) as Record<string, unknown>;
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const mode = (value: unknown, fallback: 'open' | 'allowlist' | 'disabled'): 'open' | 'allowlist' | 'disabled' =>
    value === 'open' || value === 'allowlist' || value === 'disabled' ? value : fallback;

  return {
    requireMention: bool(config.requireMention, DEFAULT_QQ_SETTINGS.requireMention),
    groupPrompt: str(config.groupPrompt),
    directPrompt: str(config.directPrompt),
    streaming: bool(config.streaming, DEFAULT_QQ_SETTINGS.streaming),
    textChunkLimit: num(config.textChunkLimit, DEFAULT_QQ_SETTINGS.textChunkLimit),
    historyLimit: num(config.historyLimit, DEFAULT_QQ_SETTINGS.historyLimit),
    access: {
      c2cMode: mode(access.c2cMode, DEFAULT_QQ_SETTINGS.access.c2cMode),
      c2cAllow: list(access.c2cAllow),
      groupMode: mode(access.groupMode, DEFAULT_QQ_SETTINGS.access.groupMode),
      groupAllow: list(access.groupAllow),
    },
    mediaEnabled: bool(media.enabled, DEFAULT_QQ_SETTINGS.mediaEnabled),
    sendFileRestrictPaths: bool(sendFile.restrictPaths, DEFAULT_QQ_SETTINGS.sendFileRestrictPaths),
  };
}
