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

const MANAGED_NOTE = '  (DeepSeek Deploy Assistant 写入，请勿手工修改)';

export interface ManagedSection {
  begin: string;
  end: string;
}

/**
 * Several features (API provider, QQ bot) write into the same patch file, so each owns a named
 * section. An empty id keeps the original markers used by the API block.
 */
export function managedSection(id = ''): ManagedSection {
  if (!id) return { begin: MANAGED_BEGIN, end: MANAGED_END };
  return { begin: `# >>> dda:managed:${id}:begin${MANAGED_NOTE}`, end: `# <<< dda:managed:${id}:end` };
}

/** Section id owned by the QQ bot block (see packages/core/src/qq/patch.ts). */
export const QQ_MANAGED_SECTION = 'qq';

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
  return renderManagedSection(buildManagedEntries(config));
}

/** Same writer, but for any entry list + any section of the managed file. */
export function renderManagedSection(entries: ManagedPatchEntry[], section = ''): string {
  const { begin, end } = managedSection(section);
  const body = dumpYaml(entries, DUMP_OPTIONS).trimEnd();
  return `${begin}\n${body}\n${end}`;
}

export function hasManagedBlock(text: string): boolean {
  return hasManagedSection(text);
}

export function hasManagedSection(text: string, section = ''): boolean {
  const { begin, end } = managedSection(section);
  return text.includes(begin) && text.includes(end);
}

function stripManagedSection(text: string, section = ''): string {
  const { begin, end } = managedSection(section);
  const beginIndex = text.indexOf(begin);
  const endIndex = text.indexOf(end);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) return text;
  const after = text.indexOf('\n', endIndex);
  return text.slice(0, beginIndex) + (after === -1 ? '' : text.slice(after + 1));
}

const EMPTY_ARRAY_LINE = /^[ \t]*\[[ \t]*\][ \t]*$/m;

/**
 * Inserts or replaces our managed block without touching anything the user wrote.
 * The input is expected to be the patch-layer YAML array (the shipped file is `[]`).
 */
export function applyManagedBlock(existing: string, config: ApiProviderConfig): string {
  return applyManagedSection(existing, buildManagedEntries(config));
}

export function applyManagedSection(
  existing: string,
  entries: ManagedPatchEntry[],
  section = '',
): string {
  const { begin, end } = managedSection(section);
  const block = renderManagedSection(entries, section);
  const current = existing ?? '';

  if (hasManagedSection(current, section)) {
    const beginIndex = current.indexOf(begin);
    const endIndex = current.indexOf(end);
    const after = current.indexOf('\n', endIndex);
    const head = current.slice(0, beginIndex);
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
  return removeManagedSection(existing);
}

export function removeManagedSection(existing: string, section = ''): string {
  const stripped = stripManagedSection(existing ?? '', section).replace(/\s+$/, '');
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
