import { describe, expect, it } from 'vitest';

import { officialAssetProblems, resolveRelease, type ReleaseHttpDeps } from '@dda/core';
import { DdaError } from '@dda/spec';

import { FIXTURE_SHA, FIXTURE_VERSION, fixtureManifest } from '../helpers/snowluma-fixtures';

const FILE = `SnowLuma-v${FIXTURE_VERSION}-win-x64.zip`;

function httpDeps(handler: (url: string) => { status: number; body: unknown }): ReleaseHttpDeps {
  return { getJson: async (url) => handler(url) };
}

const goodBody = {
  tag_name: `v${FIXTURE_VERSION}`,
  assets: [{ name: FILE, size: 1234, digest: `sha256:${FIXTURE_SHA}` }],
};

describe('SnowLuma 官方版本管理', () => {
  it('清单锁定的官方地址被接受', () => {
    expect(
      officialAssetProblems({
        url: `https://github.com/SnowLuma/SnowLuma/releases/download/v${FIXTURE_VERSION}/${FILE}`,
        fileName: FILE,
        version: FIXTURE_VERSION,
      }),
    ).toEqual([]);
  });

  it('拒绝第三方镜像地址与非官方文件名', () => {
    const problems = officialAssetProblems({
      url: `https://mirror.example.com/SnowLuma/${FILE}`,
      fileName: 'SnowLuma-win-x64.zip',
      version: FIXTURE_VERSION,
    });
    expect(problems.join(' ')).toContain('github.com');
    expect(problems.join(' ')).toContain('官方 Windows x64 包');
  });

  it('GitHub API 的 size 与 digest 一致时，判定为 manifest+github', async () => {
    const release = await resolveRelease(
      httpDeps(() => ({ status: 200, body: goodBody })),
      fixtureManifest(),
    );
    expect(release.verifiedAgainst).toBe('manifest+github');
    expect(release.version).toBe(FIXTURE_VERSION);
    expect(release.sha256).toBe(FIXTURE_SHA);
    expect(release.evidence.join('\n')).toContain('sha256 与清单一致');
  });

  it('上游资产大小与清单不一致时整份拒绝', async () => {
    const body = { ...goodBody, assets: [{ ...goodBody.assets[0], size: 999 }] };
    await expect(
      resolveRelease(httpDeps(() => ({ status: 200, body })), fixtureManifest()),
    ).rejects.toBeInstanceOf(DdaError);
  });

  it('上游 digest 与清单不一致时整份拒绝', async () => {
    const body = { ...goodBody, assets: [{ ...goodBody.assets[0], digest: `sha256:${'0'.repeat(64)}` }] };
    await expect(
      resolveRelease(httpDeps(() => ({ status: 200, body })), fixtureManifest()),
    ).rejects.toThrow(/SHA-256 与清单不一致/);
  });

  it('标签不是锁定版本时拒绝（禁止 latest）', async () => {
    const body = { ...goodBody, tag_name: 'v0.0.1' };
    await expect(resolveRelease(httpDeps(() => ({ status: 200, body })), fixtureManifest())).rejects.toThrow(
      /与清单锁定的/,
    );
  });

  it('断网时降级为仅按清单校验，并明确写入证据', async () => {
    const release = await resolveRelease(
      httpDeps(() => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
      fixtureManifest(),
    );
    expect(release.verifiedAgainst).toBe('manifest-only');
    expect(release.evidence.join('\n')).toContain('改为仅按内置清单校验');
  });

  it('allowOffline=false 时断网直接失败', async () => {
    await expect(
      resolveRelease(
        httpDeps(() => {
          throw new Error('offline');
        }),
        fixtureManifest(),
        { allowOffline: false },
      ),
    ).rejects.toThrow(/无法联网核对官方版本/);
  });

  it('上游有新版本时给出提示但不阻断', async () => {
    const release = await resolveRelease(
      httpDeps((url) =>
        url.endsWith('/releases/latest')
          ? { status: 200, body: { tag_name: 'v99.0.0' } }
          : { status: 200, body: goodBody },
      ),
      fixtureManifest(),
    );
    expect(release.verifiedAgainst).toBe('manifest+github');
    expect(release.evidence.join('\n')).toContain('v99.0.0');
  });
});
