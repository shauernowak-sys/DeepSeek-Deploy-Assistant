/**
 * Provider configuration model shared by the main process, the connection probe and the
 * Harness patch writer.
 *
 * Field names mirror what `dsh 0.2.0-rc.2` actually accepts (verified with
 * `dsh --profile web --dump-config-schema`): `apiKeyEnv`, `baseURL`, `api`, `models[]`,
 * `agent-default-model.provider/model`. Nothing here is guessed.
 */

/** Protocols the Harness adapters support for a model route. */
export type ApiProtocol = 'anthropic-messages' | 'openai-completions';

/**
 * `deepseek`: the Harness-native `deepseek-official` route (`dsh-llm-deepseek-api-key`).
 * `openai-compatible`: a `dsh-llm-pi-ai` route for any OpenAI-compatible gateway.
 */
export type ApiTemplate = 'deepseek' | 'openai-compatible';

export interface ApiProviderConfig {
  template: ApiTemplate;
  /** Human label; also shown in the Harness model picker (`displayName`). */
  label: string;
  protocol: ApiProtocol;
  /** Root URL used both by the probe and by the Harness route. No credentials, no query. */
  baseUrl: string;
  model: string;
  /** Env-var style credential reference resolved by the Harness credential seam. */
  credentialRef: string;
  contextWindow?: number;
}

/** The DeepSeek template the guide ships with (every value verified, see docs). */
export const DEEPSEEK_TEMPLATE: ApiProviderConfig = {
  template: 'deepseek',
  label: 'DeepSeek 官方',
  protocol: 'anthropic-messages',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
  credentialRef: 'DEEPSEEK_API_KEY',
  contextWindow: 1_000_000,
};

/** Models the Harness catalog publishes for `deepseek-official` (from `--dump-config-schema`). */
export const DEEPSEEK_MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 },
];

export const PROVIDER_ROUTE_ID = 'dda-custom';

/** A credential reference must be usable as a POSIX shell identifier (Harness constraint). */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ConfigProblem {
  field: 'label' | 'baseUrl' | 'model' | 'credentialRef' | 'protocol';
  message: string;
}

/**
 * Local validation only: never touches the network and never accepts a credential value.
 * Messages are user-facing so the renderer can show them verbatim.
 */
export function validateProviderConfig(input: ApiProviderConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  if (input.label.trim().length === 0) problems.push({ field: 'label', message: '请填写服务名称' });
  if (input.label.length > 64) problems.push({ field: 'label', message: '服务名称过长（最多 64 个字符）' });

  let url: URL | undefined;
  try {
    url = new URL(input.baseUrl);
  } catch {
    problems.push({ field: 'baseUrl', message: '接口地址格式不正确，需要以 https:// 开头' });
  }
  if (url) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      problems.push({ field: 'baseUrl', message: '接口地址必须以 http:// 或 https:// 开头' });
    }
    if (url.username || url.password) {
      problems.push({ field: 'baseUrl', message: '接口地址里不要包含用户名或密码' });
    }
    if (url.search || url.hash) {
      problems.push({ field: 'baseUrl', message: '接口地址里不要包含 ? 或 # 参数' });
    }
  }
  if (input.model.trim().length === 0) problems.push({ field: 'model', message: '请填写模型名称' });
  if (!CREDENTIAL_REF_PATTERN.test(input.credentialRef)) {
    problems.push({ field: 'credentialRef', message: '内部凭据名只能包含字母、数字和下划线' });
  }
  if (input.template === 'openai-compatible' && input.protocol !== 'openai-completions') {
    problems.push({ field: 'protocol', message: '自定义网关目前只支持 OpenAI 兼容协议' });
  }
  return problems;
}

/** Trim trailing slashes so the probe and the Harness route build the same URL. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Display-only mask for a stored credential; the value never leaves the main process. */
export function maskCredential(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
