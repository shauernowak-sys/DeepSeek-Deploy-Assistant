import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createNodeInstallDeps,
  installPackage,
  loadSnowLumaManifest,
  resolveRelease,
  sha256File,
  type InstallFsDeps,
} from '@dda/core';
import { selectAsset } from '@dda/spec';

/**
 * 真实官方安装包验收（门控）。
 *
 * 只有显式提供**已下载的官方包**路径时运行，避免 CI 依赖 43 MB 网络下载：
 *   DDA_REAL_SNOWLUMA_ZIP=D:\path\to\SnowLuma-v2.4.0-win-x64.zip
 *
 * 它验证三件真实的事：
 *  1. 官方包的实际 SHA-256 与内置清单一致（清单没有被随手改动）；
 *  2. GitHub Releases API 的 size/digest 与清单一致；
 *  3. 我们的安装器能把这个真实包正确解压、结构校验并通过（不含"运行"）。
 *
 * 注意：本测试**不启动** SnowLuma，也不触碰任何用户数据。
 */
const ZIP = process.env.DDA_REAL_SNOWLUMA_ZIP ?? '';
const MANIFESTS = resolve(process.cwd(), 'apps', 'desktop', 'resources', 'manifests');

describe.skipIf(!ZIP)('真实官方包：版本核对与安装器兼容性', () => {
  it('官方包的哈希/大小与清单和 GitHub API 一致，且安装器能正确落盘', async () => {
    const manifest = await loadSnowLumaManifest(MANIFESTS);
    const asset = selectAsset(manifest);

    const actualSha = await sha256File(ZIP);
    const release = await resolveRelease(
      {
        getJson: async (url, init) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 15000);
          try {
            const response = await fetch(url, { headers: init?.headers, signal: controller.signal });
            return { status: response.status, body: (await response.json()) as unknown };
          } finally {
            clearTimeout(timer);
          }
        },
      },
      manifest,
    );

    console.log('[real] manifest version =', manifest.version);
    console.log('[real] manifest sha256  =', asset.sha256);
    console.log('[real] actual   sha256  =', actualSha);
    console.log('[real] verifiedAgainst   =', release.verifiedAgainst);
    for (const line of release.evidence) console.log('[real] evidence:', line);

    expect(actualSha.toLowerCase()).toBe(asset.sha256.toLowerCase());
    expect(release.verifiedAgainst).toBe('manifest+github');

    const root = await mkdtemp(join(tmpdir(), 'dda-real-snowluma-'));
    try {
      const base = createNodeInstallDeps();
      const deps: InstallFsDeps = { ...base, freeBytes: async () => 20 * 1024 * 1024 * 1024 };
      const result = await installPackage(deps, {
        zipPath: ZIP,
        installDir: join(root, 'SnowLuma'),
        expectedVersion: manifest.version,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        sourceUrl: asset.url,
        fileName: asset.fileName,
        stagingDir: join(root, 'state', 'staging'),
        backupDir: join(root, 'state', 'backup'),
        recordPath: join(root, 'state', 'install.json'),
      });

      for (const line of result.evidence) console.log('[real] install:', line);
      console.log('[real] files =', result.files, 'bytes =', result.bytes);

      expect(result.changed).toBe(true);
      const releaseJson = JSON.parse(await readFile(join(root, 'SnowLuma', 'release.json'), 'utf8')) as {
        version: string;
        target: string;
      };
      expect(releaseJson.version).toBe(manifest.version);
      expect(releaseJson.target).toBe('win32-x64');
      // 官方 release.json 不列 node.exe，安装器必须把它一起落盘。
      expect(await base.exists(join(root, 'SnowLuma', 'node.exe'))).toBe(true);
      expect(await base.exists(join(root, 'SnowLuma', 'index.mjs'))).toBe(true);
      expect(await base.exists(join(root, 'SnowLuma', 'native', 'snowluma-win32-x64.node'))).toBe(true);
      // 安装过程不得创建 config/ 或 data/（应由运行中的 SnowLuma 创建）。
      expect(await base.exists(join(root, 'SnowLuma', 'config'))).toBe(false);
      expect(await base.exists(join(root, 'SnowLuma', 'data'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
