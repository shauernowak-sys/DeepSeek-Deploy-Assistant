import type { ClosureReport } from './license-gate';
import { formatClosureReport, renderThirdPartyNotices } from './license-gate';

/**
 * D05 / SEC-LIC：生成随包分发的 `THIRD_PARTY_NOTICES.md`。
 *
 * 两条硬规则：
 * - 只列**可由我方分发**的包（被拒条目不会出现在我方产物里）；
 * - 被拒条目单独成段，写清"仅在线安装、不随包分发"，避免读者误以为产品内含这些包。
 */

export interface NoticesInput {
  product: ClosureReport;
  /** catalog 条目及其闭包裁决；被拒条目会进入"仅在线安装"段。 */
  plugins: Array<{ id: string; name: string; version: string; report: ClosureReport }>;
  /** 生成者（脚本名 + 版本），便于追溯；不要放时间戳，保证 CI 可 diff。 */
  generatedBy: string;
}

export function renderNoticesDocument(input: NoticesInput): string {
  const lines: string[] = [
    '# THIRD_PARTY NOTICES',
    '',
    `> 本文件由 \`${input.generatedBy}\` 生成；请勿手工修改（CI 会校验一致性）。`,
    '',
    '本软件随安装包分发的第三方组件如下。**仅在线安装**的插件不随包分发，其字节由用户机器从',
    '上游 registry 获取，因此不列入可分发清单，但在此一并说明其许可边界。',
    '',
    '---',
    '',
    '## 本软件自身的生产依赖',
    '',
  ];

  const product = renderThirdPartyNotices(input.product).split('\n');
  product.shift(); // 去掉报告自带的 H1
  lines.push(product.join('\n').replace(/^\n+/u, ''));

  const blocked = input.plugins.filter((plugin) => plugin.report.verdict !== 'allowed');
  const allowed = input.plugins.filter((plugin) => plugin.report.verdict === 'allowed');

  if (allowed.length > 0) {
    lines.push('---', '', '## 可随包分发的插件', '');
    for (const plugin of allowed) {
      const body = renderThirdPartyNotices(plugin.report).split('\n');
      body.shift();
      lines.push(`### ${plugin.name}@${plugin.version}`, '', body.join('\n').replace(/^\n+/u, ''), '');
    }
  }

  if (blocked.length > 0) {
    lines.push('---', '', '## 仅在线安装（不随包分发）', '');
    for (const plugin of blocked) {
      lines.push(`### ${plugin.name}@${plugin.version}（条目 ${plugin.id}）`, '');
      lines.push('该插件由用户在联网环境从上游 registry 安装，本软件不复制、不镜像、不随包分发其字节。');
      lines.push('');
      for (const entry of plugin.report.denied) {
        lines.push(`- 不可分发：\`${entry.name}@${entry.version}\` — \`${entry.license}\``);
      }
      for (const entry of plugin.report.needsReview) {
        lines.push(`- 需人工复核：\`${entry.name}@${entry.version}\` — \`${entry.license}\``);
      }
      lines.push('');
    }
  }

  lines.push(
    '---',
    '',
    '## 运行时',
    '',
    'Node.js 与 pnpm 以官方发行包形式安装到用户私有目录，其许可（MIT）全文随官方发行包提供；',
    '本软件不修改其内容。Harness（`@deepseek-ai/dsh`，MIT）由官方 npm 渠道获取。',
    '',
  );

  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

/** 人类可读的生成摘要（CI 日志用）。 */
export function summarizeNotices(input: NoticesInput): string {
  const blocked = input.plugins.filter((plugin) => plugin.report.verdict !== 'allowed');
  return [
    formatClosureReport(input.product),
    `插件：${input.plugins.length} 个，其中 ${blocked.length} 个仅在线安装`,
  ].join('\n');
}
