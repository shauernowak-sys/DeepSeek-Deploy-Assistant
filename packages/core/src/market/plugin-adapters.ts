import type { InstalledPluginView, PluginSettingsEntry } from '@dda/spec';

/**
 * 插件适配表：把「装进 profile 的包名」映射成普通用户能看懂的卡片、真实存在的设置入口
 * 和使用引导。
 *
 * 硬性约定（有测试保护）：
 * 1. `settings` 只写**实测过**的入口，并必须带 `verifiedAt` 与 `evidence`；
 * 2. 没有核实过入口的插件不写 `settings`，界面显示「没有可直接打开的设置页」，
 *    而不是编一个地址或按钮；
 * 3. `uninstall.dataNote` 必须说明卸载后哪些数据会保留。无法确认时写「无法确认」，
 *    不得假设用户数据会被删除。
 *
 * 本轮（2026-11-05）实测环境：Windows x64 + DSH 0.2.1-rc.3 + `web` profile，
 * 隔离目录与独立 `DSH_HOME`，不使用真实 QQ 账号。
 */

export interface PluginAdapter {
  /** 对应 `CatalogEntry.id` / `CatalogCandidate.id`，未收录的插件用 `pkg:<name>`。 */
  id: string;
  name: string;
  title: string;
  summary: string;
  /** 使用引导 id；`undefined` 表示没有可复现的真实引导。 */
  guideId?: string;
  settings?: PluginSettingsEntry;
  uninstall: { dataNote: string; restartRequired: boolean };
  requires?: string[];
}

const VERIFIED_AT = '2026-11-05';

export const OFFICIAL_QQBOT_ADAPTER: PluginAdapter = {
  id: 'plg-official-qqbot',
  name: '@tencent-connect/dsh-qqbot',
  title: '官方 QQ 机器人',
  summary: '把 QQ 群聊和私聊接到 Harness：手机 QQ 扫码绑定后即可在群里 @ 机器人对话。',
  guideId: 'guide-official-qqbot',
  settings: {
    kind: 'harness-panel',
    label: '打开 QQ 机器人设置',
    panelLabel: 'QQ 机器人',
    verifiedAt: VERIFIED_AT,
    evidence:
      '隔离环境安装 0.5.5 并启动 Harness 后，网页左侧栏出现「QQ 机器人」；面板内显示扫码绑定二维码、服务范围与基础设置。',
    note: '绑定需要在手机 QQ 上扫码确认；本软件不代替你授权。',
  },
  uninstall: {
    dataNote:
      '卸载会移除插件本体和它在 web 配置环境里的加载条目。已在腾讯 QQ 开放平台完成的授权不受本软件控制，本软件无法替你解除；本软件里保存的 AppID/AppSecret 需要你在「连接 QQ」页单独删除。',
    restartRequired: true,
  },
  requires: ['手机 QQ（扫码授权）', '腾讯 QQ 开放平台上的机器人应用'],
};

export const AURABOT_ADAPTER: PluginAdapter = {
  id: 'plg-dsh-aurabot-qq',
  name: 'dsh-aurabot-qq',
  title: 'Aurabot（大肥鱼 QQ 陪伴）',
  summary: '用一个 QQ 小号扮演「大肥鱼」接入 QQ，自带人设、记忆、语音、表情包和 QQ 空间日记。',
  guideId: 'guide-aurabot-persona',
  settings: {
    kind: 'harness-panel',
    label: '打开 Aurabot 设置',
    panelLabel: 'Aurabot',
    verifiedAt: VERIFIED_AT,
    evidence:
      '隔离环境从 GitHub 安装 1.1.24 并启动 Harness 后，左侧栏「自动化任务」下方出现「Aurabot」；面板内含 5 步设置向导，完成后可进入「人设 → 人格」新建、编辑并保存人设。',
    note: '插件自己的 5 步向导要先走完（需要可用的 QQ 网关），指引与人格编辑才会出现。',
  },
  uninstall: {
    dataNote:
      '实测：卸载只从 web 配置环境移除插件，设置、人设、记忆等数据仍保留在 Harness 数据目录的 plugins-data\\aurabot 下（人设是 personas 目录里的 .md 文件）。需要彻底清除时请手动删除该目录。',
    restartRequired: true,
  },
  requires: [
    '一个专门当机器人的 QQ 小号',
    'SnowLuma（自己下载、启动并登录）或其他 OneBot v11 网关',
    '语音/翻唱可选：本地 Python 或额外组件',
  ],
};

export const PERSONAL_QQ_ADAPTER_ENTRY: PluginAdapter = {
  id: 'pkg:dsh-qq-link',
  name: 'dsh-qq-link',
  title: '个人 QQ 适配插件',
  summary: '把个人 QQ 的 OneBot 会话接到 Harness；配置由本软件的「个人 QQ」页写入。',
  settings: {
    kind: 'app-page',
    label: '打开个人 QQ 设置',
    appPage: 'personal-qq',
    verifiedAt: VERIFIED_AT,
    evidence:
      '本软件的「个人 QQ」页写入 OneBot 地址与 token，并通过适配插件自带的状态接口核对连接（M3.2 验收）。',
    note: '插件自带的网页只是状态查看，日常配置在本软件里完成。',
  },
  uninstall: {
    dataNote:
      '卸载会移除适配插件本身。SnowLuma 本体与它的 QQ 登录状态不归本软件管理，不会被删除；本软件里保存的 OneBot token 需要你在「个人 QQ」页单独清除。',
    restartRequired: true,
  },
  requires: ['SnowLuma 或你自己的 OneBot v11 网关', '一个机器人 QQ 小号'],
};

export const PLUGIN_ADAPTERS: readonly PluginAdapter[] = [
  OFFICIAL_QQBOT_ADAPTER,
  AURABOT_ADAPTER,
  PERSONAL_QQ_ADAPTER_ENTRY,
];

export function findPluginAdapter(name: string): PluginAdapter | undefined {
  return PLUGIN_ADAPTERS.find((adapter) => adapter.name === name);
}

/** 未收录的插件：不编造能力，只给出可安全执行的动作（卸载/重启）。 */
export function describeUnknownPlugin(name: string, version?: string): InstalledPluginView {
  return {
    id: `pkg:${name}`,
    name,
    title: name,
    summary: '本产品还没有为这个插件提供设置入口或使用引导；能力、配置方式和数据位置都未核实。',
    ...(version === undefined ? {} : { version }),
    known: false,
    state: { installed: true, composed: 'unknown', loaded: 'unknown', configured: 'unknown' },
    stateNotes: [
      '它已在 web 配置环境的依赖里，但本软件没有核实它的设置页、配置项和数据目录。',
      '需要设置时，请到 Harness 网页的「插件」页面查看它自己提供的界面。',
    ],
    uninstall: {
      dataNote:
        '卸载只会移除插件本体和它在 web 配置环境里的加载条目。该插件自己保存的数据位置未核实，可能保留在 Harness 数据目录中。',
      restartRequired: true,
    },
  };
}
