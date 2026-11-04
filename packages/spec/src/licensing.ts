import { z } from 'zod';

import { BASELINE } from './domain';

/**
 * 分发边界（PRD §10.3 CN-5 / §12.1 / §18.1 G-A7）。
 *
 * 这里回答的不是"能不能装"，而是"**我们能不能分发这些字节**"：
 * - `online-install`：用户机器从 registry 拉取，我方只触发官方安装命令，不分发任何字节 → 恒可用。
 * - `offline-bundle`：我方把依赖闭包打进安装包/离线包 → 需要闭包内每个包都允许再分发。
 * - `mirror`：我方镜像/对象存储转发 tarball → 同 offline-bundle。
 * - `rebundle`：我方重打包（含修改源码）→ 最严格。
 *
 * Gate 4 ② 已按 03-开发任务拆分 的原文降级为"弱网可安装 + 明确的在线提示"（2026-11-04 决策）：
 * 官方 QQ 插件的闭包含 `UNLICENSED` 依赖，因此离线/镜像/重打包三条路全部关闭，且不得在 UI 出现入口。
 */
export const DISTRIBUTION_MODES = ['online-install', 'offline-bundle', 'mirror', 'rebundle'] as const;

export type DistributionMode = (typeof DISTRIBUTION_MODES)[number];

/** 用户可读的方式名（日志、错误、界面共用，避免各处另写一套）。 */
export const DISTRIBUTION_MODE_LABELS: Record<DistributionMode, string> = {
  'online-install': '在线安装',
  'offline-bundle': '离线包',
  mirror: '镜像分发',
  rebundle: '重打包分发',
};

export interface DistributionBlocker {
  mode: DistributionMode;
  /** 触发阻断的具体包：界面上必须能指出"是谁导致的"。 */
  package: string;
  version: string;
  license: string;
  reason: string;
}

export interface DistributionPolicy {
  /** 稳定标识（不是包名，包名可能变）。 */
  id: string;
  name: string;
  version: string;
  license: string;
  allowed: readonly DistributionMode[];
  blocked: readonly DistributionBlocker[];
  /** 唯一的一段用户可读说明；UI 与日志都引用它，不得另行硬编码。 */
  notice: string;
}

/** 官方 QQ 插件的分发策略（版本取自锁定的 BASELINE，避免与清单漂移）。 */
export const QQ_PLUGIN_DISTRIBUTION: DistributionPolicy = {
  id: 'qq-official-bot',
  name: '@tencent-connect/dsh-qqbot',
  version: BASELINE.qqbot.version,
  license: 'MIT',
  allowed: ['online-install'],
  blocked: [
    {
      mode: 'offline-bundle',
      package: '@tencent-connect/qqbot-connector',
      version: BASELINE.qqbot.connector,
      license: 'UNLICENSED',
      reason: '其运行时依赖未授予再分发许可，打进离线包即构成再分发',
    },
    {
      mode: 'mirror',
      package: '@tencent-connect/qqbot-connector',
      version: BASELINE.qqbot.connector,
      license: 'UNLICENSED',
      reason: '镜像转发同样属于再分发',
    },
    {
      mode: 'rebundle',
      package: '@tencent-connect/qqbot-connector',
      version: BASELINE.qqbot.connector,
      license: 'UNLICENSED',
      reason: '既未获再分发许可，也未获修改许可',
    },
  ],
  notice:
    '官方 QQ 插件仅支持在线安装：其运行时依赖 @tencent-connect/qqbot-connector 为 UNLICENSED，' +
    '本软件不打包、不镜像、不随包分发，因此不提供离线安装。安装需要联网（默认走国内镜像加速）。',
};

/** D11 许可门禁的三态判定（详见 docs/M4-技术架构决策.md §6）。 */
export const DEPS_LICENSE_VERDICTS = ['allowed', 'needs-review', 'denied'] as const;

export type DepsLicenseVerdict = (typeof DEPS_LICENSE_VERDICTS)[number];

/**
 * 闭包内一个包的许可结论。`verdict` 与 `redistributable` 由门禁计算，不允许在 catalog 里手写，
 * 否则结论会随依赖升级而静默过期。
 */
export const DepsClosureEntrySchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string().min(1),
    verdict: z.enum(DEPS_LICENSE_VERDICTS),
    redistributable: z.boolean(),
  })
  .strict();

export type DepsClosureEntry = z.infer<typeof DepsClosureEntrySchema>;
