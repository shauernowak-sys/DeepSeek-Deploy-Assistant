import type { CatalogCandidate, CatalogCandidateAudit } from '@dda/spec';

import { CANDIDATE_AUDITS } from '../data/candidate-audits';

/**
 * D09 完整策展：评估过但**不允许安装**的候选插件。
 *
 * 规则（由 `collectCandidateProblems()` 强制）：
 * - 候选**不进** `index.json`（索引只列可安装条目），只进 overlay；
 * - 每个候选必须给出结构化拒绝理由（受控 `code` + 具体 `detail`）；
 * - `review.facts` 是 npm registry 取到的事实，`review.closureAudit` / `review.installProbe`
 *   是**真实执行**得到的证据（D11 闭包审计 + D03 侧 `dsh plugin add`），三者必须自洽。
 *
 * 取数时间：2026-11-05（`registry.npmjs.org`，`dist-tags.latest`）。
 * 审计：`npm run audit:candidates`（隔离目录，`--ignore-scripts`，独立 store）+ 隔离 `DSH_HOME` 的
 * `dsh plugin add` / `plugin list`（宿主固定 `0.2.0-rc.2`）。原始报告见
 * `docs/M4-D09-完整策展-实施报告.md` §6。
 *
 * 这 7 个候选来自 `keywords:dsh-plugin` / `keywords:deepseek-harness` 的检索结果，
 * 按「与 V0.1 目标相关（QQ/陪伴/记忆/市场/开发工具）」人工筛选，不代表全生态普查。
 */

const EVALUATED_AT = '2026-11-05';
const REGISTRY = 'https://registry.npmjs.org';

function audited(id: string): CatalogCandidateAudit {
  const audit = CANDIDATE_AUDITS[id];
  if (audit === undefined) throw new Error(`缺少审计证据: ${id}（先跑 npm run audit:candidates）`);
  return audit;
}

/** 审计证据原样挂到条目上：闭包只从审计结果来，不手写。 */
function withAudit(
  id: string,
  review: CatalogCandidate['review'],
): Pick<CatalogCandidate, 'depsClosure' | 'review'> {
  const audit = audited(id);
  return {
    depsClosure: audit.depsClosure,
    review: {
      ...review,
      closureAudit: audit.closureAudit,
      ...(audit.installProbe === undefined ? {} : { installProbe: audit.installProbe }),
    },
  };
}

const WHALE_WIDGET_AUDIT = audited('plg-dsh-whale-widget');
const PET_AUDIT = audited('plg-dsh-pet');
const DSHMARKET_AUDIT = audited('plg-dshmarket');
const PLUGIN_CATALOG_AUDIT = audited('plg-dsh-plugin-catalog');
const PLUGIN_MALL_AUDIT = audited('plg-dsh-plugin-mall');

const seconds = (ms: number | undefined) => Math.round((ms ?? 0) / 1000);

export const DSH_PET: CatalogCandidate = {
  id: 'plg-dsh-pet',
  name: 'dsh-pet',
  version: '0.4.3',
  publishTimestamp: 1793805215,
  source: { type: 'npm' },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  integrity:
    'sha512-pKNt+rd9xHi5CaVsc7qDPJlKkX6GuzRC6h0k/2ckio6tZfZH21nPe+7GUC1fB3etDGLlZMTiaa/Q1F2ljdRxOw==',
  en: {
    name: 'dsh-pet',
    summary: 'A desktop-pet style companion widget that lives inside the Harness web interface.',
  },
  zh: {
    name: '桌面宠物伙伴',
    summary: '常驻 Harness 网页界面的「电子宠物」式陪伴小组件。',
    description:
      '在 Harness 界面里养一只会互动的伴侣角色，支持表情/动作与语音合成。功能属于陪伴互动类，不是 QQ 接入。',
    risk: '包体约 71 MB；闭包含一个 GPL-3.0-only 组件，不得随我方产物分发；发布者为个人账号。',
  },
  category: 'companion',
  labels: ['community', 'not-verified'],
  keywords: ['companion', 'pet', 'widget'],
  status: 'blocked',
  ...withAudit('plg-dsh-pet', {
    reason:
      '声明只兼容 0.2.1-rc.2 及更新的宿主（与锁定 0.2.0-rc.2 不符），体积约 71 MB，闭包含 GPL-3.0-only 组件。',
    blockers: [
      {
        code: 'host-version-incompatible',
        detail: 'dsh.compatibility.dshReleases 只列 0.2.1-rc.2 / 0.2.1-rc.3 / 0.2.2-alpha.2，不含锁定的 0.2.0-rc.2。',
      },
      {
        code: 'size-excessive',
        detail: 'unpackedSize 74 298 788 B（约 71 MB），远超首批策展的体积预期。',
      },
      {
        code: 'closure-needs-review',
        detail: `闭包 ${PET_AUDIT.closureAudit.packageCount} 包中 @andresaya/edge-tts 为 GPL-3.0-only：随包分发需法务判断 copyleft 义务。`,
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 74298788,
      dependencyCount: 6,
      peerDependencyCount: 12,
      hasBundlePatch: true,
      declaredDshReleases: ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.2-alpha.2'],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: `${REGISTRY}/dsh-pet`,
  }),
  installNotes: [
    '当前不可安装：与锁定宿主版本不兼容；即使装上也不得随我方产物分发（GPL-3.0-only 依赖）。',
    `实测记录：dsh plugin add ${PET_AUDIT.installProbe?.installed === true ? '可装入 profile 并出现在 plugin list' : '未成功'}（参考，不代表可用）。`,
  ],
  repository: { url: 'https://github.com/PC2005-cloud/dsh-pet' },
  homepage: 'https://github.com/PC2005-cloud/dsh-pet#readme',
  author: 'PC2005-cloud',
};

export const DSH_WHALE_WIDGET: CatalogCandidate = {
  id: 'plg-dsh-whale-widget',
  name: 'dsh-whale-widget',
  version: '0.4.2',
  publishTimestamp: 1791721632,
  source: { type: 'npm' },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  integrity:
    'sha512-aGDUfd3b2Abv4PoUn1KtnlasOIkoqgvIOR2+rAIEPDOt1qlHB7emlTq+4zdyoV5ZiicS+tkugPk86GyVUoDggQ==',
  en: {
    name: 'Balance Whale Widget',
    summary: 'A small corner widget that shows the DeepSeek account balance inside the Harness web UI.',
  },
  zh: {
    name: '余额小鲸鱼挂件',
    summary: '在 Harness 网页右下角显示 DeepSeek 余额的小挂件。',
    description: '纯界面挂件：把账户余额画成一只鲸鱼并显示在页面角落，不涉及会话或 QQ 收发。',
    risk: '需要读取账户余额信息；发布者为个人账号，未经过本产品业务验收。',
  },
  category: 'ui-widget',
  labels: ['community', 'not-verified'],
  keywords: ['widget', 'balance', 'ui'],
  status: 'needs-review',
  ...withAudit('plg-dsh-whale-widget', {
    reason:
      '闭包仅 1 包且全部 MIT，已实测可装入锁定宿主 profile 并列出；但包自身未声明宿主兼容版本，仍待业务验收。',
    blockers: [
      {
        code: 'no-declared-compatibility',
        detail: 'package.json 没有 dsh.compatibility.dshReleases；兼容性只能靠实测与后续回归确认。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 7220176,
      dependencyCount: 0,
      peerDependencyCount: 0,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: `${REGISTRY}/dsh-whale-widget`,
  }),
  installNotes: [
    `已实测：dsh plugin add 成功并出现在 plugin list（${seconds(WHALE_WIDGET_AUDIT.installProbe?.elapsedMs)} s）。`,
    '仍未做业务验收（余额是否正确显示、是否影响宿主布局），因此不给安装按钮。',
  ],
  repository: { url: 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget' },
  homepage: 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget#readme',
  author: 'MeteorNOX',
};

export const DSH_ZED_ACP: CatalogCandidate = {
  id: 'plg-dsh-zed-acp',
  name: '@8kugames/dsh-zed-acp',
  version: '0.3.9',
  publishTimestamp: 1793689342,
  source: { type: 'npm' },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  integrity:
    'sha512-J16qJOiSId2dFu2ZmPgw0ouSDyDwByRyHOyMcRPo1mi49HPy/RSuLGx1CflK0UBgw5fchmrF6a01Nghe0hx8BA==',
  en: {
    name: 'dsh-zed-acp',
    summary: 'Bridges the Harness agent to the Zed editor over the Agent Client Protocol.',
  },
  zh: {
    name: 'Zed 编辑器 ACP 桥',
    summary: '通过 Agent Client Protocol 把 Harness Agent 接到 Zed 编辑器。',
    description: '面向开发者的编辑器集成：在 Zed 里直接调用 Harness 的 agent 能力。',
    risk: '依赖大量宿主内部包；实测在锁定宿主上安装失败。',
  },
  category: 'dev-tools',
  labels: ['community', 'not-verified'],
  keywords: ['acp', 'zed', 'editor', 'ide'],
  status: 'blocked',
  ...withAudit('plg-dsh-zed-acp', {
    reason: '实测在锁定宿主 0.2.0-rc.2 上 `dsh plugin add` 失败（peer 版本不被接受），需要版本豁免才能装。',
    blockers: [
      {
        code: 'host-version-incompatible',
        detail:
          '安装被宿主拒绝并提示需要 allow-version @8kugames/dsh-zed-acp@0.3.9 --dsh-version 0.2.0-rc.2 --accept-risk：' +
          '说明该版本与锁定宿主不是被接受的组合。',
      },
      {
        code: 'install-failed',
        detail: 'dsh plugin add 退出码非 0（输出 "nothing was installed"），profile 未发生变化。',
      },
      {
        code: 'no-declared-compatibility',
        detail: '未声明 dsh.compatibility.dshReleases；peer 依赖覆盖 36 个 @deepseek-ai 包，版本错配风险高。',
      },
      {
        code: 'install-script',
        detail: 'package.json 声明 prepare 脚本（npm run build）；从 git 安装时会执行。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 865432,
      dependencyCount: 4,
      peerDependencyCount: 36,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: true,
      maintainers: 1,
    },
    source: `${REGISTRY}/%408kugames%2Fdsh-zed-acp`,
  }),
  installNotes: [
    '当前不可安装：锁定宿主拒绝该版本组合（需显式接受风险并做版本豁免，本产品不做）。',
    '闭包本身干净（7 包，MIT/Apache-2.0），失败原因是宿主兼容性而不是许可。',
  ],
  repository: { url: 'https://github.com/8kugames/dsh-zed-acp' },
  homepage: 'https://github.com/8kugames/dsh-zed-acp#readme',
  author: '8kugames',
};

export const DSH_AUTO_MEMORY: CatalogCandidate = {
  id: 'plg-dsh-auto-memory',
  name: '@a9i5k4/dsh-auto-memory',
  version: '3.3.17',
  publishTimestamp: 1792720482,
  source: { type: 'npm' },
  license: { spdx: 'BSD-3-Clause', redistributable: false, needsReview: true },
  integrity:
    'sha512-wZ3XpXVDhiezw3lFfdq1+8F3SfPb6zKscRJ3XTh2Zt5WockkY9x4vdP0LfLxjVY1aD9P3icKBquZWJBFohE6Kw==',
  en: { name: 'dsh-auto-memory', summary: 'Adds automatic long-term memory to Harness conversations.' },
  zh: {
    name: '自动记忆插件',
    summary: '为 Harness 会话增加自动长期记忆。',
    description:
      '把对话内容写入自有记忆库并在后续会话中召回。PRD §10.5-6 已判定基础记忆属于宿主原生能力，插件形态只在用户明确需要跨会话外部记忆时才考虑。',
    risk: '会把会话内容写入自有存储；实测在锁定宿主上安装失败（需要授权依赖构建脚本）。',
  },
  category: 'memory',
  labels: ['community', 'not-verified'],
  keywords: ['memory', 'recall', 'long-term'],
  status: 'blocked',
  ...withAudit('plg-dsh-auto-memory', {
    reason:
      '实测在锁定宿主上安装失败（依赖需要运行构建脚本，被 pnpm 拦截）；且 PRD CR-1 要求优先使用宿主原生记忆。',
    blockers: [
      {
        code: 'install-failed',
        detail: 'dsh plugin add 退出码非 0，输出要求先 `pnpm approve-builds`：安装过程会执行依赖的构建脚本。',
      },
      {
        code: 'native-capability-preferred',
        detail: 'PRD §10.5-6 / CR-1：基础记忆由宿主原生会话持久化提供，插件形态属可选增强。',
      },
      {
        code: 'no-declared-compatibility',
        detail: '未声明 dsh.compatibility.dshReleases，无法判断是否支持 0.2.0-rc.2。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'BSD-3-Clause',
      unpackedSizeBytes: 29719820,
      dependencyCount: 0,
      peerDependencyCount: 1,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: `${REGISTRY}/%40a9i5k4%2Fdsh-auto-memory`,
  }),
  installNotes: [
    '当前不可安装：锁定宿主上安装被拒（需要授权构建脚本），且优先使用宿主原生记忆。',
    '闭包本身干净（1 包，BSD-3-Clause）；失败原因是安装期的脚本授权，不是许可。',
  ],
  repository: { url: 'https://github.com/Aik358/dsh-auto-memory' },
  homepage: 'https://github.com/Aik358/dsh-auto-memory#readme',
  author: 'Aik358',
};

export const DSHMARKET: CatalogCandidate = {
  id: 'plg-dshmarket',
  name: 'dshmarket',
  version: '1.73.11',
  publishTimestamp: 1793820231,
  source: { type: 'npm' },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  integrity:
    'sha512-AkdHRDv/Zd2cpXG2BqM+WDHhsTgCRIsZTESDpYSB1GsjkWD2IqwZoRp/ZPvMFwziYNpNcFImVSYmZLTZiMOZpA==',
  en: {
    name: 'dshmarket',
    summary: 'A third-party plugin market UI inside DeepSeek Harness (browse, search, install).',
  },
  zh: {
    name: '第三方插件市场（dshmarket）',
    summary: '在 Harness 内部提供第三方插件市场的浏览、搜索与安装界面。',
    description:
      '它自带一套插件源与安装入口，与本产品的「策展目录 + 白名单门禁」是竞争关系：一旦安装，用户可在其中装入本产品从未评估过的插件。',
    risk: '会绕过本产品的兼容性与许可门禁；来源与索引内容不受本产品控制。',
  },
  category: 'market',
  labels: ['community', 'not-verified'],
  keywords: ['market', 'catalog', 'install'],
  status: 'blocked',
  ...withAudit('plg-dshmarket', {
    reason: '与本产品的策展职责重复，且会在内部另起一条不受控的安装通道（PRD N8 / Gate 4 ⑤ 冲突）。',
    blockers: [
      {
        code: 'duplicates-product-scope',
        detail: '内置自己的插件源与安装入口，绕过本产品的 compat 与许可门禁（PRD N8 明确不做在线插件市场平台）。',
      },
      {
        code: 'install-script',
        detail: 'package.json 声明 prepare 脚本（npm run build）；从 git 安装时会执行。',
      },
      { code: 'no-declared-compatibility', detail: '未声明 dsh.compatibility.dshReleases。' },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 3096859,
      dependencyCount: 2,
      peerDependencyCount: 3,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: true,
      maintainers: 1,
    },
    source: `${REGISTRY}/dshmarket`,
  }),
  installNotes: [
    `闭包干净、技术上可装（实测 dsh plugin add 成功，${seconds(DSHMARKET_AUDIT.installProbe?.elapsedMs)} s）。`,
    '仍然不推荐：它会绕过本产品的门禁，属于产品范围冲突而非技术失败。',
  ],
  repository: { url: 'https://github.com/dsh-market/dsh-market' },
  homepage: 'https://dshmarket.com',
  author: 'dsh-market',
};

export const DSH_PLUGIN_CATALOG: CatalogCandidate = {
  id: 'plg-dsh-plugin-catalog',
  name: 'dsh-plugin-catalog',
  version: '2026.1104.14928',
  publishTimestamp: 1793766249,
  source: { type: 'npm' },
  license: { spdx: 'CC0-1.0', redistributable: false, needsReview: true },
  integrity:
    'sha512-ibbC9SIfEgjui2jOhi0R7gtGOEqk7ejabAEpUXQSUc16fyAikg2jk8ebo92FPB1YhSUIiZabmcei6JloN7iMkQ==',
  en: {
    name: 'dsh-plugin-catalog',
    summary: 'A data-only catalog of community DSH plugins (no runtime plugin entry).',
  },
  zh: {
    name: '社区插件目录（数据包）',
    summary: '一份社区插件清单的数据包，不含可挂载的插件入口。',
    description:
      '内容是插件元数据（CC0-1.0），本身不是 DSH 插件：没有 dsh.bundle.patch，装到 profile 里也不会被挂载。',
    risk: '容易让用户误以为"装上就有插件市场"；实际只是一份数据。',
  },
  category: 'market',
  labels: ['community', 'not-verified'],
  keywords: ['catalog', 'data', 'awesome-list'],
  status: 'blocked',
  ...withAudit('plg-dsh-plugin-catalog', {
    reason: '不是插件：未声明 dsh.bundle.patch。实测虽然能被 plugin add 装上并列出，但不会成为 bundle 层。',
    blockers: [
      {
        code: 'not-a-bundle',
        detail: 'package.json 没有 dsh.bundle.patch（实测安装后依然为空），安装不会产生可挂载的 bundle 层。',
      },
      { code: 'no-declared-compatibility', detail: '未声明 dsh.compatibility.dshReleases。' },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'CC0-1.0',
      unpackedSizeBytes: 14940131,
      dependencyCount: 0,
      peerDependencyCount: 0,
      hasBundlePatch: false,
      declaredDshReleases: [],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: `${REGISTRY}/dsh-plugin-catalog`,
  }),
  installNotes: [
    `注意：实测 dsh plugin add 会成功并出现在 plugin list（${seconds(PLUGIN_CATALOG_AUDIT.installProbe?.elapsedMs)} s），` +
      '但因为它不是 bundle，"列出"不等于"可用"。',
    '当前不可安装：没有可挂载的插件入口。',
  ],
  repository: { url: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin' },
  homepage: 'https://awesome-dsh-plugin.com',
  author: 'awesome-dsh-plugin',
};

export const DSH_PLUGIN_MALL: CatalogCandidate = {
  id: 'plg-dsh-plugin-mall',
  name: '@1e0zj/dsh-plugin-mall',
  version: '0.4.17',
  publishTimestamp: 1787837528,
  source: { type: 'npm' },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  integrity:
    'sha512-iblSZOwugF02CVBlSSD4sDrb8KUkEoi47s2Rz2yz4v9G6izG0z/ZolIAcH7qn8WGdlGrsSInrS4a4M3SdGguOw==',
  en: { name: 'dsh-plugin-mall', summary: 'Another third-party plugin mall for DeepSeek Harness.' },
  zh: {
    name: '第三方插件商城（dsh-plugin-mall）',
    summary: '另一个在 Harness 内提供插件浏览与安装的商城。',
    description: '功能与 dshmarket 类似：自带插件源与安装入口，不受本产品门禁控制。',
    risk: '会绕过本产品的兼容性与许可门禁；发布者与索引内容无法追溯。',
  },
  category: 'market',
  labels: ['community', 'not-verified'],
  keywords: ['market', 'mall', 'install'],
  status: 'blocked',
  ...withAudit('plg-dsh-plugin-mall', {
    reason: '与本产品的策展职责重复，且安装通道不受本产品门禁控制。',
    blockers: [
      {
        code: 'duplicates-product-scope',
        detail: '自带插件来源与安装入口，绕过本产品的 compat 与许可门禁（PRD N8）。',
      },
      { code: 'no-declared-compatibility', detail: '未声明 dsh.compatibility.dshReleases。' },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 1115600,
      dependencyCount: 2,
      peerDependencyCount: 4,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: `${REGISTRY}/%401e0zj%2Fdsh-plugin-mall`,
  }),
  installNotes: [
    `闭包干净、技术上可装（实测 dsh plugin add 成功，${seconds(PLUGIN_MALL_AUDIT.installProbe?.elapsedMs)} s）。`,
    '仍然不推荐：与本产品的策展与门禁职责冲突。',
  ],
  repository: { url: 'https://github.com/1e0zj/dsh-plugin-mall' },
  homepage: 'https://github.com/1e0zj/dsh-plugin-mall#readme',
  author: '1e0zj',
};

/**
 * 候选清单（顺序即 UI 建议展示顺序：先待评估、后不可用）。
 *
 * 审计后仍然保留的 `blocked` 都基于**真实执行结果**或产品范围冲突，不是"没做功课"：
 * - `dsh-zed-acp` / `dsh-auto-memory`：安装探测失败（peer 不接受 / 需要构建脚本授权）；
 * - `dsh-pet`：声明不兼容 + GPL 依赖；
 * - 两个 market + 数据包：与策展职责重复 / 不是 bundle。
 */
export const CATALOG_CANDIDATES: readonly CatalogCandidate[] = [
  DSH_WHALE_WIDGET,
  DSH_ZED_ACP,
  DSH_PET,
  DSH_AUTO_MEMORY,
  DSHMARKET,
  DSH_PLUGIN_CATALOG,
  DSH_PLUGIN_MALL,
];
