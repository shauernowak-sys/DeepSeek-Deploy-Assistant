import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG, CATALOG_CANDIDATES } from '../../catalog/index';
import {
  findMarketEntry,
  findMarketEntryBySpec,
} from '../../apps/desktop/src/main/services/market-catalog';
import {
  CANDIDATE_SIZE_HINT_BYTES,
  buildMarketIndex,
  buildOverlay,
  collectCandidateProblems,
  evaluateClosure,
  loadMatrix,
} from '@dda/core';
import {
  CANDIDATE_BLOCKING_CODES,
  CatalogCandidateSchema,
  CatalogOverlaySchema,
  type CatalogCandidate,
  type CompatMatrix,
} from '@dda/spec';

const MANIFESTS = join(__dirname, '..', '..', 'apps', 'desktop', 'resources', 'manifests');
const LOCKED_DSH = '0.2.1-rc.3';

/** 7 条做过 D11 闭包 + D03 安装探测的 npm 候选。 */
const AUDITED_CANDIDATES = CATALOG_CANDIDATES.filter(
  (candidate) => candidate.review.closureAudit !== undefined,
);
/** 2026-11-05 生态调研新收录、尚未做闭包/安装探测的候选（GitHub 源为主）。 */
const DISCOVERY_CANDIDATES = CATALOG_CANDIDATES.filter(
  (candidate) => candidate.review.closureAudit === undefined,
);

let cachedMatrix: CompatMatrix | undefined;

async function matrix(): Promise<CompatMatrix> {
  if (cachedMatrix === undefined) {
    cachedMatrix = loadMatrix(JSON.parse(await readFile(join(MANIFESTS, 'compat.json'), 'utf8')));
  }
  return cachedMatrix;
}

function cloneCandidate(name: string): CatalogCandidate {
  const found = CATALOG_CANDIDATES.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`候选不存在: ${name}`);
  return structuredClone(found) as CatalogCandidate;
}

describe('D09 完整策展：候选集范围与定位', () => {
  it('候选集合非空，且每一条都是 needs-review 或 blocked', () => {
    expect(CATALOG_CANDIDATES.length).toBeGreaterThanOrEqual(5);
    for (const candidate of CATALOG_CANDIDATES) {
      expect(['needs-review', 'blocked']).toContain(candidate.status);
    }
  });

  it('候选**不进** index.json（索引只列可安装条目）', () => {
    const index = buildMarketIndex(CATALOG);
    const indexedNames = new Set(index.plugins.map((plugin) => plugin.name));
    for (const candidate of CATALOG_CANDIDATES) {
      expect(indexedNames.has(candidate.name)).toBe(false);
    }
    // 可安装条目仍在索引里（回归：不能因为加了候选把原有条目挤掉）
    expect(indexedNames.has('@tencent-connect/dsh-qqbot')).toBe(true);
  });

  it('候选与可安装条目没有重名同版本', () => {
    const installed = new Set(CATALOG.entries.map((entry) => `${entry.name}@${entry.version}`));
    for (const candidate of CATALOG_CANDIDATES) {
      expect(installed.has(`${candidate.name}@${candidate.version}`)).toBe(false);
    }
  });

  it('候选无法通过安装入口被找到（catalog 查询只认可安装条目）', () => {
    for (const candidate of CATALOG_CANDIDATES) {
      expect(findMarketEntry(candidate.name, candidate.version)).toBeUndefined();
      expect(findMarketEntryBySpec(`${candidate.name}@${candidate.version}`)).toBeUndefined();
    }
    // 可安装条目仍能被找到（回归）
    expect(findMarketEntryBySpec('@tencent-connect/dsh-qqbot@0.5.5')).toBeDefined();
  });

  it('每条候选都有可追溯的发布者信息（author + homepage/repository）', () => {
    for (const candidate of CATALOG_CANDIDATES) {
      expect(candidate.author).toBeTruthy();
      expect(candidate.homepage ?? candidate.repository).toBeTruthy();
      expect(candidate.repository?.url ?? candidate.homepage).toMatch(/^https?:\/\//);
    }
  });

  it('每条候选都记录了取数事实与来源，便于复核', () => {
    for (const candidate of CATALOG_CANDIDATES) {
      expect(candidate.review.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(candidate.review.source).toMatch(/^https:\/\//);
      expect(candidate.review.facts.license).toBe(candidate.review.facts.license.trim());
      if (candidate.source.type === 'npm') {
        expect(candidate.review.source).toMatch(/^https:\/\/registry\.npmjs\.org\//);
        expect(candidate.review.facts.unpackedSizeBytes).toBeGreaterThan(0);
      } else {
        expect(candidate.review.facts.unpackedSizeBytes).toBe(0);
        expect(candidate.market.sizeNote).toBeTruthy();
      }
    }
  });

  it('新收录项目区分插件、桥接程序、工具与参考资料，并记录适用路线', () => {
    expect(DISCOVERY_CANDIDATES.length).toBeGreaterThanOrEqual(6);
    for (const candidate of DISCOVERY_CANDIDATES) {
      expect(['plugin', 'bridge', 'tool', 'reference']).toContain(candidate.market.kind);
      expect(['official-qq', 'personal-qq', 'unconfirmed']).toContain(candidate.market.route);
      expect(['npm', 'github', 'manual', 'none']).toContain(candidate.market.installMethod);
      expect(Array.isArray(candidate.market.requires)).toBe(true);
      expect(Array.isArray(candidate.market.conflicts)).toBe(true);
      expect(candidate.market.support).toBeDefined();
      for (const level of [
        candidate.market.support!.windowsX64,
        candidate.market.support!.lockedDsh,
        candidate.market.support!.webProfile,
      ]) {
        expect(['verified', 'declared', 'unverified', 'unsupported']).toContain(level);
      }
    }
    expect(DISCOVERY_CANDIDATES.find((c) => c.name === 'qq-bridge')?.market.kind).toBe('bridge');
    expect(DISCOVERY_CANDIDATES.find((c) => c.name === 'dsh-qq-tools')?.market.kind).toBe('tool');
  });

  it('公开关注度只作展示，并带查询日期与来源链接', () => {
    for (const candidate of CATALOG_CANDIDATES) {
      const attention = candidate.market.attention;
      if (attention === undefined) continue;
      expect(attention.source).toBe('github');
      expect(attention.queriedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(attention.url).toMatch(/^https:\/\/github\.com\//);
      expect(attention.stars).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('D09 完整策展：拒绝理由的结构与自洽', () => {
  it('真实候选通过全部规则（存在不自洽就会被这条拦住）', async () => {
    expect(collectCandidateProblems(CATALOG, CATALOG_CANDIDATES, await matrix())).toEqual([]);
  });

  it('每条候选至少一条 blocker，且 code 唯一、detail 不是空话', () => {
    for (const candidate of CATALOG_CANDIDATES) {
      const codes = candidate.review.blockers.map((blocker) => blocker.code);
      expect(codes.length).toBeGreaterThanOrEqual(1);
      expect(new Set(codes).size).toBe(codes.length);
      for (const blocker of candidate.review.blockers) {
        expect(blocker.detail.length).toBeGreaterThanOrEqual(6);
        expect(blocker.detail).not.toBe(blocker.code);
      }
    }
  });

  it('含阻断类理由 → 必须 blocked（改成 needs-review 会被拒）', async () => {
    const bad = cloneCandidate('@8kugames/dsh-zed-acp');
    bad.status = 'needs-review';
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('status 必须为 blocked');
  });

  it('blocked 却没有任何阻断类理由 → 被拒（不允许"含糊地拉黑"）', async () => {
    const bad = cloneCandidate('dsh-whale-widget');
    bad.status = 'blocked';
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('没有任何阻断类理由');
  });

  it('声明兼容版本不含锁定宿主 → 必须 host-version-incompatible', async () => {
    const bad = cloneCandidate('dsh-pet');
    bad.review.facts.declaredDshReleases = ['0.2.0-rc.2'];
    bad.review.blockers = bad.review.blockers.filter((b) => b.code !== 'host-version-incompatible');
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('blockers 必须包含 host-version-incompatible');
  });

  it('声称不兼容、但事实声明里含锁定宿主 → 被拒（事实矛盾）', async () => {
    const bad = cloneCandidate('dsh-pet');
    bad.review.facts.declaredDshReleases = [LOCKED_DSH];
    bad.review.blockers.push({ code: 'host-version-incompatible', detail: '故意写错当前宿主的兼容性' });
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('事实矛盾');
  });

  it('未声明任何兼容版本 → 必须 no-declared-compatibility', async () => {
    const bad = cloneCandidate('dsh-whale-widget');
    bad.review.blockers = bad.review.blockers.filter((b) => b.code !== 'no-declared-compatibility');
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('blockers 必须包含 no-declared-compatibility');
  });

  it('体积超提示线缺 size-excessive → 被拒', async () => {
    const bad = cloneCandidate('dsh-pet');
    bad.review.facts.unpackedSizeBytes = CANDIDATE_SIZE_HINT_BYTES + 1;
    bad.review.blockers = bad.review.blockers.filter((b) => b.code !== 'size-excessive');
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('blockers 必须包含 size-excessive');
  });

  it('不是 bundle 却没说 not-a-bundle → 被拒', async () => {
    const bad = cloneCandidate('dsh-plugin-catalog');
    bad.review.blockers = bad.review.blockers.filter((b) => b.code !== 'not-a-bundle');
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('blockers 必须包含 not-a-bundle');
  });

  it('是 bundle 却判 not-a-bundle → 被拒（事实矛盾）', async () => {
    const bad = cloneCandidate('dsh-whale-widget');
    bad.review.blockers.push({ code: 'not-a-bundle', detail: '这里是故意写错的事实矛盾' });
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('事实矛盾');
  });

  it('有安装期脚本却没说 install-script → 被拒', async () => {
    const bad = cloneCandidate('dshmarket');
    bad.review.blockers = bad.review.blockers.filter((b) => b.code !== 'install-script');
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('blockers 必须包含 install-script');
  });

  it('候选不得声称可分发（未做闭包审计）', async () => {
    const bad = cloneCandidate('dsh-whale-widget');
    bad.license = { ...bad.license, redistributable: true };
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('redistributable 必须为 false');
  });

  it('与可安装条目 name@version 冲突 → 被拒', async () => {
    const bad = cloneCandidate('dsh-whale-widget');
    bad.name = '@tencent-connect/dsh-qqbot';
    bad.version = '0.5.5';
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('已在可安装 catalog 中');
  });

  it('id 与可安装条目冲突 → 被拒', async () => {
    const bad = cloneCandidate('dsh-whale-widget');
    bad.id = 'plg-official-qqbot';
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('id 与');
  });

  it('两个候选 id 重复 → 被拒', async () => {
    const a = cloneCandidate('dsh-whale-widget');
    const b = cloneCandidate('@8kugames/dsh-zed-acp');
    b.id = a.id;
    const problems = collectCandidateProblems(CATALOG, [a, b], await matrix());
    expect(problems.join('\n')).toContain('id 与');
  });
});

describe('D09 完整策展：真实审计证据（D11 闭包 + D03 安装探测）', () => {
  it('已审计的 7 条候选都有闭包审计与逐包裁决（不再有 closure-not-audited）', () => {
    expect(AUDITED_CANDIDATES).toHaveLength(7);
    for (const candidate of AUDITED_CANDIDATES) {
      expect(candidate.review.closureAudit).toBeDefined();
      expect(candidate.depsClosure.length).toBeGreaterThanOrEqual(1);
      expect(candidate.review.closureAudit?.packageCount).toBe(candidate.depsClosure.length);
      const codes = candidate.review.blockers.map((blocker) => blocker.code);
      expect(codes).not.toContain('closure-not-audited');
    }
  });

  it('新收录候选必须显式标注未审计，不得冒充已审计', () => {
    expect(DISCOVERY_CANDIDATES.length).toBeGreaterThanOrEqual(6);
    for (const candidate of DISCOVERY_CANDIDATES) {
      expect(candidate.review.closureAudit).toBeUndefined();
      expect(candidate.depsClosure).toEqual([]);
      expect(candidate.review.blockers.map((b) => b.code)).toContain('closure-not-audited');
    }
  });

  it('审计结论与现算结果一致（防止审计后闭包被改却不重算）', () => {
    for (const candidate of AUDITED_CANDIDATES) {
      const audit = candidate.review.closureAudit!;
      const recomputed = evaluateClosure(`${candidate.name}@${candidate.version}`, candidate.depsClosure);
      expect(recomputed.verdict).toBe(audit.verdict);
      expect(audit.byLicense).toEqual(recomputed.byLicense);
      expect(audit.denied).toEqual(recomputed.denied);
      expect(audit.needsReview).toEqual(recomputed.needsReview);
    }
  });

  it('闭包不允许分发时，blockers 必须显式说明（GPL 之类不得静默放过）', () => {
    for (const candidate of AUDITED_CANDIDATES) {
      const audit = candidate.review.closureAudit!;
      if (audit.verdict === 'allowed') continue;
      const codes = candidate.review.blockers.map((blocker) => blocker.code);
      expect(codes.some((code) => code === 'closure-needs-review' || code === 'license-restricted')).toBe(true);
      expect(['blocked', 'needs-review']).toContain(candidate.status);
    }
  });

  it('历史宿主的真实探测：失败必须记 install-failed，成功必须被 list 到', () => {
    for (const candidate of AUDITED_CANDIDATES) {
      const probe = candidate.review.installProbe;
      expect(probe).toBeDefined();
      expect(probe?.hostDsh).toBe('0.2.0-rc.2');
      const codes = candidate.review.blockers.map((blocker) => blocker.code);
      if (probe?.installed === false) {
        expect(codes).toContain('install-failed');
        expect(probe.failure).toBeTruthy();
      } else {
        expect(codes).not.toContain('install-failed');
        // 装进去但没列出 = 不能当作可用（规则层也会拦）
        expect(probe?.listed).toBe(true);
      }
    }
  });

  it('"plugin list 有" ≠ "可用"：非 bundle 的条目即使装上了仍是 blocked', () => {
    const catalogEntry = CATALOG_CANDIDATES.find((candidate) => candidate.name === 'dsh-plugin-catalog')!;
    expect(catalogEntry.review.installProbe?.installed).toBe(true);
    expect(catalogEntry.review.installProbe?.listed).toBe(true);
    expect(catalogEntry.status).toBe('blocked');
    expect(catalogEntry.review.blockers.map((b) => b.code)).toContain('not-a-bundle');
    expect(catalogEntry.review.facts.hasBundlePatch).toBe(false);
  });

  it('删掉 closureAudit 但保留 depsClosure → 被拒（结论不能缺）', async () => {
    const bad = cloneCandidate('dsh-whale-widget');
    delete (bad.review as { closureAudit?: unknown }).closureAudit;
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('有 depsClosure 但没有 closureAudit');
  });

  it('把安装探测改成成功却保留 install-failed → 被拒（事实矛盾）', async () => {
    const bad = cloneCandidate('@8kugames/dsh-zed-acp');
    bad.review.installProbe = { ...bad.review.installProbe!, installed: true, listed: true };
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('安装探测成功，不应标 install-failed');
  });

  it('闭包结论 allowed 却标 closure-needs-review → 被拒（事实矛盾）', async () => {
    const bad = cloneCandidate('dsh-whale-widget');
    bad.review.blockers.push({ code: 'closure-needs-review', detail: '这里是故意写错的事实矛盾' });
    const problems = collectCandidateProblems(CATALOG, [bad], await matrix());
    expect(problems.join('\n')).toContain('不应标 closure-needs-review');
  });
});

describe('D09 完整策展：schema 强校验', () => {
  it('缺 review 的候选被 zod 拒绝', () => {
    const candidate = CATALOG_CANDIDATES[0]!;
    const { review: _review, ...withoutReview } = candidate;
    expect(CatalogCandidateSchema.safeParse(withoutReview).success).toBe(false);
  });

  it('blocker code 不在受控词表 → 被拒', () => {
    const candidate = cloneCandidate('dsh-whale-widget');
    (candidate.review.blockers[0] as { code: string }).code = 'looks-fine-to-me';
    expect(CatalogCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it('version 写成范围 → 被拒', () => {
    const candidate = cloneCandidate('dsh-whale-widget');
    candidate.version = '^0.4.2';
    expect(CatalogCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it('integrity 不是 sha512 SRI → 被拒', () => {
    const candidate = cloneCandidate('dsh-whale-widget');
    candidate.integrity = 'md5-abc';
    expect(CatalogCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it('overlay 必须能承载候选（UI 读的就是这份）', () => {
    const overlay = buildOverlay(CATALOG, 'test', CATALOG_CANDIDATES);
    expect(CatalogOverlaySchema.safeParse(overlay).success).toBe(true);
    expect(overlay.candidates).toHaveLength(CATALOG_CANDIDATES.length);
    for (const candidate of overlay.candidates) {
      expect(candidate.review.blockers.length).toBeGreaterThanOrEqual(1);
      expect(candidate.zh.summary.length).toBeGreaterThan(0);
    }
  });

  it('受控词表里每个阻断类 code 都真实被用到或被断言为"阻断语义"', () => {
    const used = new Set(CATALOG_CANDIDATES.flatMap((c) => c.review.blockers.map((b) => b.code)));
    for (const blocking of CANDIDATE_BLOCKING_CODES) {
      const applied = CATALOG_CANDIDATES.filter((c) =>
        c.review.blockers.some((b) => b.code === blocking),
      );
      // 阻断类 code 一旦被使用，条目必然是 blocked
      for (const candidate of applied) expect(candidate.status).toBe('blocked');
    }
    // 至少有 3 种阻断理由在真实数据里被用到，证明词表不是摆设
    expect(CANDIDATE_BLOCKING_CODES.filter((code) => used.has(code)).length).toBeGreaterThanOrEqual(3);
  });
});
