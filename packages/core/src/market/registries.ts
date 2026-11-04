import { DdaError, ERROR_CODES } from '@dda/spec';

/**
 * 国内下载优先级（PRD §10.3）在本仓库的实际落地：**L2 镜像优先、L3 官方兜底**。
 * L1（我方资源库）未落地（U5 未决），因此这里不存在 L1 层，也不对外宣称"全部走国内镜像"。
 *
 * 为什么需要我们自己实现回退（P-8）：
 * - `dsh plugin add`（我们调用的 CLI 路径）把参数转发给 pnpm，**自身没有 registry 回退计划**；
 * - 插件管理服务（Web/Agent 路径）的回退计划只有在"pnpm 自身 registry 是官方源或在 fallback 列表里"
 *   时才生效，而我们把 `npm_config_registry` 固定成了镜像，等于让它的回退失效；
 * - 因此：CLI 路径由本模块逐层重试，服务路径由 `registry-config.ts` 写入显式配置（registry + fallback）。
 */

export const REGISTRY_NPMMIRROR = 'https://registry.npmmirror.com/';
export const REGISTRY_OFFICIAL = 'https://registry.npmjs.org/';

export type RegistryLayerId = 'l2-npmmirror' | 'l3-official';

/**
 * L1（我方维护的国内资源库）**接口位**：U5（责任方/成本/SLA）未决前不实现，
 * 因此 `registryPlan()` 永远不会返回 L1。任何"全部走国内镜像"的承诺都与此冲突，不得出现。
 */
export const REGISTRY_L1_SLOT = { id: 'l1-managed', blockedBy: 'U5' } as const;

export interface RegistryLayer {
  id: RegistryLayerId;
  url: string;
  /** 给用户看的一行说明，日志与错误共用。 */
  label: string;
}

const MIRROR: RegistryLayer = { id: 'l2-npmmirror', url: REGISTRY_NPMMIRROR, label: '国内镜像 npmmirror' };
const OFFICIAL: RegistryLayer = { id: 'l3-official', url: REGISTRY_OFFICIAL, label: '官方源 npmjs' };

export function registryPlan(preferred: 'mirror-first' | 'official-first' = 'mirror-first'): RegistryLayer[] {
  return preferred === 'mirror-first' ? [MIRROR, OFFICIAL] : [OFFICIAL, MIRROR];
}

/**
 * 只在这类失败上换源：连不上、超时、镜像还没有该版本、包不存在。
 * 认证失败（401/403）换源也不会变好；版本/兼容性错误更不该靠换源掩盖。
 */
const RETRYABLE = [
  /ERR_PNPM_FETCH_5\d\d/i,
  /ERR_PNPM_FETCH_404/i,
  /ERR_PNPM_NO_MATCHING_VERSION/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE/i,
  /ERR_SOCKET_TIMEOUT|ERR_PNPM_META_FETCH_FAIL|fetch failed|socket hang up|network/i,
  /\bE404\b|404 Not Found/i,
];

const NOT_RETRYABLE = [/ERR_PNPM_FETCH_401|ERR_PNPM_FETCH_403|\bE401\b|\bE403\b/i, /unauthori[sz]ed|authentication/i];

export function isRegistryRetryable(message: string): boolean {
  if (NOT_RETRYABLE.some((re) => re.test(message))) return false;
  return RETRYABLE.some((re) => re.test(message));
}

export interface RegistryInstallOptions {
  /** 安装对象，只用于日志与错误消息。 */
  spec: string;
  plan?: RegistryLayer[];
  install: (registry: RegistryLayer) => Promise<void>;
  log?: (line: string) => void;
}

export interface RegistryAttempt {
  registry: RegistryLayerId;
  url: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface RegistryInstallResult {
  registry: RegistryLayer;
  attempts: number;
  /** D06：每次尝试的源与耗时，供日志与诊断导出（成功路径也保留）。 */
  history: RegistryAttempt[];
}

/**
 * 按计划逐层安装。只有可换源的失败才继续问下一层；其它失败立即抛出（换源改变不了它们）。
 * 全部失败时错误消息列出每一层失败原因，hint 明确"已尝试镜像与官方源"。
 */
export async function installWithRegistryFallback(options: RegistryInstallOptions): Promise<RegistryInstallResult> {
  const plan = options.plan ?? registryPlan();
  const failures: string[] = [];
  const history: RegistryAttempt[] = [];

  for (const [index, layer] of plan.entries()) {
    const startedAt = Date.now();
    options.log?.(`从${layer.label}安装 ${options.spec}（${index + 1}/${plan.length}）`);
    try {
      await options.install(layer);
      const durationMs = Date.now() - startedAt;
      history.push({ registry: layer.id, url: layer.url, ok: true, durationMs });
      options.log?.(`已从${layer.label}安装 ${options.spec}（${durationMs} ms）`);
      return { registry: layer, attempts: index + 1, history };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAt;
      history.push({ registry: layer.id, url: layer.url, ok: false, durationMs, error: message });
      failures.push(`${layer.label}（${layer.url}）：${message}`);
      if (!isRegistryRetryable(message)) {
        throw new DdaError(
          error instanceof DdaError ? error.code : ERROR_CODES.E_PROCESS_FAILED,
          `从${layer.label}安装 ${options.spec} 失败（此错误换源无法解决）：${message}`,
          '按上面的原因处理后重试；若提示权限或版本不符，换源无效',
        );
      }
      options.log?.(`${layer.label}不可用（${durationMs} ms），切换到下一层：${message.split('\n')[0] ?? message}`);
    }
  }

  throw new DdaError(
    ERROR_CODES.E_PROCESS_FAILED,
    `安装 ${options.spec} 失败：已依次尝试 ${plan.map((layer) => layer.label).join(' → ')}\n${failures.join('\n')}`,
    '检查网络或代理后重试；若镜像与官方源都不可达，说明当前网络无法访问 npm 生态',
  );
}
