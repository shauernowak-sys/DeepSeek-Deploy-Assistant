import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DdaError, ERROR_CODES } from '@dda/spec';
import type { DepsClosureEntry, DepsLicenseVerdict } from '@dda/spec';

/**
 * D11 许可门禁（PRD §12/§14、CN-5、docs/M4-技术架构决策.md §6）。
 *
 * 判定三态：
 * - `allowed`：宽松许可，允许我方随包分发；
 * - `needs-review`：许可不在允许列表内、但未被明确禁止（如 MPL/LGPL），**默认阻断分发**；
 * - `denied`：`UNLICENSED` / `SEE LICENSE IN` / `NOASSERTION` / 未声明，一律不得分发。
 *
 * 在线安装（用户机器从 registry 拉取）不属于「我方分发」，因此不经过本门禁；
 * 本门禁只回答「这些字节能不能随我们的产物一起走」。
 */

export const LICENSE_ALLOWLIST: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Python-2.0',
  'Unicode-3.0',
];

/** 明确禁止我方分发的写法（大小写不敏感，值本身会被先归一化）。 */
export const LICENSE_DENYLIST: readonly RegExp[] = [
  /^UNLICENSED$/i,
  /^SEE LICENSE IN\b/i,
  /^NOASSERTION$/i,
  /^NONE$/i,
  /^UNKNOWN/i,
  /^\(none\)$/i,
];

/**
 * 别名归一化。`package.json` 里大量存在 `Apache 2.0`（带空格）这类非 SPDX 写法；
 * 前置验证 §5.4 已确认旧门禁漏判它，这里必须覆盖。
 */
const SPDX_ALIASES: Readonly<Record<string, string>> = {
  mit: 'MIT',
  isc: 'ISC',
  'apache 2.0': 'Apache-2.0',
  'apache-2.0': 'Apache-2.0',
  'apache license 2.0': 'Apache-2.0',
  'apache license, version 2.0': 'Apache-2.0',
  'apache license': 'Apache-2.0',
  'python 2.0': 'Python-2.0',
  'python-2.0': 'Python-2.0',
  'the unlicense': 'Unlicense',
  unlicense: 'Unlicense',
  '0bsd': '0BSD',
  'bsd-2-clause': 'BSD-2-Clause',
  'bsd-3-clause': 'BSD-3-Clause',
  'cc0-1.0': 'CC0-1.0',
  'blueoak-1.0.0': 'BlueOak-1.0.0',
  'unicode-3.0': 'Unicode-3.0',
  'mpl-2.0': 'MPL-2.0',
  'lgpl-3.0-only': 'LGPL-3.0-only',
  'gpl-3.0-only': 'GPL-3.0-only',
  'gpl-2.0-only': 'GPL-2.0-only',
};

/** 去掉 `(from file)` 之类的来源后缀并压缩空白，别名按小写匹配。 */
export function normalizeSpdx(raw: string): string {
  const text = raw
    .replace(/\(from file\)$/i, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (text === '') return '(none)';
  return SPDX_ALIASES[text.toLowerCase()] ?? text;
}

/** 解析 `MIT OR Apache-2.0` 这类表达式：任一项被拒即整体被拒，全部允许才算允许。 */
function licenseTerms(normalized: string): string[] {
  return normalized
    .split(/\s+(?:AND|OR)\s+/i)
    .map((term) => normalizeSpdx(term.replace(/^\(+/, '').replace(/\)+$/, '')))
    .filter((term) => term !== '');
}

export function classifyLicense(raw: string | undefined): DepsLicenseVerdict {
  if (raw === undefined || raw.trim() === '') return 'denied';
  const normalized = normalizeSpdx(raw);
  if (LICENSE_DENYLIST.some((re) => re.test(normalized))) return 'denied';

  const terms = licenseTerms(normalized);
  if (terms.length === 0) return 'denied';

  const verdicts = terms.map<DepsLicenseVerdict>((term) => {
    if (LICENSE_DENYLIST.some((re) => re.test(term))) return 'denied';
    return LICENSE_ALLOWLIST.includes(term) ? 'allowed' : 'needs-review';
  });
  if (verdicts.includes('denied')) return 'denied';
  return verdicts.every((verdict) => verdict === 'allowed') ? 'allowed' : 'needs-review';
}

export interface ClosurePackageInput {
  name: string;
  version: string;
  /** 许可原文；`undefined` 表示既无字段也无 LICENSE 文件。 */
  license?: string;
}

/** pnpm 输出里带安装目录，用来直接读真实许可而不是靠包名猜。 */
export interface ClosurePackageLocation extends ClosurePackageInput {
  dir?: string;
}

export interface ClosureReport {
  scope: string;
  entries: DepsClosureEntry[];
  verdict: DepsLicenseVerdict;
  byLicense: Array<{ license: string; count: number }>;
  denied: DepsClosureEntry[];
  needsReview: DepsClosureEntry[];
}

function worstVerdict(entries: readonly DepsClosureEntry[]): DepsLicenseVerdict {
  if (entries.some((entry) => entry.verdict === 'denied')) return 'denied';
  if (entries.some((entry) => entry.verdict === 'needs-review')) return 'needs-review';
  return 'allowed';
}

export function evaluateClosure(scope: string, packages: readonly ClosurePackageInput[]): ClosureReport {
  const entries = packages.map<DepsClosureEntry>((pkg) => {
    const verdict = classifyLicense(pkg.license);
    return {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license === undefined || pkg.license.trim() === '' ? '(none)' : normalizeSpdx(pkg.license),
      verdict,
      redistributable: verdict === 'allowed',
    };
  });

  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1);

  return {
    scope,
    entries,
    verdict: worstVerdict(entries),
    byLicense: [...counts.entries()]
      .map(([license, count]) => ({ license, count }))
      .sort((a, b) => b.count - a.count || a.license.localeCompare(b.license)),
    denied: entries.filter((entry) => entry.verdict === 'denied'),
    needsReview: entries.filter((entry) => entry.verdict === 'needs-review'),
  };
}

/**
 * 分发前的硬门禁：只要闭包不是 100% `allowed` 就抛错，并在消息里点名到包。
 * 只写「许可不允许」用户无法判断该找谁要授权，因此包名/版本/许可必须出现在消息里。
 */
export function assertRedistributable(report: ClosureReport): void {
  if (report.verdict === 'allowed') return;
  const offenders = [...report.denied, ...report.needsReview];
  throw new DdaError(
    ERROR_CODES.E_LICENSE_BLOCKED,
    `${report.scope} 不能随包分发：` +
      offenders.map((entry) => `${entry.name}@${entry.version}（${entry.license}）`).join('、'),
    '改为在线安装（本软件不复制其字节）；确需分发时先取得该包授权，再把许可结论写回 catalog',
  );
}

export function formatClosureReport(report: ClosureReport): string {
  const lines: string[] = [];
  lines.push(`[license-gate] ${report.scope}: ${report.entries.length} 个包，判定 ${report.verdict}`);
  for (const { license, count } of report.byLicense) {
    lines.push(`  ${String(count).padStart(4)}  ${license}`);
  }
  for (const entry of report.denied) {
    lines.push(`  DENIED       ${entry.name}@${entry.version}: ${entry.license}`);
  }
  for (const entry of report.needsReview) {
    lines.push(`  NEEDS-REVIEW ${entry.name}@${entry.version}: ${entry.license}`);
  }
  return lines.join('\n');
}

/**
 * `THIRD_PARTY_NOTICES.md` 片段：Apache-2.0 必须随附 NOTICE 与许可全文（前置验证 §5.2）。
 * 只列可分发项；被拒的包不进声明，因为它们不应出现在我方产物里。
 */
export function renderThirdPartyNotices(report: ClosureReport, generatedAt = ''): string {
  const distributable = report.entries
    .filter((entry) => entry.verdict !== 'denied')
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [
    `# Third-party notices — ${report.scope}`,
    '',
    generatedAt === '' ? '' : `生成时间：${generatedAt}`,
    '本清单只覆盖可随包分发的依赖。被拒条目（UNLICENSED 等）不会出现在我方产物中。',
    '',
    '| 包 | 版本 | 许可 |',
    '|---|---|---|',
    ...distributable.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.license} |`),
  ];
  if (distributable.some((entry) => entry.license === 'Apache-2.0')) {
    lines.push('', '> 含 Apache-2.0 组件：分发时必须随附其 NOTICE 与许可全文。');
  }
  return lines.join('\n');
}

/** 解析 `pnpm list --prod --depth Infinity --json` 的输出（纯函数，便于用固定样例测试）。 */
export function parsePnpmListJson(raw: string): ClosurePackageLocation[] {
  const roots: unknown = JSON.parse(raw);
  const found = new Map<string, ClosurePackageLocation>();

  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as { dependencies?: Record<string, unknown> };
    if (record.dependencies === undefined) return;
    for (const [name, info] of Object.entries(record.dependencies)) {
      if (typeof info !== 'object' || info === null) continue;
      const pkg = info as { version?: unknown; path?: unknown };
      const version = typeof pkg.version === 'string' ? pkg.version : '?';
      const key = `${name}@${version}`;
      if (!found.has(key)) {
        found.set(key, {
          name,
          version,
          ...(typeof pkg.path === 'string' ? { dir: pkg.path } : {}),
        });
      }
      walk(pkg);
    }
  };

  for (const root of Array.isArray(roots) ? roots : [roots]) walk(root);
  return [...found.values()];
}

/**
 * 从安装目录读许可：先看 `package.json`，再退回 LICENSE/COPYING 文件的首段文本识别。
 * 两者都没有 → `license: undefined`（门禁判 `denied`）。
 */
export async function readLicenseFromDir(dir: string): Promise<{ license?: string; source: string }> {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { license?: unknown };
    const license = pkg.license;
    const value =
      typeof license === 'string'
        ? license
        : typeof license === 'object' && license !== null && typeof (license as { type?: unknown }).type === 'string'
          ? (license as { type: string }).type
          : undefined;
    if (value !== undefined && value.trim() !== '') return { license: value, source: 'package.json' };
  } catch {
    // 落到 LICENSE 文件
  }

  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((file) => /^(LICEN[CS]E|COPYING)/i.test(file));
  } catch {
    return { source: 'missing-package' };
  }
  const first = files[0];
  if (first === undefined) return { source: 'no-license' };

  try {
    const text = (await readFile(join(dir, first), 'utf8')).slice(0, 4000).toLowerCase();
    const guess = text.includes('apache license')
      ? 'Apache-2.0'
      : text.includes('mit license') || text.includes('permission is hereby granted')
        ? 'MIT'
        : text.includes('isc license')
          ? 'ISC'
          : undefined;
    return guess === undefined ? { license: `UNKNOWN-file:${first}`, source: first } : { license: guess, source: first };
  } catch {
    return { source: first };
  }
}

/** 把 pnpm 列出的包逐个补上真实许可；读不到的保留为 `undefined`，交给门禁判 denied。 */
export async function resolveClosureLicenses(
  packages: readonly ClosurePackageLocation[],
): Promise<ClosurePackageInput[]> {
  const resolved: ClosurePackageInput[] = [];
  for (const pkg of packages) {
    const info = pkg.dir === undefined ? { source: 'no-path' } : await readLicenseFromDir(pkg.dir);
    resolved.push({
      name: pkg.name,
      version: pkg.version,
      ...(info.license === undefined ? {} : { license: info.license }),
    });
  }
  return resolved;
}
