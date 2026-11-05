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
  status: 'needs-review',
  market: {
    kind: 'plugin',
    route: 'unconfirmed',
    installMethod: 'npm',
    requires: [],
    conflicts: ['与其他桌宠/陪伴插件同时启用会重复占用界面位置。'],
  },
  ...withAudit('plg-dsh-pet', {
    reason:
      '已声明支持 0.2.1-rc.3；体积约 71 MB，闭包含 GPL-3.0-only 组件，本产品尚未在新宿主上验收。',
    blockers: [
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
    '当前不可安装：尚未完成新宿主上的验收；GPL-3.0-only 依赖的分发义务仍需评估。',
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
  market: {
    kind: 'plugin',
    route: 'unconfirmed',
    installMethod: 'npm',
    requires: [],
    conflicts: [],
    attention: {
      source: 'github',
      stars: 6863,
      queriedAt: EVALUATED_AT,
      url: 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget',
    },
  },
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
    risk: '依赖大量宿主内部包；历史实测在旧宿主 0.2.0-rc.2 上安装失败。',
  },
  category: 'dev-tools',
  labels: ['community', 'not-verified'],
  keywords: ['acp', 'zed', 'editor', 'ide'],
  status: 'blocked',
  market: {
    kind: 'plugin',
    route: 'unconfirmed',
    installMethod: 'npm',
    requires: [],
    conflicts: [],
  },
  ...withAudit('plg-dsh-zed-acp', {
    reason: '历史实测在旧宿主 0.2.0-rc.2 上 `dsh plugin add` 失败（peer 版本不被接受），需要版本豁免才能装。',
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
    risk: '会把会话内容写入自有存储；历史实测在旧宿主 0.2.0-rc.2 上安装失败（需要授权依赖构建脚本）。',
  },
  category: 'memory',
  labels: ['community', 'not-verified', 'memory'],
  keywords: ['memory', 'recall', 'long-term'],
  status: 'blocked',
  market: {
    kind: 'plugin',
    route: 'unconfirmed',
    installMethod: 'npm',
    requires: [],
    conflicts: ['与宿主原生会话记忆并行写入可能产生两套记忆，需先明确以哪一套为准。'],
  },
  ...withAudit('plg-dsh-auto-memory', {
    reason:
      '历史实测在旧宿主 0.2.0-rc.2 上安装失败（依赖需要运行构建脚本，被 pnpm 拦截）；且 PRD CR-1 要求优先使用宿主原生记忆。',
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
        detail: '未声明 dsh.compatibility.dshReleases，无法判断是否支持 0.2.1-rc.3。',
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
  market: {
    kind: 'tool',
    route: 'unconfirmed',
    installMethod: 'npm',
    requires: [],
    attention: {
      source: 'github',
      stars: 10761,
      queriedAt: EVALUATED_AT,
      url: 'https://github.com/dsh-market/dsh-market',
    },
    conflicts: ['会在本产品之外另开一条插件安装通道。'],
  },
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
  market: {
    kind: 'reference',
    route: 'unconfirmed',
    installMethod: 'npm',
    requires: [],
    conflicts: [],
  },
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
  market: {
    kind: 'tool',
    route: 'unconfirmed',
    installMethod: 'npm',
    requires: [],
    conflicts: ['会在本产品之外另开一条插件安装通道。'],
  },
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
 * 2026-11-05 第二轮生态调研收录。
 *
 * 这一组与上面 7 条"npm 已评估包"不同：其中 4 条来自 GitHub（npm 上不存在或已下架），
 * 没有 dist.integrity 可核对；2 条来自 npm。它们**都没有**在本产品锁定宿主上完成安装与
 * 使用验证，因此全部保持 `needs-review`/`blocked`，不开放安装按钮。
 *
 * 星标是 2026-11-05 当天的公开关注度，只代表关注度，不代表安装量或真实用户量。
 */
export const DSH_AURABOT_QQ: CatalogCandidate = {
  id: 'plg-dsh-aurabot-qq',
  name: 'dsh-aurabot-qq',
  version: '1.1.24',
  publishTimestamp: 1793435262,
  source: {
    type: 'git',
    url: 'https://github.com/aureth-labs/dsh-aurabot-qq',
    commit: 'b3301f6b014016e141c07d266a716c0fea566aab',
  },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  depsClosure: [],
  en: {
    name: 'Aurabot for QQ',
    summary: 'All-in-one QQ companion plugin: persona, memory, voice, memes, QZone and proactive messages.',
  },
  zh: {
    name: 'Aurabot（大肥鱼 QQ 陪伴）',
    summary: '把 Harness 里的 AI 以独立 QQ 号「大肥鱼」接进 QQ，自带人设、记忆、语音、表情包与空间日记。',
    description:
      '经 SnowLuma 或其它 OneBot v11 网关接入 QQ。左侧栏提供独立面板，人格、记忆、语音、表情包、主动搭话、空间日记等都能在插件自己的设置页里开关。属于功能完整的陪伴型插件，不是本产品重新实现的能力。',
    risk:
      '代码为 MIT，但角色图片/动画素材是 CC BY-NC-SA 4.0（禁止商业使用），且 50 MB+ 素材由插件首次启动时自行下载。包未声明 dsh.compatibility，README 只给出 GitHub 安装命令（仍指向旧组织名）；本产品未在 0.2.1-rc.3 + web profile 上实测。',
  },
  category: 'companion',
  labels: ['community', 'not-verified', 'persona', 'voice', 'memory', 'meme', 'qzone', 'proactive'],
  keywords: ['qq', 'companion', 'persona', 'memory', 'voice', 'meme', 'qzone', 'snowluma'],
  status: 'needs-review',
  market: {
    kind: 'plugin',
    route: 'personal-qq',
    installMethod: 'github',
    requires: [
      'SnowLuma（用户自行下载、启动并登录）或其它 OneBot v11 网关',
      '一个专门用来当机器人的 QQ 小号',
      '语音功能可选：可创建虚拟环境的 Python 或 uv（edge-tts）',
      '翻唱/RVC 仅 Windows，需要用户自行准备音色与额外组件',
    ],
    conflicts: [
      '不要让 Aurabot 与官方 QQ 机器人、qq-bridge、dsh-qq-link 等同时接管同一个 QQ 号或群。',
      'Aurabot 可以启停用户已安装的 SnowLuma，但不会替你下载或同意 SnowLuma 协议；不要与另一个同样管理 SnowLuma 的工具同时启动。',
    ],
    attention: {
      source: 'github',
      stars: 383,
      queriedAt: EVALUATED_AT,
      url: 'https://github.com/aureth-labs/dsh-aurabot-qq',
    },
    sizeNote: '仓库约 20 MB；角色素材 50 MB+ 由插件首次启动时从素材仓库另行下载，不计入插件包体积。',
    compatibilityNote:
      'package.json 未声明 dsh.compatibility。2026-11-05 在隔离环境实测：从 GitHub 安装 1.1.24 到 DSH 0.2.1-rc.3 的 web profile 成功，重启后左侧栏出现 Aurabot 面板，5 步向导可完成；真实 QQ 收发未验证。',
    support: {
      windowsX64: 'verified',
      lockedDsh: 'verified',
      webProfile: 'verified',
      note:
        '2026-11-05 隔离环境（DSH 0.2.1-rc.3 + web profile）验证了安装、面板加载、向导流程与人设保存；QQ 网关用本地模拟 OneBot v11 服务代替真实 QQ，因此「能收发消息」仍未验证。',
    },
  },
  review: {
    reason:
      '功能与关注度都符合目标，但未声明宿主兼容性、未做依赖闭包审计，素材许可禁止商业使用；需先在锁定宿主上完成安装与真实 QQ 收发验证。',
    blockers: [
      {
        code: 'no-declared-compatibility',
        detail: 'package.json 没有 dsh.compatibility.dshReleases；兼容性只有本产品 2026-11-05 的实测记录，上游仍未声明。',
      },
      {
        code: 'closure-not-audited',
        detail: '尚未对 GitHub 安装后的传递依赖做许可闭包审计。',
      },
      {
        code: 'asset-license-restricted',
        detail: '代码 MIT，但角色素材 CC BY-NC-SA 4.0（禁止商业使用），且由插件运行时另行下载。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 0,
      dependencyCount: 0,
      peerDependencyCount: 0,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: 'https://github.com/aureth-labs/dsh-aurabot-qq',
    installProbe: {
      hostDsh: '0.2.1-rc.3',
      probedAt: '2026-11-05T03:35:00.000+08:00',
      installed: true,
      listed: true,
      elapsedMs: 23300,
    },
  },
  installNotes: [
    '本产品仍不提供一键安装：上游未声明宿主兼容性、素材许可禁止商业使用，真实 QQ 收发也未验证。',
    '2026-11-05 的隔离实测可用以下官方方式安装（需要能访问 GitHub）：dsh plugin --profile web add github:accomplish07zrh-eng/dsh-aurabot-qq；安装后需要重启 Harness。',
    '安装后请先打开插件自己的设置页完成 5 步向导，人设、记忆、语音都要在插件里配置，不要在本产品里重新实现。',
  ],
  repository: { url: 'https://github.com/aureth-labs/dsh-aurabot-qq' },
  homepage: 'https://github.com/aureth-labs/dsh-aurabot-qq#readme',
  author: 'Aurabot contributors',
};

export const DSH_MEME: CatalogCandidate = {
  id: 'plg-dsh-meme',
  name: 'dsh-meme',
  version: '0.1.77',
  publishTimestamp: 1793784899,
  source: { type: 'npm' },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  integrity: 'sha512-gJe0hzKd2L+FYhD8Z9bmp9efY1Pc7gaWxQMiP+3F4sWxdcpRe+ydTUklMGp5bVxmAj6u6ioOJ/U24VxCiffgXQ==',
  depsClosure: [],
  en: {
    name: 'dsh-meme',
    summary: 'Meme/sticker plugin for Harness: picker in the composer, mood-driven sending, image learning and pack marketplace.',
  },
  zh: {
    name: '表情包插件（dsh-meme）',
    summary: '输入框旁一键发表情包，支持按情绪/关键词搜图、AI 学图与图库市场。',
    description:
      '表情包以 Harness 插件自己的设置页管理；QQ 场景经官方 QQ 机器人（dsh-qqbot）或 dsh-im 发送原生图片。属于图片与表情包能力，不负责人设、记忆或 QQ 接入。',
    risk:
      'QQ 缩图依赖可选的 sharp（未安装时按原图发送）；对 dsh-qqbot 会话发送图片时，需要把图库目录加入 qqbot 的 sendFile.extraRoots。图库图片版权归各图库说明，内置图库随包分发。',
  },
  category: 'images-memes',
  labels: ['community', 'not-verified', 'meme'],
  keywords: ['meme', 'sticker', 'image', 'qq', 'qqbot'],
  status: 'needs-review',
  market: {
    kind: 'plugin',
    route: 'unconfirmed',
    installMethod: 'npm',
    requires: [
      '可选：官方 QQ 机器人（dsh-qqbot）或 dsh-im，用于把表情包发到 QQ',
      '可选：sharp（QQ 缩图；未安装时按原图发送）',
    ],
    conflicts: [
      '与其他表情包插件同时启用会出现两套选图入口和两套图库目录，建议只保留一套。',
    ],
    attention: {
      source: 'github',
      stars: 509,
      queriedAt: EVALUATED_AT,
      url: 'https://github.com/yyh-001/dsh-meme',
    },
    compatibilityNote: 'package.json 未声明 dsh.compatibility；npm 包体积约 4.4 MB，核心功能无第三方运行依赖。',
    support: {
      windowsX64: 'unverified',
      lockedDsh: 'unverified',
      webProfile: 'declared',
      note: 'package.json 声明 dsh.client.platform: web；Windows x64 与 0.2.1-rc.3 未实测。',
    },
  },
  review: {
    reason:
      'npm 包存在且可追溯、体积可控，但 package.json 未声明宿主兼容版本，也尚未在锁定 0.2.1-rc.3 上做安装与 QQ 发图实测。',
    blockers: [
      {
        code: 'no-declared-compatibility',
        detail: 'package.json 没有 dsh.compatibility.dshReleases；README 未给出 0.2.1-rc.3 的验证记录。',
      },
      {
        code: 'closure-not-audited',
        detail: '尚未对该版本的传递依赖闭包做许可审计（包本身无 dependencies，但可选依赖 sharp 为原生模块）。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 4434917,
      dependencyCount: 0,
      peerDependencyCount: 1,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: `${REGISTRY}/dsh-meme`,
  },
  installNotes: [
    '当前不可安装：未完成锁定宿主上的安装与 QQ 发图验证。',
    '官方安装方式（未验证）：在 DSH 插件市场搜索 dsh-meme，或使用 npm 包名安装；安装后重启 DSH。',
    'QQ 发图需要在 dsh-qqbot 的 sendFile.extraRoots 中加入图库目录，否则会被路径白名单拦截。',
  ],
  repository: { url: 'https://github.com/yyh-001/dsh-meme' },
  homepage: 'https://yyh-001.github.io/dsh-meme/',
  author: 'yyh-001',
};

export const QQ_BRIDGE: CatalogCandidate = {
  id: 'plg-qq-bridge',
  name: 'qq-bridge',
  version: '0.2.1-r2',
  publishTimestamp: 1793465055,
  source: {
    type: 'git',
    url: 'https://github.com/Derpyu520/qq-bridge',
    commit: 'b77e4a26a730d10a8c45982eadce554bd1f0a969',
  },
  license: { spdx: 'PolyForm-Noncommercial-1.0.0', redistributable: false, needsReview: true },
  depsClosure: [],
  en: {
    name: 'qq-bridge',
    summary: 'Standalone bridge between SnowLuma OneBot v11 and DeepSeek Harness Web API.',
  },
  zh: {
    name: 'QQ 桥接程序（qq-bridge）',
    summary: '独立的本地桥接程序，把 SnowLuma 的 OneBot v11 消息与 Harness Web 会话互相转发。',
    description:
      '不是 DSH 插件，也不安装 SnowLuma：单独运行一个 Node 进程，读取本机 OneBot 配置与令牌，把 QQ 消息转成 Harness 提示词，再把回复发回 QQ。适合已经能自行维护桥接进程的用户参考。',
    risk:
      '当前 v0.2.1-r2 使用 PolyForm Noncommercial 1.0.0（禁止商业用途）；v0.2.1-r1 及更早版本才是 MIT。npm 上的历史版本已全部撤回，只能从 GitHub 获取。安装会执行 postinstall 修补本机 @snowluma/sdk。',
  },
  category: 'qq-bot',
  labels: ['community', 'not-verified', 'bridge', 'needs-snowluma'],
  keywords: ['qq', 'bridge', 'onebot', 'snowluma'],
  status: 'blocked',
  market: {
    kind: 'bridge',
    route: 'personal-qq',
    installMethod: 'manual',
    requires: [
      'SnowLuma（用户自行安装、启动并登录，开启 OneBot v11 HTTP 与 WebSocket）',
      'Node.js ≥ 22.13（README 要求）',
      '本机可用的 DSH Web 会话与模型配置',
      'git 与 npm（README 的安装方式）',
    ],
    conflicts: [
      '不要与 Aurabot、dsh-qq-link 或其他桥接程序同时接管同一 QQ 会话，否则会重复回复。',
      '会读取本机 OneBot 配置与接入令牌，并修补本机 @snowluma/sdk。',
      '本产品不自动部署 SnowLuma，也不引入 NapCat 作为默认路线。',
    ],
    attention: {
      source: 'github',
      stars: 3535,
      queriedAt: EVALUATED_AT,
      url: 'https://github.com/Derpyu520/qq-bridge',
    },
    sizeNote: 'GitHub 仓库体积约 12 MB，不等于解压后依赖占用。',
    compatibilityNote:
      'README 记录 DSH 0.2.0-rc.2 / 0.2.1-rc.2 有验证；但它是独立桥接程序，不是可挂载的 Harness 插件。',
    support: {
      windowsX64: 'declared',
      lockedDsh: 'declared',
      webProfile: 'declared',
      note: 'README 要求 Windows 10/11 + Node.js ≥ 22.13，并记录 0.2.0-rc.2 验证；但项目本身不是插件。',
    },
  },
  review: {
    reason:
      '不是 Harness 插件（没有 dsh.bundle.patch），且当前版本许可证禁止商业用途；npm 历史版本已撤回，安装会执行 postinstall。',
    blockers: [
      {
        code: 'not-a-bundle',
        detail: '项目是独立桥接程序，package.json 没有 dsh.bundle.patch，不能作为 Harness 插件挂载。',
      },
      {
        code: 'noncommercial-license',
        detail: 'v0.2.1-r2 使用 PolyForm Noncommercial 1.0.0；仅 v0.2.1-r1 及更早版本为 MIT，必须按具体版本核实。',
      },
      {
        code: 'install-script',
        detail: 'package.json 声明 postinstall（node scripts/patch-snowluma-sdk.mjs），npm install 时会修改本机文件。',
      },
      {
        code: 'no-declared-compatibility',
        detail: 'package.json 未声明 dsh.compatibility；README 只给出 0.2.0-rc.2 / 0.2.1-rc.2 的验证记录。',
      },
      {
        code: 'closure-not-audited',
        detail: '尚未对该版本的传递依赖闭包做许可审计。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'PolyForm-Noncommercial-1.0.0',
      unpackedSizeBytes: 0,
      dependencyCount: 7,
      peerDependencyCount: 0,
      hasBundlePatch: false,
      declaredDshReleases: [],
      hasInstallScript: true,
      maintainers: 1,
    },
    source: 'https://github.com/Derpyu520/qq-bridge',
  },
  installNotes: [
    '当前不可安装：它不是 DSH 插件，且当前版本禁止商业使用；本产品不代装独立桥接程序。',
    '如仅作个人了解，请先阅读官方安装指南，并自行确认版本与许可证（v0.2.1-r1 及更早为 MIT，v0.2.1-r2 起为非商业许可）。',
    '本产品不下载、不打包、不启动 SnowLuma，也不提供该桥接程序的自动更新。',
  ],
  repository: { url: 'https://github.com/Derpyu520/qq-bridge' },
  homepage: 'https://github.com/Derpyu520/qq-bridge#readme',
  author: 'Derpyu520',
};

export const DSH_DAFEIYU_DOT: CatalogCandidate = {
  id: 'plg-dsh-dafeiyu-dot',
  name: 'dsh-dafeiyu-dot',
  version: '0.11.1',
  publishTimestamp: 1793633076,
  source: {
    type: 'git',
    url: 'https://github.com/wz20/dsh-dafeiyu-dot',
    commit: 'ff288f57a25becfe195201b02e4fc4726ae71a5b',
  },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  depsClosure: [],
  en: {
    name: 'dsh-dafeiyu-dot',
    summary: 'Companion plugin with emotional voice, memory palace, QQ, voice calls and a bookkeeping widget.',
  },
  zh: {
    name: '大肥鱼陪伴插件（dsh-dafeiyu-dot）',
    summary: '带情绪语音、记忆宫殿、QQ 接入与语音通话的陪伴插件，另有记账挂件。',
    description:
      '在 Harness 里配置角色、声音与记忆，并通过 QQ 发送语音和主题表情。',
    risk:
      'README 以 DSH 0.2.1-rc.3 为验证基线；语音/记忆依赖额外的本地服务或 API key，本产品尚未验证。',
  },
  category: 'companion',
  labels: ['community', 'not-verified', 'persona', 'voice', 'memory'],
  keywords: ['companion', 'persona', 'voice', 'memory', 'qq'],
  status: 'needs-review',
  market: {
    kind: 'plugin',
    route: 'personal-qq',
    installMethod: 'github',
    requires: [
      'SnowLuma 或 NapCat 等 OneBot 11 网关（用户自行安装）',
      '语音功能可选：本地 VoiceStudio/audio.cpp 或 BreezeBlue 官方 API',
      '记忆与语音数据保存在本地，需自行备份',
    ],
    conflicts: [
      '不要与 Aurabot 或其他 QQ 桥接同时接管同一个 QQ 会话。',
      '与其它记忆插件同时启用会产生两套记忆库。',
    ],
    attention: {
      source: 'github',
      stars: 4,
      queriedAt: EVALUATED_AT,
      url: 'https://github.com/wz20/dsh-dafeiyu-dot',
    },
    sizeNote: 'GitHub 仓库体积约 20 MB，不等于解压后依赖与素材占用。',
    compatibilityNote: 'README 与 docs/verification.json 的验证基线为 0.2.1-rc.3；package.json 未声明 dsh.compatibility。',
    support: {
      windowsX64: 'declared',
      lockedDsh: 'declared',
      webProfile: 'declared',
      note: 'README 有 Windows 说明与 web client 声明；上游验证基线为 0.2.1-rc.3，本产品尚未实测。',
    },
  },
  review: {
    reason:
      '上游验证基线为 0.2.1-rc.3；未声明兼容性，也未在本产品宿主上做安装与 QQ 实测。',
    blockers: [
      {
        code: 'no-declared-compatibility',
        detail: 'package.json 没有 dsh.compatibility.dshReleases。',
      },
      {
        code: 'closure-not-audited',
        detail: '尚未对 GitHub 安装后的传递依赖与素材做许可闭包审计。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 0,
      dependencyCount: 1,
      peerDependencyCount: 5,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: 'https://github.com/wz20/dsh-dafeiyu-dot',
  },
  installNotes: [
    '当前不可安装：需先在该基线上做安装与兼容性回归。',
    '本产品不因功能完整就默认启用它；请保持“未验证”状态，直到有真实安装与 QQ 收发证据。',
  ],
  repository: { url: 'https://github.com/wz20/dsh-dafeiyu-dot' },
  homepage: 'https://github.com/wz20/dsh-dafeiyu-dot#readme',
  author: 'wz20',
};

export const DSH_QQ_TOOLS: CatalogCandidate = {
  id: 'plg-dsh-qq-tools',
  name: 'dsh-qq-tools',
  version: '0.10.2',
  publishTimestamp: 1793692559,
  source: { type: 'npm' },
  license: { spdx: 'MIT', redistributable: false, needsReview: true },
  integrity: 'sha512-QDQB6uzmLx/TdIDXvtYti9p2UmlDdsjCrOywFpyefmxiyhVkdolOxvaek8bRwxrRMIuB3HfBgHhSJQFr0skGbQ==',
  depsClosure: [],
  en: {
    name: 'dsh-qq-tools',
    summary: 'SnowLuma-only QQ group/private chat tools: history, send, faces, favorites, pokes, friends and QZone.',
  },
  zh: {
    name: 'SnowLuma QQ 工具集（dsh-qq-tools）',
    summary: '给 Harness 会话加 QQ 群/私聊工具：看记录、发消息、收藏表情、戳一戳、好友管理与 QQ 空间。',
    description:
      '11 个工具组加 1 个设置组件，可在插件页逐个开关。只支持 SnowLuma 的 OneBot 11 HTTP/WS 与扩展接口；NapCat 或其他 OneBot 实现不支持。适合已经有大肥鱼类会话、想补充 QQ 操作能力的用户。',
    risk:
      '会读取群/私聊记录、好友资料与 QQ 空间，并具备发消息、改头像、好友管理等写操作；每个操作都需要用户在插件页明确开启。部分接口依赖 SnowLuma 扩展，版本不支持时会返回原始错误。',
  },
  category: 'proactive-social',
  labels: ['community', 'not-verified', 'qzone', 'proactive', 'needs-snowluma'],
  keywords: ['qq', 'tools', 'qzone', 'snowluma', 'onebot'],
  status: 'needs-review',
  market: {
    kind: 'tool',
    route: 'personal-qq',
    installMethod: 'npm',
    requires: [
      'SnowLuma（只支持 SnowLuma；NapCat 等 OneBot 实现不支持）',
      '一个已存在的受管 DSH 会话（用于挂载工具）',
      'SnowLuma 的 OneBot 11 HTTP 与 WebSocket 地址',
    ],
    conflicts: [
      '与官方 QQ 机器人或其他桥接同时处理同一会话，会重复回复或重复执行写操作。',
      '写操作（发消息、改头像、好友管理、QQ 空间）需在插件页逐项开启，不要一次性全开。',
    ],
    attention: {
      source: 'github',
      stars: 0,
      queriedAt: EVALUATED_AT,
      url: 'https://github.com/cyhddyx/dsh-qq-tools',
    },
    compatibilityNote:
      'package.json 声明 dsh: "0.2.x"（范围），但没有精确到 0.2.1-rc.3 的验证记录；本项目要求精确验证。',
    support: {
      windowsX64: 'unverified',
      lockedDsh: 'unverified',
      webProfile: 'declared',
      note: 'package.json 声明 dsh.client.platform: web；Windows x64 与 0.2.1-rc.3 未实测。',
    },
  },
  review: {
    reason:
      'npm 包可追溯、体积小，但只声明 0.2.x 范围，未在锁定 0.2.1-rc.3 上完成安装与写操作实测；且强依赖 SnowLuma 扩展接口。',
    blockers: [
      {
        code: 'no-declared-compatibility',
        detail: 'package.json 只声明 dsh: "0.2.x" 范围，没有 0.2.1-rc.3 的精确验证记录。',
      },
      {
        code: 'closure-not-audited',
        detail: '尚未对该版本的传递依赖闭包做许可审计。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'MIT',
      unpackedSizeBytes: 205875,
      dependencyCount: 0,
      peerDependencyCount: 0,
      hasBundlePatch: true,
      declaredDshReleases: [],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: `${REGISTRY}/dsh-qq-tools`,
  },
  installNotes: [
    '当前不可安装：未完成锁定宿主上的安装与写操作验证。',
    '官方安装方式（未验证）：从 npm 安装 dsh-qq-tools；安装后重启 DSH，并在插件页逐个开启需要的能力。',
    '安装不等于已连接 SnowLuma，也不等于已经可以收发 QQ 消息。',
  ],
  repository: { url: 'https://github.com/cyhddyx/dsh-qq-tools' },
  homepage: 'https://github.com/cyhddyx/dsh-qq-tools#readme',
  author: 'cyhddyx',
};

export const DSH_QQ_LINK: CatalogCandidate = {
  id: 'plg-dsh-qq-link',
  name: 'dsh-qq-link',
  version: '1.5.1',
  publishTimestamp: 1793628032,
  source: {
    type: 'git',
    url: 'https://github.com/Yuuyuko-uu/dsh-qq-link',
    commit: 'fba7e3ee8ffb3a8f819a7823eb05186cfb782ecb',
  },
  license: { spdx: 'LicenseRef-Yuuyuko-1.2', redistributable: false, needsReview: true },
  depsClosure: [],
  en: {
    name: 'dsh-qq-link',
    summary: 'Two-way QQ link for a Harness AI companion over OneBot 11 HTTP (SnowLuma or NapCat).',
  },
  zh: {
    name: '通到 QQ（dsh-qq-link）',
    summary: '让 Harness 里的 AI 伙伴与 QQ 双向互通：它说完话自动发到 QQ，QQ 里的话自动转进 DSH。',
    description:
      '走 OneBot 11 HTTP（SnowLuma / NapCat 均可），不是独立桥接进程。支持私聊与群会话分别绑定，并可通过插件设置页配置后端地址。',
    risk:
      'package.json 声明兼容 DSH 0.2.1-rc.3。使用自定义许可（允许安装、修改与商用，但再分发必须保留署名与许可）。需要用户自行准备 OneBot 后端。',
  },
  category: 'qq-bot',
  labels: ['community', 'not-verified', 'bridge', 'needs-snowluma'],
  keywords: ['qq', 'onebot', 'snowluma', 'napcat', 'link'],
  status: 'needs-review',
  market: {
    kind: 'plugin',
    route: 'personal-qq',
    installMethod: 'github',
    requires: [
      'OneBot 11 后端：SnowLuma 或 NapCat（用户自行安装并登录）',
      '需在设置页填写后端 HTTP 地址与端口',
    ],
    conflicts: [
      '不要与官方 QQ 机器人、Aurabot 或 qq-bridge 同时接管同一 QQ 会话。',
      '群聊与私聊绑定同一会话时，插件会提示“两边都发”，可能造成重复发言。',
    ],
    attention: {
      source: 'github',
      stars: 164,
      queriedAt: EVALUATED_AT,
      url: 'https://github.com/Yuuyuko-uu/dsh-qq-link',
    },
    sizeNote: 'GitHub 源项目，也已发布 npm 包；大小以实际安装后占用为准。',
    compatibilityNote: 'dsh.compatibility.dshReleases 声明兼容 0.2.1-rc.3。',
    support: {
      windowsX64: 'unverified',
      lockedDsh: 'declared',
      webProfile: 'declared',
      note: 'package.json 声明 dsh.client.platform: web；兼容列表只有 0.2.1-rc.3。',
    },
  },
  review: {
    reason:
      '声明兼容 0.2.1-rc.3；自定义许可虽允许使用，但再分发有署名与同许可要求。',
    blockers: [
      {
        code: 'closure-not-audited',
        detail: '尚未对 GitHub 安装后的传递依赖闭包做许可审计。',
      },
    ],
    evaluatedAt: EVALUATED_AT,
    facts: {
      license: 'LicenseRef-Yuuyuko-1.2',
      unpackedSizeBytes: 0,
      dependencyCount: 0,
      peerDependencyCount: 0,
      hasBundlePatch: true,
      declaredDshReleases: ['0.2.1-rc.3'],
      hasInstallScript: false,
      maintainers: 1,
    },
    source: 'https://github.com/Yuuyuko-uu/dsh-qq-link',
  },
  installNotes: [
    '声明兼容当前宿主；真实 QQ 收发和许可闭包仍需验证。',
  ],
  repository: { url: 'https://github.com/Yuuyuko-uu/dsh-qq-link' },
  homepage: 'https://github.com/Yuuyuko-uu/dsh-qq-link#readme',
  author: 'Yuuyuko-uu',
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
  DSH_AURABOT_QQ,
  DSH_MEME,
  DSH_QQ_TOOLS,
  DSH_WHALE_WIDGET,
  DSH_ZED_ACP,
  DSH_PET,
  DSH_DAFEIYU_DOT,
  DSH_QQ_LINK,
  QQ_BRIDGE,
  DSH_AUTO_MEMORY,
  DSHMARKET,
  DSH_PLUGIN_CATALOG,
  DSH_PLUGIN_MALL,
];
