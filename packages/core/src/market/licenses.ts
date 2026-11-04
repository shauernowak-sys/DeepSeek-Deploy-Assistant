import type { ClosurePackageLocation } from './license-gate';
import { normalizeSpdx } from './license-gate';

/**
 * SEC-LIC / D05：随安装包分发的许可**全文**（不只是清单）。
 *
 * `THIRD_PARTY_NOTICES.md` 回答"分发了什么、什么许可"；本模块生成的 `licenses/` 目录回答
 * "许可是怎么写的"。两者缺一都不是合规交付：
 * - 只有清单：MIT/BSD 要求"随附许可与版权声明"，清单不构成随附；
 * - 只有全文：用户/审计无法判断哪个文件对应哪个包。
 *
 * 目录布局（仓库 `licenses/` → 打包后 `resources/licenses/`，与 `node.json`
 * 的 `license.textFile` 相对路径口径一致）：
 *
 *   licenses/node-LICENSE.txt
 *   licenses/pnpm-LICENSE.txt
 *   licenses/dsh-LICENSE.txt
 *   licenses/npm/<name>@<version>.txt
 *   licenses/README.md          ← 索引（本模块生成，CI 校验一致）
 */

export const LICENSE_DIR = 'licenses';

/** 运行时组件的许可全文固定文件名；`node.json` 的 `textFile` 直接引用其中一个。 */
export const RUNTIME_LICENSE_FILES = {
  node: 'node-LICENSE.txt',
  pnpm: 'pnpm-LICENSE.txt',
  harness: 'dsh-LICENSE.txt',
} as const;

export type RuntimeLicenseId = keyof typeof RUNTIME_LICENSE_FILES;

export interface RuntimeLicenseComponent {
  id: RuntimeLicenseId;
  package: string;
  version: string;
  license: string;
}

/** 各包许可文件命名差异很大，按优先级探测；`NOTICE` 不在内——它不是许可全文。 */
export const LICENSE_FILE_NAMES: readonly string[] = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENSE-MIT',
  'LICENCE',
  'LICENCE.md',
  'COPYING',
  'COPYING.md',
];

export interface LicenseTextTarget {
  /** 相对 `licenses/` 的路径，统一用 `/`。 */
  file: string;
  package: string;
  version: string;
  license: string;
  origin: RuntimeLicenseId | 'product';
}

/** `@scope/name` 的 `/` 不能出现在文件名里，用 `+` 归一（npm pack 的 scoped 包命名同源）。 */
export function npmLicenseFile(name: string, version: string): string {
  const flat = name.replace(/\//gu, '+');
  return `${LICENSE_DIR}/npm/${flat}@${version}.txt`;
}

export function runtimeLicenseFile(id: RuntimeLicenseId): string {
  return `${LICENSE_DIR}/${RUNTIME_LICENSE_FILES[id]}`;
}

/** 从目录清单里挑出许可全文文件名；同一目录有多个时按 `LICENSE_FILE_NAMES` 顺序取第一个。 */
export function pickLicenseFile(entries: readonly string[]): string | undefined {
  const present = new Set(entries);
  for (const candidate of LICENSE_FILE_NAMES) {
    if (present.has(candidate)) return candidate;
  }
  // 兼容 `LICENSE-MIT.txt` / `LICENCE-APACHE` 之类的变体，但不接受 README / NOTICE。
  const variant = [...entries]
    .filter((entry) => /^LI[CS]EN[CS]E[-.\w]*$/iu.test(entry) || /^COPYING[-.\w]*$/iu.test(entry))
    .sort((a, b) => a.localeCompare(b));
  return variant[0];
}

export function runtimeLicenseTargets(
  components: readonly RuntimeLicenseComponent[],
): LicenseTextTarget[] {
  return components.map((component) => ({
    file: runtimeLicenseFile(component.id),
    package: component.package,
    version: component.version,
    license: component.license,
    origin: component.id,
  }));
}

/**
 * 生产闭包 → 许可全文目标。许可字段缺失的包仍然要有文件（用 `(none)` 标注）：
 * 少了文件等于静默漏发，比写"未知"更危险。
 */
export function licensesForClosure(
  packages: readonly ClosurePackageLocation[],
  origin: LicenseTextTarget['origin'] = 'product',
): LicenseTextTarget[] {
  const seen = new Map<string, LicenseTextTarget>();
  for (const pkg of packages) {
    const file = npmLicenseFile(pkg.name, pkg.version);
    if (seen.has(file)) continue;
    const raw = pkg.license?.trim() ?? '';
    seen.set(file, {
      file,
      package: pkg.name,
      version: pkg.version,
      license: raw === '' ? '(none)' : normalizeSpdx(raw),
      origin,
    });
  }
  return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function originLabel(origin: LicenseTextTarget['origin']): string {
  switch (origin) {
    case 'node':
      return 'Node.js 运行时';
    case 'pnpm':
      return 'pnpm 工具链';
    case 'harness':
      return 'Harness';
    default:
      return '本产品生产依赖';
  }
}

/** `licenses/README.md`：确定性输出（无时间戳），CI 可 diff。 */
export function renderLicenseIndex(targets: readonly LicenseTextTarget[]): string {
  const sorted = [...targets].sort((a, b) => a.file.localeCompare(b.file));
  const lines: string[] = [
    '# 许可全文清单',
    '',
    '> 本文件由 `npm run licenses:build` 生成；请勿手工修改（CI 的 `licenses:check` 会校验一致性）。',
    '',
    '本目录随安装包分发（`resources/licenses/`）。清单与 `THIRD_PARTY_NOTICES.md` 一一对应：',
    '后者说明分发范围，本目录提供对应的许可全文。',
    '',
    '| 文件 | 包 | 版本 | 许可 | 来源 |',
    '|---|---|---|---|---|',
    ...sorted.map(
      (target) =>
        `| \`${target.file.replace(`${LICENSE_DIR}/`, '')}\` | ${target.package} | ${target.version} | ${target.license} | ${originLabel(target.origin)} |`,
    ),
    '',
    '## 不在本目录的组件',
    '',
    '- 官方 QQ 插件（`@tencent-connect/qqbot-connector`）为 `UNLICENSED`：**仅在线安装**，本软件不复制、不镜像、不随包分发其字节，因此不在此处提供全文；',
    '- 个人 QQ 适配器（`dsh-qq-link`）由用户从上游获取，同上。',
    '',
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 校验用：文件是否属于必须存在的集合（`node.json` 等清单直接引用的那几个）。 */
export function requiredRuntimeFiles(): string[] {
  return (Object.keys(RUNTIME_LICENSE_FILES) as RuntimeLicenseId[])
    .map((id) => runtimeLicenseFile(id))
    .sort((a, b) => a.localeCompare(b));
}
