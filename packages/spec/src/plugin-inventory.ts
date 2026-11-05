/**
 * 「我的插件」的数据契约。
 *
 * 六段证据口径（技术架构决策 §5）在这里落成显式字段：已下载 / 已安装 / 已加载 / 配置已写入
 * 各自独立，缺证据一律 `unknown`。**不允许**因为安装成功就把「已加载」写成 `yes`
 * ——`dsh-plugin-catalog` 就是能装进 profile 却不是 bundle 的反例。
 */

export const PLUGIN_EVIDENCE = ['yes', 'no', 'unknown'] as const;

export type PluginEvidence = (typeof PLUGIN_EVIDENCE)[number];

/**
 * 设置入口的两种真实形态：
 * - `harness-panel`：插件自己在 Harness 网页左侧栏注册的面板（本轮实测两项）；
 * - `app-page`：本软件里的面板（例如个人 QQ 的适配插件配置由「个人 QQ」页写入）。
 *
 * 没有核实过的入口不要写进来；`verifiedAt` + `evidence` 是它凭什么算核实的唯一依据。
 */
export interface PluginSettingsEntry {
  kind: 'harness-panel' | 'app-page';
  /** 按钮文案。 */
  label: string;
  /** Harness 左侧栏里的入口名（`harness-panel` 必填）。 */
  panelLabel?: string;
  /** 本软件内的页面 id（`app-page` 必填）。 */
  appPage?: 'personal-qq';
  /** 核实日期 YYYY-MM-DD。 */
  verifiedAt: string;
  /** 核实方式与观察到的现象。 */
  evidence: string;
  /** 面向用户的额外说明（例如「需要先完成插件自己的向导」）。 */
  note?: string;
}

export interface InstalledPluginView {
  /** 稳定 id：目录条目 id，或 `pkg:<包名>`。 */
  id: string;
  name: string;
  title: string;
  summary: string;
  version?: string;
  /** 是否在本产品的插件目录里有对应条目（未收录的插件只展示原始信息）。 */
  known: boolean;
  state: {
    installed: boolean;
    /** 组合进 web 配置环境（profile 的 bundle 列表 + `--dump-config` 都包含它）。 */
    composed: PluginEvidence;
    /** 运行中的 Harness 网页是否真的给浏览器下发了这个插件的客户端模块。 */
    loaded: PluginEvidence;
    /** 插件自身的配置是否已写入（只有拿到具体证据时才为 `yes`）。 */
    configured: PluginEvidence;
  };
  /** 「为什么是这个状态」的可读说明，逐条对应上面的字段。 */
  stateNotes: string[];
  settings?: PluginSettingsEntry;
  /** 使用引导 id（真实截图引导）。 */
  guideId?: string;
  uninstall: {
    /** 卸载会保留哪些数据、移除哪些东西（来自实测或插件官方说明）。 */
    dataNote: string;
    /** 卸载后是否必须重启 Harness 才会生效。 */
    restartRequired: boolean;
  };
  /** 使用前需要用户自行准备的外部组件。 */
  requires?: string[];
}

export interface PluginInventorySnapshot {
  harness: {
    deployed: boolean;
    running: boolean;
    url?: string;
    profile: string;
    version?: string;
  };
  plugins: InstalledPluginView[];
  /** 读取过程中遇到的问题（例如插件列表读取失败）；不为空时界面必须显示。 */
  problems: string[];
  checkedAt: string;
}
