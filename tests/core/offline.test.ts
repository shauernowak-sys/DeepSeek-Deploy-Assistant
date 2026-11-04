import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OFFICIAL_QQBOT_ENTRY } from '../../catalog/entries/official-qqbot';
import {
  assertCachedTarball,
  buildOfflineBundle,
  distributionPolicyForEntry,
  offlineFallbackHint,
  offlineInstallSpec,
} from '@dda/core';
import { CatalogSchema, DdaError } from '@dda/spec';
import type { CatalogEntry } from '@dda/spec';

function allowedEntry(): CatalogEntry {
  const parsed = CatalogSchema.parse({
    schemaVersion: 1,
    entries: [
      {
        id: 'plg-offline-ok',
        name: 'offline-ok',
        version: '1.0.0',
        publishTimestamp: 1,
        source: { type: 'npm' },
        enginesDsh: '=0.2.0-rc.2',
        compat: 'C1-prime',
        license: { spdx: 'MIT', redistributable: true },
        integrity: 'sha512-AAAA',
        depsClosure: [{ name: 'offline-ok', version: '1.0.0', license: 'MIT' }],
        acceptance: [{ id: 'acc-run', step: '启动一次插件', evidence: '日志出现已加载' }],
        en: { name: 'Offline OK', summary: 'Allows redistribution.' },
        zh: { name: '可离线', summary: '可离线', description: '可离线', usage: '可离线', risk: '无' },
        category: 'qq-bot',
        labels: [],
        keywords: [],
        safety: { network: [], permissions: [], requiresRestart: false },
        installNotes: [],
        status: 'verified',
      },
    ],
  });
  return parsed.entries[0]!;
}

async function failureOf(promise: Promise<unknown>): Promise<DdaError> {
  try {
    await promise;
  } catch (error) {
    return error as DdaError;
  }
  throw new Error('预期失败，但实际成功');
}

describe('D05 条目分发策略（复用 D11 门禁）', () => {
  it('QQ 插件只允许在线安装，并点名不可再分发的包', () => {
    const policy = distributionPolicyForEntry(OFFICIAL_QQBOT_ENTRY);
    expect(policy.allowed).toEqual(['online-install']);
    expect(policy.blocked.map((item) => item.package)).toContain('@tencent-connect/qqbot-connector');
    expect(policy.notice).toContain('只能在线安装');
  });

  it('全允许条目同时允许在线安装与离线包', () => {
    const policy = distributionPolicyForEntry(allowedEntry());
    expect(policy.allowed).toEqual(['online-install', 'offline-bundle']);
    expect(policy.blocked).toEqual([]);
  });

  it('QQ 条目在 UI 契约上就没有离线入口（catalog 文案 + 策略）', () => {
    expect(OFFICIAL_QQBOT_ENTRY.license.redistributable).toBe(false);
    expect(OFFICIAL_QQBOT_ENTRY.installNotes.join('')).toContain('不提供离线包');
    expect(distributionPolicyForEntry(OFFICIAL_QQBOT_ENTRY).allowed).not.toContain('offline-bundle');
  });
});

describe('D05 离线打包 API', () => {
  it('含 UNLICENSED 的条目直接拒绝，且不写任何文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-offline-'));
    const outDir = join(root, 'out');

    const error = await failureOf(
      buildOfflineBundle({
        entry: OFFICIAL_QQBOT_ENTRY,
        files: [{ path: 'pkg.tgz', content: 'x' }],
        outDir,
      }),
    );

    expect(error).toBeInstanceOf(DdaError);
    expect(error.code).toBe('E_DISTRIBUTION_BLOCKED');
    expect(error.message).toContain('@tencent-connect/qqbot-connector');
    await expect(stat(outDir)).rejects.toThrow();
  });

  it('全允许条目产出 manifest（逐文件哈希 + 整包指纹）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-offline-'));
    const manifest = await buildOfflineBundle({
      entry: allowedEntry(),
      files: [
        { path: 'offline-ok-1.0.0.tgz', content: 'tarball-bytes' },
        { path: 'LICENSE', content: 'MIT' },
      ],
      outDir: root,
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.map((file) => file.path)).toEqual(['LICENSE', 'offline-ok-1.0.0.tgz']);
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(manifest.bundleSha256).toMatch(/^[a-f0-9]{64}$/);

    const written = JSON.parse(await readFile(join(root, 'plg-offline-ok', 'bundle.json'), 'utf8')) as {
      bundleSha256: string;
    };
    expect(written.bundleSha256).toBe(manifest.bundleSha256);
    expect(await readFile(join(root, 'plg-offline-ok', 'LICENSE'), 'utf8')).toBe('MIT');
  });

  it('包内路径穿越被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-offline-'));
    await expect(
      buildOfflineBundle({
        entry: allowedEntry(),
        files: [{ path: '../evil', content: 'x' }],
        outDir: root,
      }),
    ).rejects.toMatchObject({ code: 'E_EXTRACT_UNSAFE_PATH' });
  });
});

describe('D05 缓存哈希校验与离线提示', () => {
  it('缓存哈希一致 → 通过；被篡改 → 删除并报 E_HASH_MISMATCH', async () => {
    const { createHash } = await import('node:crypto');
    const root = await mkdtemp(join(tmpdir(), 'dda-cache-'));
    const file = join(root, 'cached.tgz');
    await writeFile(file, 'good-bytes', 'utf8');
    const expected = createHash('sha256').update('good-bytes').digest('hex');

    await expect(assertCachedTarball(file, expected)).resolves.toBeUndefined();

    await writeFile(file, 'tampered', 'utf8');
    await expect(assertCachedTarball(file, expected)).rejects.toMatchObject({ code: 'E_HASH_MISMATCH' });
    await expect(stat(file)).rejects.toThrow();
  });

  it('缓存不存在 → 可执行提示（先联网安装一次）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-cache-'));
    const error = await failureOf(assertCachedTarball(join(root, 'missing.tgz'), 'a'.repeat(64)));
    expect(error.code).toBe('E_DOWNLOAD_NETWORK');
    expect(error.hint).toContain('联网安装');
  });

  it('离线 spec 是绝对路径；提示文案给出具体动作', () => {
    expect(offlineInstallSpec('C:\\cache\\a.tgz')).toBe('C:\\cache\\a.tgz');
    expect(offlineFallbackHint('offline-bundle')).toContain('不允许离线分发');
  });
});
