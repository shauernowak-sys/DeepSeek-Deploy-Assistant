import { describe, expect, it } from 'vitest';

import { OFFICIAL_QQBOT_ENTRY } from '../../catalog/entries/official-qqbot';
import { evaluateClosure, renderNoticesDocument, summarizeNotices } from '@dda/core';

const product = evaluateClosure('product（本产品生产闭包）', [
  { name: 'js-yaml', version: '4.1.0', license: 'MIT' },
  { name: 'argparse', version: '2.0.1', license: 'Python-2.0' },
]);

const qqReport = evaluateClosure(
  `${OFFICIAL_QQBOT_ENTRY.name}@${OFFICIAL_QQBOT_ENTRY.version}`,
  OFFICIAL_QQBOT_ENTRY.depsClosure,
);

const document = renderNoticesDocument({
  product,
  plugins: [
    {
      id: OFFICIAL_QQBOT_ENTRY.id,
      name: OFFICIAL_QQBOT_ENTRY.name,
      version: OFFICIAL_QQBOT_ENTRY.version,
      report: qqReport,
    },
  ],
  generatedBy: 'scripts/build-notices.ts',
});

describe('D05 / SEC-LIC THIRD_PARTY_NOTICES', () => {
  it('列出本产品可分发依赖', () => {
    expect(document).toContain('# THIRD_PARTY NOTICES');
    expect(document).toContain('js-yaml');
    expect(document).toContain('Python-2.0');
  });

  it('仅在线安装的插件单独成段，并点名不可分发依赖', () => {
    expect(document).toContain('## 仅在线安装（不随包分发）');
    expect(document).toContain('@tencent-connect/dsh-qqbot@0.5.5');
    expect(document).toContain('@tencent-connect/qqbot-connector@1.2.0');
    expect(document).toContain('UNLICENSED');
    expect(document).toContain('不复制、不镜像、不随包分发');
  });

  it('不把被拒条目混进"可随包分发"清单', () => {
    const allowedSection = document.split('## 仅在线安装')[0] ?? '';
    expect(allowedSection).not.toContain('qqbot-connector');
  });

  it('不含时间戳（CI 可 diff），并说明 Node/pnpm/Harness 来源', () => {
    expect(document).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(document).toContain('Node.js');
    expect(document).toContain('MIT');
  });

  it('摘要包含判定与插件统计', () => {
    const summary = summarizeNotices({
      product,
      plugins: [
        { id: 'plg-official-qqbot', name: 'qq', version: '0.5.5', report: qqReport },
      ],
      generatedBy: 'x',
    });
    expect(summary).toContain('判定 allowed');
    expect(summary).toContain('1 个仅在线安装');
  });
});
