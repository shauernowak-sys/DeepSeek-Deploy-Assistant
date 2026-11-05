/**
 * D09 完整策展 · 候选审计证据（**自动生成，不要手改**）。
 *
 * 生成命令：
 *   npm run audit:candidates -- --emit-ts=catalog/data/candidate-audits.ts
 *   （需要 D03 侧证据时再给 --dsh-bin=<dsh>/lib/bin.js，或用 DDA_AUDIT_DSH_BIN）
 *
 * 数据来源：隔离目录真实 `pnpm add`（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包，
 * 以及用锁定版 dsh 在隔离 DSH_HOME 真实 `dsh plugin add` / `plugin list`。
 *
 * 为什么生成而不是手写：闭包有 40+ 条、逐包带裁决，手抄一定会与审计报告对不上。
 */
import type { CatalogCandidateAudit } from '@dda/spec';

export const CANDIDATE_AUDITS: Readonly<Record<string, CatalogCandidateAudit>> = {
  // dsh-whale-widget@0.4.2
  'plg-dsh-whale-widget': {
    depsClosure: [
        { name: 'dsh-whale-widget', version: '0.4.2', license: 'MIT', verdict: 'allowed', redistributable: true },
    ],
    closureAudit: {
      auditedAt: '2026-11-05T00:32:53.106Z',
      method: '隔离目录 + 真实 pnpm 安装（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包 + evaluateClosure 现算裁决',
      verdict: 'allowed',
      packageCount: 1,
      byLicense: [
        { license: 'MIT', count: 1 },
      ],
      denied: [
      ],
      needsReview: [
      ],
    },
    installProbe: {
      hostDsh: '0.2.0-rc.2',
      probedAt: '2026-11-05T00:32:53.106Z',
      installed: true,
      listed: true,
      elapsedMs: 2555,
    },
  },
  // @8kugames/dsh-zed-acp@0.3.9
  'plg-dsh-zed-acp': {
    depsClosure: [
        { name: '@8kugames/dsh-zed-acp', version: '0.3.9', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: '@agentclientprotocol/sdk', version: '1.4.0', license: 'Apache-2.0', verdict: 'allowed', redistributable: true },
        { name: '@deepseek-ai/cosmokit', version: '1.8.6', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: '@deepseek-ai/dsh-brand', version: '0.2.1-rc.5', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: '@deepseek-ai/schemastery', version: '3.18.5', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: '@standard-schema/spec', version: '1.1.0', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'commander', version: '15.0.0', license: 'MIT', verdict: 'allowed', redistributable: true },
    ],
    closureAudit: {
      auditedAt: '2026-11-05T00:32:57.615Z',
      method: '隔离目录 + 真实 pnpm 安装（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包 + evaluateClosure 现算裁决',
      verdict: 'allowed',
      packageCount: 7,
      byLicense: [
        { license: 'MIT', count: 6 },
        { license: 'Apache-2.0', count: 1 },
      ],
      denied: [
      ],
      needsReview: [
      ],
    },
    installProbe: {
      hostDsh: '0.2.0-rc.2',
      probedAt: '2026-11-05T00:32:57.615Z',
      installed: false,
      listed: false,
      elapsedMs: 2198,
      failure: '0.2.1-rc.5","@deepseek-ai/dsh-session-projection-cache":"~0.2.1-rc.5"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for @8kugames/dsh-zed-acp@0.3.9 on dsh 0.2.0-rc.2 with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: not active. / dsh: nothing was installed. / dsh: to accept the risk, run: dsh plugin --profile audit-dsh-zed-acp allow-version @8kugames/dsh-zed-acp@0.3.9 --dsh-vers',
    },
  },
  // dsh-pet@0.4.3
  'plg-dsh-pet': {
    depsClosure: [
        { name: '@andresaya/edge-tts', version: '1.9.1', license: 'GPL-3.0-only', verdict: 'needs-review', redistributable: false },
        { name: '@anthropic-ai/sdk', version: '0.135.0', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: '@babel/runtime', version: '7.29.10', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: '@electron-internal/extract-zip', version: '1.0.8', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: '@electron/get', version: '5.1.0', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: '@opentelemetry/api', version: '1.10.0', license: 'Apache-2.0', verdict: 'allowed', redistributable: true },
        { name: '@stablelib/base64', version: '1.0.1', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'commander', version: '12.1.0', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'debug', version: '4.4.3', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'dsh-pet', version: '0.4.3', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'env-paths', version: '3.0.0', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'fast-sha256', version: '1.3.0', license: 'Unlicense', verdict: 'allowed', redistributable: true },
        { name: 'graceful-fs', version: '4.2.11', license: 'ISC', verdict: 'allowed', redistributable: true },
        { name: 'json-schema-to-ts', version: '3.1.1', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'ms', version: '2.1.3', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'openai', version: '7.39.0', license: 'Apache-2.0', verdict: 'allowed', redistributable: true },
        { name: 'progress', version: '2.0.3', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'semver', version: '7.8.6', license: 'ISC', verdict: 'allowed', redistributable: true },
        { name: 'standardwebhooks', version: '1.1.1', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'sumchecker', version: '3.0.1', license: 'Apache-2.0', verdict: 'allowed', redistributable: true },
        { name: 'ts-algebra', version: '2.0.0', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'ws', version: '8.22.1', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'zod', version: '4.6.7', license: 'MIT', verdict: 'allowed', redistributable: true },
    ],
    closureAudit: {
      auditedAt: '2026-11-05T00:33:03.318Z',
      method: '隔离目录 + 真实 pnpm 安装（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包 + evaluateClosure 现算裁决',
      verdict: 'needs-review',
      packageCount: 23,
      byLicense: [
        { license: 'MIT', count: 16 },
        { license: 'Apache-2.0', count: 3 },
        { license: 'ISC', count: 2 },
        { license: 'GPL-3.0-only', count: 1 },
        { license: 'Unlicense', count: 1 },
      ],
      denied: [
      ],
      needsReview: [
        { name: '@andresaya/edge-tts', version: '1.9.1', license: 'GPL-3.0-only', verdict: 'needs-review', redistributable: false },
      ],
    },
    installProbe: {
      hostDsh: '0.2.0-rc.2',
      probedAt: '2026-11-05T00:33:03.318Z',
      installed: true,
      listed: true,
      elapsedMs: 5233,
    },
  },
  // @a9i5k4/dsh-auto-memory@3.3.17
  'plg-dsh-auto-memory': {
    depsClosure: [
        { name: '@a9i5k4/dsh-auto-memory', version: '3.3.17', license: 'BSD-3-Clause', verdict: 'allowed', redistributable: true },
    ],
    closureAudit: {
      auditedAt: '2026-11-05T00:33:11.533Z',
      method: '隔离目录 + 真实 pnpm 安装（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包 + evaluateClosure 现算裁决',
      verdict: 'allowed',
      packageCount: 1,
      byLicense: [
        { license: 'BSD-3-Clause', count: 1 },
      ],
      denied: [
      ],
      needsReview: [
      ],
    },
    installProbe: {
      hostDsh: '0.2.0-rc.2',
      probedAt: '2026-11-05T00:33:11.533Z',
      installed: false,
      listed: false,
      elapsedMs: 5237,
      failure: '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: onnxruntime-node@1.21.0, protobufjs@7.6.6, sharp@0.34.5 / Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts. / dsh: initialized profile audit-dsh-auto-memory at C:\\Users\\LIU\\AppData\\Local\\Temp\\dda-candidate-audit\\dsh-home\\profiles\\audit-dsh-auto-memory / dsh: plugin command failed; diagnostics: C:\\Users\\LIU\\AppData\\Local\\Temp\\dda-candidate-audit\\dsh-home\\profiles\\audit-dsh-auto-memory\\.plugin-manager\\logs\\operation-aI8Qpu\\pnpm.log',
    },
  },
  // dshmarket@1.73.11
  'plg-dshmarket': {
    depsClosure: [
        { name: 'argparse', version: '2.0.1', license: 'Python-2.0', verdict: 'allowed', redistributable: true },
        { name: 'dshmarket', version: '1.73.11', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'js-yaml', version: '4.3.2', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'undici', version: '7.30.1', license: 'MIT', verdict: 'allowed', redistributable: true },
    ],
    closureAudit: {
      auditedAt: '2026-11-05T00:33:17.830Z',
      method: '隔离目录 + 真实 pnpm 安装（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包 + evaluateClosure 现算裁决',
      verdict: 'allowed',
      packageCount: 4,
      byLicense: [
        { license: 'MIT', count: 3 },
        { license: 'Python-2.0', count: 1 },
      ],
      denied: [
      ],
      needsReview: [
      ],
    },
    installProbe: {
      hostDsh: '0.2.0-rc.2',
      probedAt: '2026-11-05T00:33:17.830Z',
      installed: true,
      listed: true,
      elapsedMs: 4542,
    },
  },
  // dsh-plugin-catalog@2026.1104.14928
  'plg-dsh-plugin-catalog': {
    depsClosure: [
        { name: 'dsh-plugin-catalog', version: '2026.1104.14928', license: 'CC0-1.0', verdict: 'allowed', redistributable: true },
    ],
    closureAudit: {
      auditedAt: '2026-11-05T00:33:24.101Z',
      method: '隔离目录 + 真实 pnpm 安装（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包 + evaluateClosure 现算裁决',
      verdict: 'allowed',
      packageCount: 1,
      byLicense: [
        { license: 'CC0-1.0', count: 1 },
      ],
      denied: [
      ],
      needsReview: [
      ],
    },
    installProbe: {
      hostDsh: '0.2.0-rc.2',
      probedAt: '2026-11-05T00:33:24.101Z',
      installed: true,
      listed: true,
      elapsedMs: 3410,
    },
  },
  // @1e0zj/dsh-plugin-mall@0.4.17
  'plg-dsh-plugin-mall': {
    depsClosure: [
        { name: '@1e0zj/dsh-plugin-mall', version: '0.4.17', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'argparse', version: '2.0.1', license: 'Python-2.0', verdict: 'allowed', redistributable: true },
        { name: 'js-yaml', version: '4.3.2', license: 'MIT', verdict: 'allowed', redistributable: true },
        { name: 'semver', version: '7.8.6', license: 'ISC', verdict: 'allowed', redistributable: true },
    ],
    closureAudit: {
      auditedAt: '2026-11-05T00:33:29.292Z',
      method: '隔离目录 + 真实 pnpm 安装（--ignore-scripts）+ 遍历已安装 node_modules 解析闭包 + evaluateClosure 现算裁决',
      verdict: 'allowed',
      packageCount: 4,
      byLicense: [
        { license: 'MIT', count: 2 },
        { license: 'ISC', count: 1 },
        { license: 'Python-2.0', count: 1 },
      ],
      denied: [
      ],
      needsReview: [
      ],
    },
    installProbe: {
      hostDsh: '0.2.0-rc.2',
      probedAt: '2026-11-05T00:33:29.292Z',
      installed: true,
      listed: true,
      elapsedMs: 3354,
    },
  },
};
