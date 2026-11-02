import { lookup } from 'node:dns/promises';

import { redact } from '../logging/logger';
import { normalizeBaseUrl, type ApiProviderConfig } from './types';

/**
 * Minimal, real connection test for a user-supplied model endpoint.
 *
 * This is a health probe (PRD §11 API-4/5), not a model framework: one tiny request, then a
 * classification the UI can turn into an actionable sentence. It never posts through our servers,
 * never logs the credential, and never treats HTTP 200 alone as success (the body must parse).
 */
export type ConnectionVerdict =
  | 'ok'
  | 'dns'
  | 'network'
  | 'auth'
  | 'quota'
  | 'model-not-found'
  | 'server'
  | 'bad-response'
  | 'timeout'
  | 'config';

export type ProbeStage = 'address' | 'dns' | 'request' | 'auth' | 'model' | 'response';

export interface ProbeStep {
  stage: ProbeStage;
  ok: boolean;
  detail: string;
  millis: number;
}

export interface ConnectionResult {
  verdict: ConnectionVerdict;
  /** User-facing sentence (no secrets, no stack traces). */
  message: string;
  /** What the user should do next; empty when the verdict is `ok`. */
  nextStep: string;
  httpStatus?: number;
  millis: number;
  model?: string;
  steps: ProbeStep[];
  /** Truncated, redacted response sample for the log / diagnostics. */
  sample?: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SAMPLE = 200;

export function resolveEndpoint(config: ApiProviderConfig): URL {
  const base = normalizeBaseUrl(config.baseUrl);
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, '');
  if (config.protocol === 'anthropic-messages') {
    // Harness appends /v1/messages to a Messages-compatible root (verified in dsh-llm-deepseek).
    url.pathname = /\/v1$/.test(path) ? `${path}/messages` : `${path}/v1/messages`;
  } else {
    url.pathname = /\/v1$/.test(path) ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  }
  return url;
}

function requestBody(config: ApiProviderConfig): string {
  return JSON.stringify({
    model: config.model,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'ping' }],
  });
}

function requestHeaders(config: ApiProviderConfig, apiKey: string): Record<string, string> {
  const base: Record<string, string> = { 'content-type': 'application/json' };
  if (config.protocol === 'anthropic-messages') {
    base['anthropic-version'] = '2023-06-01';
    base['x-api-key'] = apiKey;
  } else {
    base.authorization = `Bearer ${apiKey}`;
  }
  return base;
}

function extractReply(protocol: ApiProviderConfig['protocol'], body: unknown): string | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (protocol === 'anthropic-messages') {
    const content = record.content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) =>
          block != null && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string'
            ? ((block as Record<string, unknown>).text as string)
            : '',
        )
        .join('')
        .trim();
      if (text.length > 0) return text;
    }
    return undefined;
  }
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first != null && typeof first === 'object') {
      const message = (first as Record<string, unknown>).message;
      if (message != null && typeof message === 'object' && typeof (message as Record<string, unknown>).content === 'string') {
        return ((message as Record<string, unknown>).content as string).trim();
      }
    }
  }
  return undefined;
}

/**
 * Structural check of the assistant message. A reasoning model can spend the whole `max_tokens`
 * budget on a `thinking` block and return **no** `text` block at all — that is a valid, working
 * connection (observed with `deepseek-flash` + max_tokens=16), not a broken response.
 */
function checkReply(
  protocol: ApiProviderConfig['protocol'],
  body: unknown,
): { ok: boolean; note: string } {
  if (body == null || typeof body !== 'object') return { ok: false, note: '响应不是 JSON 对象' };
  const record = body as Record<string, unknown>;
  const text = extractReply(protocol, body) ?? '';

  if (protocol === 'anthropic-messages') {
    const type = record.type;
    if (typeof type === 'string' && type !== 'message') return { ok: false, note: `type=${type}` };
    const content = record.content;
    if (!Array.isArray(content)) return { ok: false, note: '缺少 content 数组' };
    if (content.length === 0) return { ok: false, note: 'content 为空数组' };
    if (text.length > 0) return { ok: true, note: `回复长度 ${text.length} 字符` };
    return { ok: true, note: `返回 ${content.length} 个内容块（无文本，推理模型只给思考块时属正常）` };
  }

  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { ok: false, note: '缺少 choices' };
  const first = choices[0] as Record<string, unknown> | null;
  if (first == null || typeof first !== 'object') return { ok: false, note: 'choices[0] 不是对象' };
  const message = first.message;
  if (message == null || typeof message !== 'object') return { ok: false, note: '缺少 message' };
  if (text.length > 0) return { ok: true, note: `回复长度 ${text.length} 字符` };
  const reasoning = (message as Record<string, unknown>).reasoning_content;
  if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
    return { ok: true, note: `仅返回 reasoning_content（${reasoning.trim().length} 字符，推理模型常见）` };
  }
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return { ok: true, note: '返回 tool_calls（无文本）' };
  return { ok: false, note: 'message.content 为空' };
}

function sampleOf(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join('[redacted]') : text;
  return redact(withoutKey).slice(0, MAX_SAMPLE);
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

function errorCode(error: unknown): string {
  if (error != null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const cause = record.cause;
    if (cause != null && typeof cause === 'object' && typeof (cause as Record<string, unknown>).code === 'string') {
      return (cause as Record<string, unknown>).code as string;
    }
    if (typeof record.code === 'string') return record.code;
    if (typeof record.name === 'string' && record.name === 'AbortError') return 'ABORT';
  }
  return '';
}

function classifyStatus(status: number, rawText: string): { verdict: ConnectionVerdict; message: string; nextStep: string } {
  if (status === 401) {
    return {
      verdict: 'auth',
      message: '密钥无效或已失效（HTTP 401）',
      nextStep: '请到服务商控制台确认密钥是否有效，然后重新粘贴。',
    };
  }
  if (status === 403) {
    return {
      verdict: 'auth',
      message: '密钥没有访问权限（HTTP 403）',
      nextStep: '确认该密钥是否开通了此模型/接口的权限，或是否被限制了来源。',
    };
  }
  if (status === 429) {
    return {
      verdict: 'quota',
      message: '额度不足或触发限流（HTTP 429）',
      nextStep: '请到服务商控制台检查余额与限额，稍后再试。',
    };
  }
  if (status === 404 || (status === 400 && /model/i.test(rawText))) {
    return {
      verdict: 'model-not-found',
      message: `模型“{model}”在该服务上不可用（HTTP ${status}）`,
      nextStep: '检查模型名称是否拼写正确、是否已开通；也可以换一个模型再试。',
    };
  }
  if (status >= 500) {
    return {
      verdict: 'server',
      message: `模型服务暂时不可用（HTTP ${status}）`,
      nextStep: '稍后重试；如果持续失败，请换用其他可用模型或联系服务商。',
    };
  }
  return {
    verdict: 'bad-response',
    message: `接口返回了预期之外的状态（HTTP ${status}）`,
    nextStep: '确认接口地址是否正确（是否需要以 /v1 结尾），以及该地址是否为兼容的 API 网关。',
  };
}

export async function testConnection(
  config: ApiProviderConfig,
  apiKey: string,
  options: ProbeOptions = {},
): Promise<ConnectionResult> {
  const started = Date.now();
  const steps: ProbeStep[] = [];
  const step = (stage: ProbeStage, ok: boolean, detail: string, from: number) => {
    steps.push({ stage, ok, detail, millis: Date.now() - from });
  };
  const fail = (
    verdict: ConnectionVerdict,
    message: string,
    nextStep: string,
    extra: Partial<ConnectionResult> = {},
  ): ConnectionResult => ({
    verdict,
    message,
    nextStep,
    millis: Date.now() - started,
    steps,
    ...extra,
  });

  if (!apiKey) {
    return fail('config', '本机没有保存这个服务的密钥', '请先填写 API Key 并保存。');
  }

  let endpoint: URL;
  try {
    endpoint = resolveEndpoint(config);
  } catch {
    return fail('config', '接口地址格式不正确', '请填写以 https:// 开头的完整地址。');
  }
  step('address', true, endpoint.origin + endpoint.pathname, started);

  const resolveHost = options.resolveHost ?? ((host: string) => lookup(host).then((hit) => hit.address));
  const dnsStarted = Date.now();
  try {
    const address = await resolveHost(endpoint.hostname);
    step('dns', true, `${endpoint.hostname} → ${address}`, dnsStarted);
  } catch (error) {
    const code = errorCode(error);
    step('dns', false, `${endpoint.hostname} 解析失败${code ? `（${code}）` : ''}`, dnsStarted);
    return fail('dns', '域名解析失败，无法找到模型服务', '检查网络连接与代理设置；企业网络可能限制了该域名。');
  }

  const requestStarted = Date.now();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  let rawText = '';
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: requestHeaders(config, apiKey),
      body: requestBody(config),
      signal: controller.signal,
      redirect: 'follow',
    });
    rawText = await response.text();
    step('request', true, `HTTP ${response.status}`, requestStarted);
  } catch (error) {
    const code = errorCode(error);
    const isTimeout = code === 'ABORT' || /abort/i.test(String(error));
    step('request', false, isTimeout ? `超时（>${Math.round(timeoutMs / 1000)}s）` : `连接失败${code ? `（${code}）` : ''}`, requestStarted);
    if (isTimeout) {
      return fail('timeout', '连接模型服务超时', '检查网络/代理是否可达；也可以稍后重试。');
    }
    if (code === 'ENOTFOUND') {
      return fail('dns', '域名解析失败，无法找到模型服务', '检查网络连接与代理设置。');
    }
    if (NETWORK_CODES.has(code) || code === '') {
      return fail('network', '无法连接模型服务', '检查网络/代理；企业网络可能拦截了该地址，或地址端口不对。');
    }
    return fail('network', `无法连接模型服务（${code}）`, '检查网络/代理后重试。');
  } finally {
    clearTimeout(timer);
  }

  const httpStatus = response.status;
  const sample = sampleOf(rawText, apiKey);

  if (!response.ok) {
    const classified = classifyStatus(httpStatus, rawText);
    step(httpStatus === 401 || httpStatus === 403 ? 'auth' : httpStatus === 404 ? 'model' : 'response', false, classified.message, requestStarted);
    return fail(classified.verdict, classified.message.replace('{model}', config.model), classified.nextStep, {
      httpStatus,
      sample,
    });
  }

  const respondStarted = Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    step('response', false, '响应不是合法 JSON', respondStarted);
    return fail('bad-response', '接口返回的内容无法解析', '确认该地址是模型 API（而不是网页或代理首页）。', {
      httpStatus,
      sample,
    });
  }

  const replyCheck = checkReply(config.protocol, parsed);
  if (!replyCheck.ok) {
    step('response', false, `响应结构不符合预期：${replyCheck.note}`, respondStarted);
    return fail('bad-response', '接口返回了 JSON，但没有模型回复内容', '确认接口协议（OpenAI 兼容 / Anthropic Messages）与该地址匹配。', {
      httpStatus,
      sample,
    });
  }
  step('response', true, replyCheck.note, respondStarted);

  const modelEcho =
    parsed != null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).model === 'string'
      ? ((parsed as Record<string, unknown>).model as string)
      : config.model;
  step('model', true, `模型 ${modelEcho}`, respondStarted);

  return {
    verdict: 'ok',
    message: `连接成功（耗时 ${Date.now() - started} ms，模型 ${modelEcho}）`,
    nextStep: '',
    httpStatus,
    millis: Date.now() - started,
    model: modelEcho,
    steps,
    sample,
  };
}
