import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodeRegistryDirName,
  extractTarballHosts,
  formatTarballHosts,
  listMetadataRegistrySources,
  singleSourceHost,
} from '@dda/core';

/** 取自真实 pnpm 输出形态（含进度行、无关 URL 与重复 tarball）。 */
const SAMPLE = `
Progress: resolved 532, reused 449, downloaded 8, added 8, done
.../esbuild@0.28.2/node_modules/esbuild postinstall: Done
+ @tencent-connect/dsh-qqbot 0.5.5
  https://registry.npmmirror.com/@tencent-connect/dsh-qqbot/-/dsh-qqbot-0.5.5.tgz
  https://registry.npmmirror.com/yaml/-/yaml-2.8.1.tgz
  https://registry.npmmirror.com/yaml/-/yaml-2.8.1.tgz
  https://registry.npmjs.org/@tencent-connect/qqbot-connector/-/qqbot-connector-1.2.0.tgz
  文档 https://example.com/readme.html 不应计入
`;

describe('D06 tarball 实际 host 记录', () => {
  it('按 host 计数并按次数降序', () => {
    const report = extractTarballHosts(SAMPLE);
    expect(report.total).toBe(4);
    expect(report.hosts).toEqual([
      { host: 'registry.npmmirror.com', count: 3 },
      { host: 'registry.npmjs.org', count: 1 },
    ]);
  });

  it('空输出时说"未取得"，不假装 0 个', () => {
    const report = extractTarballHosts('Progress: resolved 1, reused 1');
    expect(report.total).toBe(0);
    expect(formatTarballHosts(report)).toContain('未取得');
  });

  it('多源时给出可读摘要；单源时能识别出来', () => {
    const report = extractTarballHosts(SAMPLE);
    const text = formatTarballHosts(report);
    expect(text).toContain('registry.npmmirror.com × 3');
    expect(text).toContain('registry.npmjs.org × 1');
    // 前置验证记录过"配置镜像仍从官方源下载部分 tarball"——这里必须如实呈现两个 host。
    expect(singleSourceHost(report)).toBeUndefined();

    expect(singleSourceHost(extractTarballHosts('https://registry.npmmirror.com/a/-/a-1.0.0.tgz'))).toBe(
      'registry.npmmirror.com',
    );
  });

  it('解码 pnpm metadata 目录名（`+` 代表 `/`）', () => {
    expect(decodeRegistryDirName('https%3A+registry.npmmirror.com')).toBe('https://registry.npmmirror.com');
    expect(decodeRegistryDirName('not-a-registry')).toBeUndefined();
  });

  it('列出某次安装实际询问过的 registry（干净缓存复测用）', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'dda-cache-'));
    await mkdir(join(cache, 'v12', 'metadata', 'https%3A+registry.npmmirror.com'), { recursive: true });
    await mkdir(join(cache, 'v12', 'metadata', 'https%3A+registry.npmjs.org'), { recursive: true });

    const report = await listMetadataRegistrySources(cache);
    expect(report.registries).toEqual(['https://registry.npmjs.org', 'https://registry.npmmirror.com']);
    expect(report.metadataDir).toContain('v12');

    const empty = await listMetadataRegistrySources(join(cache, 'missing'));
    expect(empty.registries).toEqual([]);
  });
});
