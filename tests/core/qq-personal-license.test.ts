import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyDistribution, decideAutomation, decideManifestAutomation, hasAuthorization, parseSnowLumaManifest } from '@dda/core';
import { selectAsset, SnowLumaManifestSchema } from '@dda/spec';

const manifestPath = join(
  process.cwd(),
  'apps',
  'desktop',
  'resources',
  'manifests',
  'snowluma.json',
);

async function loadManifest() {
  return parseSnowLumaManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
}

describe('SnowLuma 清单（真实文件校验）', () => {
  it('仓库里的 snowluma.json 能通过 schema，且版本/哈希/大小与调查结论一致', async () => {
    const manifest = await loadManifest();
    const asset = selectAsset(manifest);

    expect(manifest.id).toBe('snowluma');
    expect(manifest.version).toBe('2.4.0');
    expect(asset.fileName).toBe('SnowLuma-v2.4.0-win-x64.zip');
    expect(asset.sizeBytes).toBe(43_339_979);
    expect(asset.sha256).toBe('93096cb6d4cf576999094e9f7d1c9fb08e22f6b41c879182f015e639dc437613');
  });

  it('许可事实与端口/布局必须写清楚（否则 UI 无法向用户披露）', async () => {
    const manifest = await loadManifest();
    expect(manifest.license.commercialUse).toBe('prohibited');
    expect(manifest.license.requiresUserConsent).toBe(true);
    expect(manifest.license.restrictedActions.join()).toContain('自动化脚本部署');
    expect(manifest.ports).toEqual({ webui: 5099, onebotHttp: 3000, onebotWs: 3001 });
    expect(manifest.requires).toContain('qqnt');
    expect(manifest.layout.launcher).toBe('launcher.bat');
  });

  it('未登记授权文号也可以自动下载安装', async () => {
    const manifest = await loadManifest();
    expect(manifest.authorizationRef).toBeUndefined();

    const decision = decideManifestAutomation(manifest);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('官方发布页');
  });

  it('坏清单整份拒绝：sha256 长度不对、缺 automationPolicy 都要报错', () => {
    const broken = {
      id: 'snowluma',
      displayName: 'SnowLuma',
      version: '2.4.0',
      projectUrl: 'https://example.com',
      releasesUrl: 'https://example.com/r',
      license: {
        name: 'x',
        spdx: 'NOASSERTION',
        commercialUse: 'prohibited',
        redistribution: 'conditional',
        textUrl: 'https://example.com/l',
        eulaUrl: 'https://example.com/e',
        requiresUserConsent: true,
      },
      assets: [
        { platform: 'win32-x64', fileName: 'a.zip', url: 'https://example.com/a.zip', sizeBytes: 1, sha256: 'abc' },
      ],
      ports: { webui: 5099, onebotHttp: 3000, onebotWs: 3001 },
      requires: ['qqnt'],
      layout: { configDir: 'config', releaseFile: 'release.json', entry: 'index.mjs', launcher: 'launcher.bat' },
    };

    expect(() => SnowLumaManifestSchema.parse(broken)).toThrow();
  });
});

describe('许可判定（PRD §12.1 三选一）', () => {
  it('有书面授权 → 可自动安装', () => {
    const facts = { commercialUse: 'prohibited' as const, redistribution: 'conditional' as const, authorizationRef: 'SL-2026-001' };
    expect(hasAuthorization(facts)).toBe(true);
    expect(classifyDistribution(facts)).toBe('auto-install');
    expect(decideAutomation(facts).allowed).toBe(true);
  });

  it('无书面授权也可以自动安装，分类函数仍标明不可再分发', () => {
    const facts = { commercialUse: 'prohibited' as const, redistribution: 'conditional' as const };
    expect(classifyDistribution(facts)).toBe('guide-only');
    const decision = decideAutomation(facts, 'SnowLuma');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('SnowLuma');
    expect(decision.reason).toContain('官方发布页');
  });

  it('许可未知时分类为不可用，自动安装仍按产品决定放行', () => {
    const facts = { commercialUse: 'unknown' as const, redistribution: 'unknown' as const };
    expect(classifyDistribution(facts)).toBe('unavailable');
    expect(decideAutomation(facts).allowed).toBe(true);
  });

  it('无授权 + 允许商用允许再分发 → 可自动安装', () => {
    const facts = { commercialUse: 'allowed' as const, redistribution: 'allowed' as const };
    expect(classifyDistribution(facts)).toBe('auto-install');
  });

  it('授权文号过短视为未授权（防止占位字符串误开闸门）', () => {
    const facts = { commercialUse: 'prohibited' as const, redistribution: 'conditional' as const, authorizationRef: '  a  ' };
    expect(hasAuthorization(facts)).toBe(false);
    expect(decideAutomation(facts).allowed).toBe(true);
  });
});
