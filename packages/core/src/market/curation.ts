import { CANDIDATE_BLOCKING_CODES } from '@dda/spec';
import type { Catalog, CatalogCandidate, CatalogCandidateReview, CompatMatrix } from '@dda/spec';

import { evaluateClosure } from './license-gate';

/**
 * D09 完整策展：候选条目的规则。
 *
 * 设计原则：**没有验证过的字段不许编**。
 * 因此候选条目不要求 `compat`/完整依赖闭包/验收项（那些需要真实安装验证），
 * 但必须给出结构化的拒绝理由（受控 `code` + 具体 `detail`）与取数事实，
 * 让人能复核"当时凭什么这样判"，也避免把 `needs-review` 写成含糊的"待定"。
 */

/** 体积提示线：超过即必须在 blockers 里出现 `size-excessive`（仅提示，不单独构成阻断）。 */
export const CANDIDATE_SIZE_HINT_BYTES = 32 * 1024 * 1024;

function codesOf(review: CatalogCandidateReview): ReadonlySet<string> {
  return new Set(review.blockers.map((blocker) => blocker.code));
}

function shortName(name: string): string {
  return name.length > 48 ? `${name.slice(0, 45)}…` : name;
}

/**
 * 检查候选集合本身（不联网）。`lockedDsh` 是 compat 矩阵里唯一的 verified-local 宿主版本；
 * 候选声明的兼容列表若不含它，就必须被判 `host-version-incompatible`。
 */
export function collectCandidateProblems(
  catalog: Catalog,
  candidates: readonly CatalogCandidate[],
  matrix: CompatMatrix,
): string[] {
  const problems: string[] = [];
  const verifiedDsh = matrix.entries.filter((entry) => entry.status === 'verified-local').map((entry) => entry.dsh);
  const lockedDsh = verifiedDsh[0];

  const knownIds = new Map<string, string>();
  for (const entry of catalog.entries) knownIds.set(entry.id, `catalog:${entry.name}@${entry.version}`);
  const verifiedSpecs = new Set(catalog.entries.map((entry) => `${entry.name}@${entry.version}`));

  for (const candidate of candidates) {
    const label = `${candidate.id} (${shortName(candidate.name)}@${candidate.version})`;
    const codes = codesOf(candidate.review);
    const hasBlocking = candidate.review.blockers.some((blocker) =>
      CANDIDATE_BLOCKING_CODES.includes(blocker.code),
    );

    // 1) id 在"可安装条目 + 候选"之间必须唯一。
    const previous = knownIds.get(candidate.id);
    if (previous !== undefined) {
      problems.push(`${label}: id 与 ${previous} 重复`);
    } else {
      knownIds.set(candidate.id, `candidate:${candidate.name}@${candidate.version}`);
    }

    // 2) 同一个包同一版本不能既"已策展可安装"又"候选"。
    if (verifiedSpecs.has(`${candidate.name}@${candidate.version}`)) {
      problems.push(`${label}: 该 name@version 已在可安装 catalog 中，不应同时作为候选`);
    }

    // 3) 阻断类理由 ⇒ 必须是 blocked；反之 needs-review 不得携带阻断类理由。
    if (hasBlocking && candidate.status !== 'blocked') {
      problems.push(`${label}: 含阻断类理由，status 必须为 blocked（当前 ${candidate.status}）`);
    }
    if (!hasBlocking && candidate.status === 'blocked') {
      problems.push(
        `${label}: status 为 blocked，但没有任何阻断类理由（${CANDIDATE_BLOCKING_CODES.join('/')}）`,
      );
    }

    // 4) 拒绝理由要与取数事实自洽，否则就是"凭印象写的"。
    if (!candidate.review.facts.hasBundlePatch && !codes.has('not-a-bundle')) {
      problems.push(`${label}: 未声明 dsh.bundle.patch，blockers 必须包含 not-a-bundle`);
    }
    if (candidate.review.facts.hasBundlePatch && codes.has('not-a-bundle')) {
      problems.push(`${label}: 声明了 dsh.bundle.patch，但 blockers 却说 not-a-bundle（事实矛盾）`);
    }
    if (candidate.review.facts.hasInstallScript && !codes.has('install-script')) {
      problems.push(`${label}: 存在安装期脚本，blockers 必须包含 install-script`);
    }
    if (
      candidate.review.facts.unpackedSizeBytes > CANDIDATE_SIZE_HINT_BYTES &&
      !codes.has('size-excessive')
    ) {
      problems.push(
        `${label}: 解压体积 ${candidate.review.facts.unpackedSizeBytes} B 超过提示线，blockers 必须包含 size-excessive`,
      );
    }

    if (lockedDsh !== undefined) {
      const declared = candidate.review.facts.declaredDshReleases;
      if (declared.length > 0 && !declared.includes(lockedDsh) && !codes.has('host-version-incompatible')) {
        problems.push(
          `${label}: 声明的兼容版本 ${declared.join('/')} 不含锁定宿主 ${lockedDsh}，` +
            'blockers 必须包含 host-version-incompatible',
        );
      }
      if (declared.includes(lockedDsh) && codes.has('host-version-incompatible')) {
        problems.push(`${label}: 声明兼容锁定宿主 ${lockedDsh}，却判 host-version-incompatible（事实矛盾）`);
      }
      if (declared.length === 0 && !codes.has('no-declared-compatibility')) {
        problems.push(`${label}: 未声明任何 dsh 兼容版本，blockers 必须包含 no-declared-compatibility`);
      }
    }

    // 5) 许可：未做闭包审计前，任何候选都不能声称可分发。
    if (candidate.license.redistributable) {
      problems.push(`${label}: 候选未做传递闭包审计，license.redistributable 必须为 false`);
    }

    // 5b) 审计状态必须显式：做了就要有结论并自洽；没做就要写进 blockers。
    const audit = candidate.review.closureAudit;
    const hasClosureEntries = candidate.depsClosure.length > 0;
    if (audit === undefined) {
      if (!codes.has('closure-not-audited')) {
        problems.push(`${label}: 未记录闭包审计，blockers 必须包含 closure-not-audited`);
      }
      if (hasClosureEntries) {
        problems.push(`${label}: 有 depsClosure 但没有 closureAudit（结论缺失，无法复核）`);
      }
    } else {
      if (codes.has('closure-not-audited')) {
        problems.push(`${label}: 已有 closureAudit，不应再标 closure-not-audited（结论过期）`);
      }
      if (!hasClosureEntries) {
        problems.push(`${label}: 有 closureAudit 但 depsClosure 为空（无法复核逐包裁决）`);
      }
      if (audit.packageCount !== candidate.depsClosure.length) {
        problems.push(
          `${label}: closureAudit.packageCount=${audit.packageCount} 与 depsClosure 长度 ${candidate.depsClosure.length} 不一致`,
        );
      }
      const recomputed = evaluateClosure(`${candidate.name}@${candidate.version}`, candidate.depsClosure);
      if (recomputed.verdict !== audit.verdict) {
        problems.push(
          `${label}: closureAudit.verdict=${audit.verdict} 与现算结果 ${recomputed.verdict} 不一致`,
        );
      }
      const auditDenied = new Set(audit.denied.map((entry) => `${entry.name}@${entry.version}`));
      const recomputedDenied = new Set(recomputed.denied.map((entry) => `${entry.name}@${entry.version}`));
      if (auditDenied.size !== recomputedDenied.size) {
        problems.push(`${label}: closureAudit.denied 与现算的不可分发集合大小不一致`);
      }
      // 闭包含需复核许可 ⇒ 必须显式标注（GPL 之类的 copyleft 不会被静默放过）。
      if (audit.verdict !== 'allowed' && !codes.has('closure-needs-review') && !codes.has('license-restricted')) {
        problems.push(
          `${label}: 闭包结论为 ${audit.verdict}，blockers 必须包含 closure-needs-review 或 license-restricted`,
        );
      }
      if (audit.verdict === 'allowed' && codes.has('closure-needs-review')) {
        problems.push(`${label}: 闭包结论为 allowed，不应标 closure-needs-review（事实矛盾）`);
      }
    }

    // 5c) 安装探测结果必须与 blockers 自洽：装不上就是阻断。
    const probe = candidate.review.installProbe;
    if (probe !== undefined) {
      const failed = !probe.installed;
      if (failed && !codes.has('install-failed')) {
        problems.push(`${label}: 安装探测失败，blockers 必须包含 install-failed`);
      }
      if (!failed && codes.has('install-failed')) {
        problems.push(`${label}: 安装探测成功，不应标 install-failed（事实矛盾）`);
      }
      // 装进去了但 list 不到，说明"安装 ≠ 可用"，必须有人看得见的结论。
      if (probe.installed && !probe.listed) {
        problems.push(`${label}: 安装成功但 plugin list 未列出，不能当作可用（需重新探测或记录原因）`);
      }
    }
    const rawLicense = candidate.review.facts.license.trim().toUpperCase();
    const restricted = rawLicense === '' || rawLicense === 'UNLICENSED' || rawLicense === 'NONE';
    if (restricted && !codes.has('license-restricted')) {
      problems.push(`${label}: 许可为 ${candidate.review.facts.license || '(空)'}，blockers 必须包含 license-restricted`);
    }
    if (!restricted && codes.has('license-restricted')) {
      problems.push(`${label}: 许可为 ${candidate.review.facts.license}，不应判 license-restricted（事实矛盾）`);
    }

    // 6b) 禁止商业用途的许可必须单独标注：它不同于"许可不明"，但同样不能进入可分发清单。
    const noncommercial = /NONCOMMERCIAL|NON-COMMERCIAL|CC-BY-NC|BY-NC/.test(rawLicense);
    if (noncommercial && !codes.has('noncommercial-license')) {
      problems.push(`${label}: 许可为 ${candidate.review.facts.license}，blockers 必须包含 noncommercial-license`);
    }
    if (!noncommercial && codes.has('noncommercial-license')) {
      problems.push(`${label}: 许可为 ${candidate.review.facts.license}，不应判 noncommercial-license（事实矛盾）`);
    }

    // 6) 发布者追溯：只有 1 个维护者且无仓库/主页，必须标注。
    if (
      candidate.author === undefined &&
      candidate.homepage === undefined &&
      candidate.repository === undefined &&
      !codes.has('unverified-publisher')
    ) {
      problems.push(`${label}: 缺少 author/homepage/repository，blockers 必须包含 unverified-publisher`);
    }

    // 7) 分类与标签必须是索引声明过的 id（否则 D02 无法按分类聚合）。
    if (candidate.category === '') problems.push(`${label}: category 不能为空`);
    const ids = new Set<string>();
    for (const blocker of candidate.review.blockers) {
      if (ids.has(blocker.code)) problems.push(`${label}: blocker code 重复 ${blocker.code}`);
      ids.add(blocker.code);
    }
  }

  return problems;
}
