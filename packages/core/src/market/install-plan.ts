import { DdaError, ERROR_CODES } from '@dda/spec';
import type { CatalogEntry, CompatMatrix, PluginState } from '@dda/spec';

import { assertCombination } from '../compat/matrix';
import { parseComposedDump } from '../api/verify';
import { planPluginChange, type PluginChangeAction } from './version-plan';
import { installWithRegistryFallback, registryPlan, type RegistryLayer } from './registries';
import { extractTarballHosts, formatTarballHosts, type TarballHostReport } from './source-report';

/**
 * D03：插件安装编排（对齐 PLG-4 的 9 步，docs/M4-技术架构决策.md §4.2）。
 *
 * 两条硬规则在这里落成代码：
 * 1. **第 1 步必须早于任何 pnpm 调用**——否则会出现「装上了但门禁判非法」的两难；
 * 2. **第 7/8/9 步不允许伪造成功**——能力不具备时明确记 `unverified`，不记 succeeded。
 */

export const PLUGIN_INSTALL_STEPS = [
  { index: 1, id: 'compat', title: '兼容组合门禁', retryable: false },
  { index: 2, id: 'precheck', title: '预检（profile 可写 / 磁盘 / registry 可达）', retryable: true },
  { index: 3, id: 'spec', title: '解析安装 spec', retryable: false },
  { index: 4, id: 'registry', title: '确定 registry 计划', retryable: true },
  { index: 5, id: 'install', title: '执行 dsh plugin add', retryable: true },
  { index: 6, id: 'verify-install', title: '安装复核（plugin list + profile 依赖）', retryable: true },
  { index: 7, id: 'verify-load', title: '加载复核（dump-config 出现该 bundle 行）', retryable: true },
  { index: 8, id: 'config', title: '配置自检（字段存在且格式合法）', retryable: true },
  { index: 9, id: 'connectivity', title: '连通探测', retryable: false },
] as const;

export type PluginInstallStepId = (typeof PLUGIN_INSTALL_STEPS)[number]['id'];
export type PluginInstallStepStatus = 'succeeded' | 'skipped' | 'unverified' | 'failed';

export interface PluginInstallStepOutcome {
  index: number;
  id: PluginInstallStepId;
  status: PluginInstallStepStatus;
  attempts: number;
  detail?: string;
}

export type ConnectivityVerdict = 'verified' | 'unverified';

export interface PluginInstallOutcome {
  spec: string;
  registry: RegistryLayer;
  /** D07：本次实际执行的动作（同版本时为 `none`，不发起任何 pnpm 调用）。 */
  action: PluginChangeAction;
  /** 版本切换前生成的 profile 备份目录（D08）。 */
  backupDir?: string;
  steps: PluginInstallStepOutcome[];
  /** D06：本次安装实际从哪些 host 下载 tarball（拿不到时 total=0）。 */
  tarballHosts: TarballHostReport;
  /** 只有真实探测成功才会是 `verified`；缺证据一律 `unverified`。 */
  connectivity: ConnectivityVerdict;
  connectivityDetail: string;
}

export interface PluginInstallDeps {
  /** 第 2 步：profile 可写 / 磁盘余量 / registry 可达。抛错即失败。 */
  precheck: () => Promise<void>;
  /** 第 5 步：带 registry 调用官方安装命令；返回其输出（用于 D06 记录 tarball host）。 */
  addPlugin: (layer: RegistryLayer) => Promise<string | void>;
  /** D07：版本切换（remove+add）时先卸载；同版本路径不会调用。 */
  removePlugin?: () => Promise<void>;
  /** D08：版本切换前备份 profile，返回备份目录。缺少它时拒绝做版本切换。 */
  backupProfile?: () => Promise<string>;
  /** 第 6 步。 */
  listPlugins: () => Promise<PluginState[]>;
  /** 第 6 步可选：profile `package.json` 里该依赖的版本。 */
  readProfileDependency?: () => Promise<string | undefined>;
  /** 第 7 步：`--dump-config` 输出；缺省则记 `unverified`。 */
  dumpConfig?: () => Promise<string>;
  /** 第 8 步：返回问题列表；空数组表示格式合法。缺省则记 `unverified`。 */
  checkConfig?: () => Promise<string[]>;
  /** 第 9 步：真实连通探测。缺省则记 `unverified`。 */
  probeConnectivity?: () => Promise<{ verified: boolean; detail: string }>;
  log?: (line: string) => void;
  /** 可重试步骤的最大尝试次数（默认 2）。 */
  attempts?: number;
  /** 测试注入用：registry 计划。 */
  plan?: RegistryLayer[];
}

export interface PluginInstallRequest {
  entry: CatalogEntry;
  matrix: CompatMatrix;
  dshVersion: string;
  nodeVersion?: string;
  /** D07：profile 里已安装的版本（同版本短路、降级确认都依赖它）。 */
  installedVersion?: string;
  /** 用户已在界面确认降级（两次确认的第二道）。 */
  allowDowngrade?: boolean;
  /** 安装目标名（用于校验 installedVersion 是否属于同一个包）。 */
  name?: string;
}

/**
 * 与官方 `marketInstallTarget()` **等价位**的本地实现（单测会逐字段对照官方输出）。
 * npm → `name@version`；git → `git+<url>.git#<commit>[&path:/dir]`。
 */
export function marketInstallTarget(
  name: string,
  version: Pick<CatalogEntry, 'version' | 'source'>,
): { spec: string; registry?: string } {
  const { source } = version;
  if (source.type === 'npm') {
    return {
      spec: `${name}@${version.version}`,
      ...(source.registry === undefined ? {} : { registry: source.registry }),
    };
  }
  const url = source.url.endsWith('.git') ? source.url : `${source.url}.git`;
  const path = source.path === undefined ? '' : `&path:/${source.path}`;
  return { spec: `git+${url}#${source.commit}${path}` };
}

/**
 * 把 pnpm 的 peerDeps 失败翻译成用户能照做的原因。
 * `@deepseek-ai/*` 的 peer 由宿主提供，不属于"装进 profile"的依赖。
 */
export function explainInstallFailure(message: string, entry: Pick<CatalogEntry, 'name'>): string | undefined {
  if (!/ERR_PNPM_PEER_DEP_ISSUES|missing peer|unmet peer|peer dependency/i.test(message)) return undefined;
  const missing = [...message.matchAll(/(@deepseek-ai\/[a-z0-9-]+)/gi)].map((match) => match[1]!).filter(Boolean);
  const unique = [...new Set(missing)];
  const hostPackages = unique.length > 0 ? unique.join('、') : '@deepseek-ai/* 宿主包';
  return (
    `${entry.name} 需要的宿主包没有满足：${hostPackages}。` +
    '这些包由 Harness 本体提供，不会装进 profile；出现该错误通常说明宿主版本与插件不匹配。'
  );
}

function fail(index: number, id: string, message: string, hint: string): DdaError {
  return new DdaError(ERROR_CODES.E_PROCESS_FAILED, `第 ${index} 步（${id}）失败：${message}`, hint);
}

async function runStep(
  step: (typeof PLUGIN_INSTALL_STEPS)[number],
  action: (() => Promise<string | undefined>) | undefined,
  attempts: number,
  outcomes: PluginInstallStepOutcome[],
  log: (line: string) => void,
): Promise<void> {
  if (action === undefined) {
    outcomes.push({ index: step.index, id: step.id, status: 'unverified', attempts: 0, detail: '本机不具备该项证据源' });
    log(`第 ${step.index} 步（${step.id}）：未验证（无证据源）`);
    return;
  }

  const maxAttempts = step.retryable ? attempts : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const detail = await action();
      outcomes.push({
        index: step.index,
        id: step.id,
        status: 'succeeded',
        attempts: attempt,
        ...(detail === undefined ? {} : { detail }),
      });
      log(`第 ${step.index} 步（${step.id}）：通过${detail === undefined ? '' : ` — ${detail}`}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        log(`第 ${step.index} 步（${step.id}）第 ${attempt} 次失败，重试该步：${describe(error)}`);
      }
    }
  }

  outcomes.push({
    index: step.index,
    id: step.id,
    status: 'failed',
    attempts: maxAttempts,
    detail: describe(lastError),
  });
  if (lastError instanceof DdaError) {
    throw new DdaError(
      lastError.code,
      `第 ${step.index} 步（${step.id}）失败：${lastError.message}`,
      lastError.hint,
    );
  }
  throw fail(step.index, step.id, describe(lastError), '按错误信息处理后重试该步骤');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 完整安装流水线。任一步失败即抛错，错误消息带步号；`outcomes` 记录每一步（可回放）。
 * 失败时调用方仍可拿到已完成的步骤（通过抛出的错误之外的 `onProgress` 日志）。
 */
export async function installCatalogPlugin(
  request: PluginInstallRequest,
  deps: PluginInstallDeps,
): Promise<PluginInstallOutcome> {
  const { entry, matrix } = request;
  const log = deps.log ?? (() => undefined);
  const attempts = deps.attempts ?? 2;
  const outcomes: PluginInstallStepOutcome[] = [];
  let target: { spec: string; registry?: string } | undefined;
  let usedRegistry: RegistryLayer | undefined;
  let connectivity: ConnectivityVerdict = 'unverified';
  let connectivityDetail = '未执行连通探测';
  let installOutput = '';
  let backupDir: string | undefined;
  let replaced = false;

  // D07：先判定动作（同版本 / 安装 / 升级 / 降级）。降级未确认在这里就拒绝，不进入任何安装步骤。
  const change = planPluginChange({
    name: request.name ?? entry.name,
    ...(request.installedVersion === undefined ? {} : { installedVersion: request.installedVersion }),
    target: { name: entry.name, version: entry.version },
    matrix,
    dshVersion: request.dshVersion,
    ...(request.nodeVersion === undefined ? {} : { nodeVersion: request.nodeVersion }),
    ...(request.allowDowngrade === undefined ? {} : { allowDowngrade: request.allowDowngrade }),
    // 兼容门禁统一由第 1 步执行，错误消息才会带步号。
    assertCombo: false,
  });

  const plannedTiming = deps.plan ?? registryPlan();

  if (change.action === 'none') {
    // 同版本：不发起任何 pnpm 调用（不重装、不校验 registry、不动 profile）。
    log(`已安装 ${entry.name}@${entry.version}，同版本不再重复安装`);
    return {
      spec: marketInstallTarget(entry.name, entry).spec,
      registry: plannedTiming[0]!,
      action: 'none',
      steps: [],
      tarballHosts: { total: 0, hosts: [] },
      connectivity: 'unverified',
      connectivityDetail: '已安装同版本，未执行任何安装动作',
    };
  }

  if (change.method === 'remove-then-add') {
    if (deps.backupProfile === undefined || deps.removePlugin === undefined) {
      throw new DdaError(
        ERROR_CODES.E_PROCESS_FAILED,
        `第 5 步（install）无法执行版本切换：缺少 profile 备份或卸载能力`,
        '版本切换必须先备份 profile（D08），请升级本软件或改用完整部署流程',
      );
    }
    log(
      `版本切换：${change.installedVersion ?? '(未知)'} → ${entry.version}（${change.action}）；` +
        change.warnings.join('；'),
    );
  }

  // 第 1 步：compat 门禁。必须在任何 pnpm 调用之前。
  await runStep(
    PLUGIN_INSTALL_STEPS[0]!,
    async () => {
      const combo = assertCombination(matrix, {
        dsh: request.dshVersion,
        qqbot: entry.version,
        ...(request.nodeVersion === undefined ? {} : { node: request.nodeVersion }),
      });
      return `组合 ${combo.id}（${combo.status}）`;
    },
    attempts,
    outcomes,
    log,
  );

  await runStep(
    PLUGIN_INSTALL_STEPS[1]!,
    async () => {
      await deps.precheck();
      return undefined;
    },
    attempts,
    outcomes,
    log,
  );

  await runStep(
    PLUGIN_INSTALL_STEPS[2]!,
    async () => {
      target = marketInstallTarget(entry.name, entry);
      return target.spec;
    },
    attempts,
    outcomes,
    log,
  );
  const installTarget = target ?? marketInstallTarget(entry.name, entry);

  const plan = deps.plan ?? registryPlan();
  await runStep(
    PLUGIN_INSTALL_STEPS[3]!,
    async () => {
      if (plan.length === 0) throw new Error('registry 计划为空');
      return plan.map((layer) => layer.label).join(' → ');
    },
    attempts,
    outcomes,
    log,
  );

  await runStep(
    PLUGIN_INSTALL_STEPS[4]!,
    async () => {
      if (change.method === 'remove-then-add' && !replaced) {
        // D08：先备份、再卸载；备份与卸载各只做一次（重试该步不会重复执行）。
        backupDir ??= await deps.backupProfile!();
        log(`已备份 profile：${backupDir}`);
        await deps.removePlugin!();
        replaced = true;
        log(`已卸载旧版本 ${change.installedVersion ?? '(未知)'}，准备安装 ${entry.version}`);
      }
      const result = await installWithRegistryFallback({
        spec: installTarget.spec,
        plan,
        log,
        install: async (layer) => {
          try {
            const output = await deps.addPlugin(layer);
            if (typeof output === 'string') installOutput += `${output}\n`;
          } catch (error) {
            // peerDeps 缺失时给出"宿主版本不匹配"的可读原因，而不是把 pnpm 原文丢给用户。
            const explanation = explainInstallFailure(describe(error), entry);
            if (explanation !== undefined) {
              throw new DdaError(ERROR_CODES.E_VERSION_UNSUPPORTED, explanation, '升级 Harness 或使用已验证的插件版本');
            }
            throw error;
          }
        },
      });
      usedRegistry = result.registry;
      const hosts = extractTarballHosts(installOutput);
      return `来自${result.registry.label}；${formatTarballHosts(hosts)}`;
    },
    attempts,
    outcomes,
    log,
  );

  await runStep(
    PLUGIN_INSTALL_STEPS[5]!,
    async () => {
      const plugins = await deps.listPlugins();
      const found = plugins.find((plugin) => plugin.name === entry.name);
      if (found === undefined || found.version !== entry.version) {
        throw new Error(
          `plugin list 中 ${entry.name} 的版本是 ${found?.version ?? '(未安装)'}，catalog 要求 ${entry.version}`,
        );
      }
      if (deps.readProfileDependency !== undefined) {
        const profileVersion = await deps.readProfileDependency();
        if (profileVersion !== entry.version) {
          throw new Error(
            `profile package.json 中 ${entry.name} 的版本是 ${profileVersion ?? '(缺失)'}，与 ${entry.version} 不一致`,
          );
        }
      }
      return `${entry.name}@${entry.version}`;
    },
    attempts,
    outcomes,
    log,
  );

  await runStep(
    PLUGIN_INSTALL_STEPS[6]!,
    deps.dumpConfig === undefined
      ? undefined
      : async () => {
          const dump = await deps.dumpConfig!();
          const entries = parseComposedDump(dump);
          if (entries === undefined) throw new Error('dump-config 输出无法解析为组合树');
          const row = [...entries]
            .reverse()
            .find((candidate) => candidate.name === request.entry.name);
          if (row === undefined) {
            // 兼容只打印 `id:` 的旧输出：至少要求出现该插件名。
            if (!dump.includes(request.entry.name)) {
              throw new Error(`dump-config 中没有 ${request.entry.name} 的插入行（插件未加载）`);
            }
            return 'dump 中出现插件名（未识别到条目结构）';
          }
          if (row.disabled === true) throw new Error(`${request.entry.name} 在组合树中是 disabled`);
          return '已加载（enabled）';
        },
    attempts,
    outcomes,
    log,
  );

  await runStep(
    PLUGIN_INSTALL_STEPS[7]!,
    deps.checkConfig === undefined
      ? undefined
      : async () => {
          const problems = await deps.checkConfig!();
          if (problems.length > 0) throw new Error(problems.join('；'));
          return '字段格式合法（未验证生效）';
        },
    attempts,
    outcomes,
    log,
  );

  await runStep(
    PLUGIN_INSTALL_STEPS[8]!,
    deps.probeConnectivity === undefined
      ? undefined
      : async () => {
          const probe = await deps.probeConnectivity!();
          connectivity = probe.verified ? 'verified' : 'unverified';
          connectivityDetail = probe.detail;
          return probe.verified ? `已连通：${probe.detail}` : `未验证：${probe.detail}`;
        },
    attempts,
    outcomes,
    log,
  );

  return {
    spec: installTarget.spec,
    registry: usedRegistry ?? plan[0]!,
    action: change.action,
    ...(backupDir === undefined ? {} : { backupDir }),
    steps: outcomes,
    tarballHosts: extractTarballHosts(installOutput),
    connectivity,
    connectivityDetail,
  };
}
