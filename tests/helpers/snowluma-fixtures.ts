import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SnowLumaManifestSchema, type SnowLumaManifest } from '@dda/spec';
import { sha256File, writeZip } from '@dda/core';

/**
 * 测试用 SnowLuma 安装包与清单。
 *
 * 版本号用 9.9.9 等假版本，避免与真实锁定版本混淆；结构与官方 v2.4.0 实测结构一致
 * （见 docs/M3.3-实施报告.md §3），因此安装器走的是同一条校验路径。
 */

export const FIXTURE_VERSION = '9.9.9';
export const FIXTURE_SHA = 'f'.repeat(64);

export function fixtureManifest(overrides: { authorizationRef?: string; version?: string } = {}): SnowLumaManifest {
  const version = overrides.version ?? FIXTURE_VERSION;
  return SnowLumaManifestSchema.parse({
    id: 'snowluma',
    displayName: 'SnowLuma',
    version,
    projectUrl: 'https://github.com/SnowLuma/SnowLuma',
    releasesUrl: 'https://github.com/SnowLuma/SnowLuma/releases',
    license: {
      name: 'SnowLuma Source-Available Non-Commercial License 1.0',
      spdx: 'NOASSERTION',
      commercialUse: 'prohibited',
      redistribution: 'conditional',
      textUrl: 'https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE',
      eulaUrl: 'https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md',
      requiresUserConsent: true,
      restrictedActions: ['通过自动化脚本部署'],
    },
    ...(overrides.authorizationRef ? { authorizationRef: overrides.authorizationRef } : {}),
    automationPolicy: 'authorized-only',
    assets: [
      {
        platform: 'win32-x64',
        fileName: `SnowLuma-v${version}-win-x64.zip`,
        url: `https://github.com/SnowLuma/SnowLuma/releases/download/v${version}/SnowLuma-v${version}-win-x64.zip`,
        sizeBytes: 1234,
        sha256: FIXTURE_SHA,
      },
    ],
    ports: { webui: 5099, onebotHttp: 3000, onebotWs: 3001 },
    requires: ['qqnt'],
    layout: { configDir: 'config', releaseFile: 'release.json', entry: 'index.mjs', launcher: 'launcher.bat' },
  });
}

export const FIXTURE_ENTRIES = [
  'EULA.md',
  'PRIVACY.md',
  'check-node-version.cjs',
  'client',
  'index.mjs',
  'launcher.bat',
  'native',
  'package.json',
  'release.json',
];

export function fixtureReleaseJson(version = FIXTURE_VERSION): string {
  return JSON.stringify({ version, target: 'win32-x64', entries: FIXTURE_ENTRIES }, null, 2);
}

/** 写出一个"解压后"的包目录（与官方包同构），返回目录。 */
export async function writeFixturePackageDir(
  dir: string,
  options: { version?: string; marker?: string } = {},
): Promise<string> {
  const version = options.version ?? FIXTURE_VERSION;
  const marker = options.marker ?? 'fixture';
  await mkdir(join(dir, 'client'), { recursive: true });
  await mkdir(join(dir, 'native'), { recursive: true });
  await writeFile(join(dir, 'release.json'), fixtureReleaseJson(version), 'utf8');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@snowluma/runtime', version, type: 'module', main: 'index.mjs' }),
    'utf8',
  );
  await writeFile(join(dir, 'index.mjs'), `// ${marker} runtime ${version}\n`, 'utf8');
  await writeFile(join(dir, 'node.exe'), `MZ ${marker}`, 'utf8');
  await writeFile(join(dir, 'launcher.bat'), 'node ./index.mjs\npause\n', 'utf8');
  await writeFile(join(dir, 'check-node-version.cjs'), 'module.exports = {}\n', 'utf8');
  await writeFile(join(dir, 'EULA.md'), '# EULA\n', 'utf8');
  await writeFile(join(dir, 'PRIVACY.md'), '# PRIVACY\n', 'utf8');
  await writeFile(join(dir, 'client', 'index.html'), '<html></html>', 'utf8');
  await writeFile(join(dir, 'native', 'snowluma-win32-x64.node'), 'binary', 'utf8');
  return dir;
}

/** 把"解压后的包目录"打成一个 zip（模拟官方发布包），返回路径/大小/哈希。 */
export async function buildFixtureZip(
  zipPath: string,
  options: { version?: string; marker?: string } = {},
): Promise<{ zipPath: string; sizeBytes: number; sha256: string }> {
  const version = options.version ?? FIXTURE_VERSION;
  const marker = options.marker ?? 'fixture';
  const entries = [
    { name: 'release.json', content: fixtureReleaseJson(version) },
    { name: 'package.json', content: JSON.stringify({ name: '@snowluma/runtime', version, type: 'module' }) },
    { name: 'index.mjs', content: `// ${marker} runtime ${version}\n` },
    { name: 'node.exe', content: `MZ ${marker}` },
    { name: 'launcher.bat', content: 'node ./index.mjs\npause\n' },
    { name: 'check-node-version.cjs', content: 'module.exports = {}\n' },
    { name: 'EULA.md', content: '# EULA\n' },
    { name: 'PRIVACY.md', content: '# PRIVACY\n' },
    { name: 'client/index.html', content: '<html></html>' },
    { name: 'native/snowluma-win32-x64.node', content: 'binary' },
  ];
  const { bytes } = await writeZip(zipPath, entries);
  const sha256 = await sha256File(zipPath);
  return { zipPath, sizeBytes: bytes, sha256 };
}
