import { dump as dumpYaml, load as loadYaml } from 'js-yaml';

import { normalizeBaseUrl, PROVIDER_ROUTE_ID, type ApiProviderConfig } from './types';

/**
 * Writes the provider route into the profile's user patch layer
 * (`$DSH_HOME/profiles/<name>/cordis.patch.yml`) — the documented place where the Harness
 * settings UI persists changes ("普通配置仍通过 Cordis 配置文件编辑").
 *
 * Rules honoured here:
 *  - never rewrite the user's own entries or comments (the block is appended / replaced in place);
 *  - a later entry with the same id wins, which is verified Harness behaviour (`--dump-config`);
 *  - removal leaves the file valid even when it was an empty `[]` array before.
 */
export const MANAGED_BEGIN = '# >>> dda:managed:begin  (DeepSeek Deploy Assistant 写入，请勿手工修改)';
export const MANAGED_END = '# <<< dda:managed:end';

const DUMP_OPTIONS = { lineWidth: -1, noRefs: true, quotingType: '"' as const };

export interface ManagedPatchEntry {
  id: string;
  config: Record<string, unknown>;
}

/** The exact loader entries we need for a given provider configuration. */
export function buildManagedEntries(config: ApiProviderConfig): ManagedPatchEntry[] {
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  if (config.template === 'deepseek') {
    return [
      {
        id: 'llm-deepseek',
        config: {
          apiKeyEnv: config.credentialRef,
          baseURL: baseUrl,
        },
      },
      {
        id: 'agent-default-model',
        config: { provider: 'deepseek-official', model: config.model },
      },
    ];
  }

  return [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          [PROVIDER_ROUTE_ID]: {
            displayName: config.label,
            api: 'openai-completions',
            baseURL: baseUrl,
            apiKeyEnv: config.credentialRef,
            models: [
              {
                id: config.model,
                name: config.label,
                ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
              },
            ],
          },
        },
      },
    },
    {
      id: 'agent-default-model',
      config: { provider: PROVIDER_ROUTE_ID, model: config.model },
    },
  ];
}

/** Route name the Harness will use for the configured model (also used by verification). */
export function providerRouteOf(config: ApiProviderConfig): string {
  return config.template === 'deepseek' ? 'deepseek-official' : PROVIDER_ROUTE_ID;
}

export function renderManagedBlock(config: ApiProviderConfig): string {
  const body = dumpYaml(buildManagedEntries(config), DUMP_OPTIONS).trimEnd();
  return `${MANAGED_BEGIN}\n${body}\n${MANAGED_END}`;
}

export function hasManagedBlock(text: string): boolean {
  return text.includes(MANAGED_BEGIN) && text.includes(MANAGED_END);
}

function stripManagedBlock(text: string): string {
  const begin = text.indexOf(MANAGED_BEGIN);
  const end = text.indexOf(MANAGED_END);
  if (begin === -1 || end === -1 || end < begin) return text;
  const after = text.indexOf('\n', end);
  return text.slice(0, begin) + (after === -1 ? '' : text.slice(after + 1));
}

const EMPTY_ARRAY_LINE = /^[ \t]*\[[ \t]*\][ \t]*$/m;

/**
 * Inserts or replaces our managed block without touching anything the user wrote.
 * The input is expected to be the patch-layer YAML array (the shipped file is `[]`).
 */
export function applyManagedBlock(existing: string, config: ApiProviderConfig): string {
  const block = renderManagedBlock(config);
  const current = existing ?? '';

  if (hasManagedBlock(current)) {
    const begin = current.indexOf(MANAGED_BEGIN);
    const end = current.indexOf(MANAGED_END);
    const after = current.indexOf('\n', end);
    const head = current.slice(0, begin);
    const tail = after === -1 ? '\n' : current.slice(after + 1);
    const next = `${head}${block}\n${tail}`.replace(/\n{3,}/g, '\n\n');
    assertPatchLoadable(next);
    return next;
  }

  const trimmed = current.replace(/\s+$/, '');
  if (trimmed === '' || loadYaml(trimmed) == null) {
    const next = `${trimmed ? `${trimmed}\n` : ''}${block}\n`;
    assertPatchLoadable(next);
    return next;
  }

  const parsed = loadYaml(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error('cordis.patch.yml 的顶层必须是数组，已停止写入以免破坏用户配置');
  }

  // Empty array on its own line: replace the token so the file stays a single array.
  if (parsed.length === 0 && EMPTY_ARRAY_LINE.test(trimmed)) {
    const next = `${trimmed.replace(EMPTY_ARRAY_LINE, block)}\n`;
    assertPatchLoadable(next);
    return next;
  }

  const next = `${trimmed}\n\n${block}\n`;
  assertPatchLoadable(next);
  return next;
}

/** Drops our block and keeps the document a valid (possibly empty) patch array. */
export function removeManagedBlock(existing: string): string {
  const stripped = stripManagedBlock(existing ?? '').replace(/\s+$/, '');
  if (stripped === '') return '[]\n';
  const parsed = loadYaml(stripped);
  if (parsed == null) {
    // Only comments are left: re-add the empty array so the file stays a patch layer.
    return `${stripped}\n[]\n`;
  }
  if (Array.isArray(parsed) && parsed.length === 0 && !EMPTY_ARRAY_LINE.test(stripped)) {
    return `${stripped}\n[]\n`;
  }
  return `${stripped}\n`;
}

function assertPatchLoadable(text: string): void {
  const parsed = loadYaml(text);
  if (parsed != null && !Array.isArray(parsed)) {
    throw new Error('写入后的 cordis.patch.yml 不是数组，已中止');
  }
}
