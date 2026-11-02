import { DEFAULT_SCHEMA, Type, load as loadYaml } from 'js-yaml';

import { normalizeBaseUrl, PROVIDER_ROUTE_ID } from './types';

/**
 * Read-back check (CFG-2): after writing the patch we ask the Harness itself what it composed
 * (`dsh --profile <p> --dump-config`) and verify our route really is the active default model.
 * This is what turns "we wrote a file" into "the Harness recognised the configuration".
 */
export interface ExpectedRoute {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  /** `structured` = parsed the dumped YAML; `textual` = the dump could not be parsed. */
  method: 'structured' | 'textual';
}

interface DumpEntry {
  id?: unknown;
  name?: unknown;
  config?: unknown;
  disabled?: unknown;
}

/** The dumped tree contains `!!js` expressions; treat them as opaque strings. */
const JS_TAG = new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => String(data) });
const SCHEMA = DEFAULT_SCHEMA.extend([JS_TAG]);

function parseDump(dump: string): DumpEntry[] | undefined {
  try {
    const parsed = loadYaml(dump, { schema: SCHEMA });
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((entry): entry is DumpEntry => entry != null && typeof entry === 'object');
  } catch {
    return undefined;
  }
}

function lastEntry(entries: DumpEntry[], id: string): DumpEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.id === id) return entries[index];
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function verifyComposedConfig(dump: string, expected: ExpectedRoute): VerifyResult {
  const entries = parseDump(dump);
  if (!entries) return textualVerify(dump, expected);

  const problems: string[] = [];
  const defaultModel = asRecord(lastEntry(entries, 'agent-default-model')?.config);
  if (!defaultModel) {
    problems.push('组合结果里没有 agent-default-model 条目');
  } else {
    if (defaultModel.provider !== expected.provider) {
      problems.push(`默认 provider 仍是 ${String(defaultModel.provider)}，期望 ${expected.provider}`);
    }
    if (defaultModel.model !== expected.model) {
      problems.push(`默认模型仍是 ${String(defaultModel.model)}，期望 ${expected.model}`);
    }
  }

  if (expected.provider === 'deepseek-official') {
    const route = asRecord(lastEntry(entries, 'llm-deepseek')?.config);
    if (!route) {
      problems.push('组合结果里没有 llm-deepseek 条目');
    } else {
      if (route.apiKeyEnv !== expected.apiKeyEnv) {
        problems.push(`llm-deepseek.apiKeyEnv 为 ${String(route.apiKeyEnv)}，期望 ${expected.apiKeyEnv}`);
      }
      if (route.baseURL != null && normalizeBaseUrl(String(route.baseURL)) !== normalizeBaseUrl(expected.baseUrl)) {
        problems.push(`llm-deepseek.baseURL 为 ${String(route.baseURL)}，期望 ${expected.baseUrl}`);
      }
    }
  } else {
    const route = asRecord(asRecord(asRecord(lastEntry(entries, 'llm-pi-ai')?.config)?.providers)?.[PROVIDER_ROUTE_ID]);
    if (!route) {
      problems.push(`组合结果里没有 llm-pi-ai 的 ${PROVIDER_ROUTE_ID} 路由`);
    } else {
      if (normalizeBaseUrl(String(route.baseURL ?? '')) !== normalizeBaseUrl(expected.baseUrl)) {
        problems.push(`路由 baseURL 为 ${String(route.baseURL)}，期望 ${expected.baseUrl}`);
      }
      if (route.apiKeyEnv !== expected.apiKeyEnv) {
        problems.push(`路由 apiKeyEnv 为 ${String(route.apiKeyEnv)}，期望 ${expected.apiKeyEnv}`);
      }
      const models = Array.isArray(route.models) ? route.models : [];
      const hasModel = models.some((entry) => asRecord(entry)?.id === expected.model);
      if (!hasModel) problems.push(`路由模型目录里没有 ${expected.model}`);
    }
  }

  return { ok: problems.length === 0, problems, method: 'structured' };
}

function textualVerify(dump: string, expected: ExpectedRoute): VerifyResult {
  const problems: string[] = [];
  if (!dump.includes(`provider: ${expected.provider}`)) {
    problems.push(`组合结果里没有 provider: ${expected.provider}`);
  }
  if (!dump.includes(`model: ${expected.model}`)) {
    problems.push(`组合结果里没有 model: ${expected.model}`);
  }
  if (!dump.includes(`apiKeyEnv: ${expected.apiKeyEnv}`)) {
    problems.push(`组合结果里没有 apiKeyEnv: ${expected.apiKeyEnv}`);
  }
  return { ok: problems.length === 0, problems, method: 'textual' };
}
