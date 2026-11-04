import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { OFFICIAL_QQBOT_ENTRY } from '../../catalog/entries/official-qqbot';
import {
  assertLocalImportAllowed,
  inspectTgz,
  listTarballEntries,
  normalizeEntryName,
  prepareLocalImport,
  validateImportedPackage,
} from '@dda/core';
import { CatalogSchema } from '@dda/spec';
import type { CatalogEntry } from '@dda/spec';

/** 合成一个最小 ustar + gzip。 */
function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const PACKAGE = {
  name: 'dda-fixture-plugin',
  version: '1.2.3',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  files: ['lib', 'cordis.patch.yml'],
};

function allowedEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  const parsed = CatalogSchema.parse({
    schemaVersion: 1,
    entries: [
      {
        id: 'plg-fixture',
        name: 'dda-fixture-plugin',
        version: '1.2.3',
        publishTimestamp: 1,
        source: { type: 'npm' },
        enginesDsh: '=0.2.0-rc.2',
        compat: 'C1-prime',
        license: { spdx: 'MIT', redistributable: true },
        integrity: 'sha512-AAAA',
        depsClosure: [{ name: 'dda-fixture-plugin', version: '1.2.3', license: 'MIT' }],
        acceptance: [{ id: 'acc-run', step: '启动一次插件', evidence: '日志出现插件已加载' }],
        en: { name: 'Fixture plugin', summary: 'Fixture for D04 tests.' },
        zh: {
          name: '夹具插件',
          summary: '测试用',
          description: '测试用',
          usage: '测试用',
          risk: '无',
        },
        category: 'qq-bot',
        labels: [],
        keywords: [],
        safety: { network: [], permissions: [], requiresRestart: false },
        installNotes: [],
        status: 'verified',
        ...overrides,
      },
    ],
  });
  return parsed.entries[0]!;
}

async function fixtureTgz(outDir: string, name = 'fixture.tgz'): Promise<string> {
  const path = join(outDir, name);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path,
    tarGz({
      'package.json': JSON.stringify(PACKAGE),
      'cordis.patch.yml': 'enabled: true\n',
      'lib/index.js': 'module.exports = 1;\n',
    }),
  );
  return path;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('预期失败，但实际成功');
}

describe('D04 许可门禁先行（导入即分发）', () => {
  it('官方 QQ 插件闭包含 UNLICENSED → 直接拒绝，且发生在读文件之前', async () => {
    const error = await failureOf(
      prepareLocalImport({
        // 路径根本不存在：能走到"文件不存在"就说明门禁没有先行
        sourcePath: join(tmpdir(), 'does-not-exist-anywhere'),
        entry: OFFICIAL_QQBOT_ENTRY,
        outDir: tmpdir(),
        packDirectory: async () => {
          throw new Error('不应打包');
        },
      }),
    );

    expect(error.message).toContain('不能通过本地导入分发');
    expect(error.message).toContain('@tencent-connect/qqbot-connector');
    expect((error as { code?: string }).code).toBe('E_DISTRIBUTION_BLOCKED');
  });

  it('闭包全允许的条目可以通过门禁', () => {
    expect(() => assertLocalImportAllowed(allowedEntry())).not.toThrow();
  });
});

describe('D04 包内容校验', () => {
  it('name/version 与 catalog 不一致 → 拒绝并写明期望与实际', () => {
    const problems = validateImportedPackage({ ...PACKAGE, version: '9.9.9' }, allowedEntry());
    expect(problems.join('')).toContain('9.9.9');
    expect(problems.join('')).toContain('1.2.3');
  });

  it('没有声明 dsh.bundle.patch → 拒绝（不是 Harness 插件包）', () => {
    const problems = validateImportedPackage({ name: 'dda-fixture-plugin', version: '1.2.3' }, allowedEntry());
    expect(problems.join('')).toContain('dsh.bundle.patch');
  });

  it('含生命周期脚本 → 拒绝', () => {
    const problems = validateImportedPackage(
      { ...PACKAGE, scripts: { postinstall: 'node evil.js' } },
      allowedEntry(),
    );
    expect(problems.join('')).toContain('生命周期脚本');
  });
});

describe('D04 三种来源统一产出绝对路径 tgz', () => {
  it('目录导入：打包产物为绝对路径，并计算 sha256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-import-dir-'));
    const dir = join(root, 'pkg');
    await mkdir(join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify(PACKAGE), 'utf8');
    await writeFile(join(dir, 'cordis.patch.yml'), 'enabled: true\n', 'utf8');

    const outDir = join(root, 'out');
    const packed = await fixtureTgz(outDir, 'dda-fixture-plugin-1.2.3.tgz');

    const result = await prepareLocalImport({
      sourcePath: dir,
      entry: allowedEntry(),
      outDir,
      packDirectory: async () => packed,
    });

    expect(result.kind).toBe('directory');
    expect(result.tgzPath).toBe(packed);
    expect(result.tgzPath.startsWith(root)).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.hashChecked).toBe(false);
    expect(result.warnings.join('')).toContain('未提供期望哈希');
  });

  it('tgz 导入：直接使用该文件（不复制、不删除用户的包）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-import-tgz-'));
    const source = await fixtureTgz(root);

    const result = await prepareLocalImport({
      sourcePath: source,
      entry: allowedEntry(),
      outDir: root,
      packDirectory: async () => {
        throw new Error('tgz 不需要重新打包');
      },
    });

    expect(result.kind).toBe('tgz');
    expect(result.tgzPath).toBe(source);
    expect(result.sha256).toBe(sha256(await readFile(source)));
    await expect(stat(source)).resolves.toBeDefined();
  });

  it('zip 导入：解压后重新打包成 tgz', async () => {
    const { writeZip } = await import('@dda/core');
    const root = await mkdtemp(join(tmpdir(), 'dda-import-zip-'));
    const zipPath = join(root, 'plugin.zip');
    await writeZip(zipPath, [
      { name: 'package.json', content: JSON.stringify(PACKAGE) },
      { name: 'cordis.patch.yml', content: 'enabled: true\n' },
    ]);

    const outDir = join(root, 'out');
    const packed = await fixtureTgz(outDir, 'repacked.tgz');

    const result = await prepareLocalImport({
      sourcePath: zipPath,
      entry: allowedEntry(),
      outDir,
      packDirectory: async () => packed,
    });

    expect(result.kind).toBe('zip');
    expect(result.tgzPath).toBe(packed);
  });

  it('目录缺少 package.json → 可读错误', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-import-empty-'));
    await expect(
      prepareLocalImport({
        sourcePath: root,
        entry: allowedEntry(),
        outDir: root,
        packDirectory: async () => {
          throw new Error('不应打包');
        },
      }),
    ).rejects.toThrowError(/没有 package\.json/);
  });
});

describe('D04 安全与哈希', () => {
  it('tgz 内路径穿越 → 拒绝（E_EXTRACT_UNSAFE_PATH）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-import-slip-'));
    const evil = join(root, 'evil.tgz');
    await writeFile(
      evil,
      gzipSync(
        (() => {
          const header = Buffer.alloc(512);
          const data = Buffer.from('x');
          header.write('../evil.txt', 0, 100, 'utf8');
          header.write('0000644\0', 100, 8, 'ascii');
          header.write('0000000\0', 108, 8, 'ascii');
          header.write('0000000\0', 116, 8, 'ascii');
          header.write('00000000001\0', 124, 12, 'ascii');
          header.write('00000000000\0', 136, 12, 'ascii');
          header.write('        ', 148, 8, 'ascii');
          header.write('0', 156, 1, 'ascii');
          header.write('ustar\0', 257, 6, 'ascii');
          header.write('00', 263, 2, 'ascii');
          const sum = header.reduce((total, byte) => total + byte, 0);
          header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
          return Buffer.concat([header, data, Buffer.alloc(511), Buffer.alloc(1024)]);
        })(),
      ),
    );

    await expect(inspectTgz(evil)).rejects.toMatchObject({ code: 'E_EXTRACT_UNSAFE_PATH' });
  });

  it('期望哈希不一致 → 拒绝并删除本次生成的 tgz（不留半成品）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-import-hash-'));
    const dir = join(root, 'pkg');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify(PACKAGE), 'utf8');
    const outDir = join(root, 'out');
    const packed = await fixtureTgz(outDir, 'will-be-deleted.tgz');

    await expect(
      prepareLocalImport({
        sourcePath: dir,
        entry: allowedEntry(),
        outDir,
        expectedSha256: 'deadbeef'.repeat(8),
        packDirectory: async () => packed,
      }),
    ).rejects.toMatchObject({ code: 'E_HASH_MISMATCH' });

    await expect(stat(packed)).rejects.toThrow();
  });

  it('打包结果缺少 bundle patch（files 漏配）→ 拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-import-nopatch-'));
    const dir = join(root, 'pkg');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify(PACKAGE), 'utf8');

    const outDir = join(root, 'out');
    await mkdir(outDir, { recursive: true });
    const broken = join(outDir, 'broken.tgz');
    await writeFile(
      broken,
      tarGz({ 'package.json': JSON.stringify(PACKAGE), 'lib/index.js': 'x' }),
    );

    await expect(
      prepareLocalImport({
        sourcePath: dir,
        entry: allowedEntry(),
        outDir,
        packDirectory: async () => broken,
      }),
    ).rejects.toThrowError(/打包结果缺少 cordis\.patch\.yml/);
  });
});

describe('D04 tar 读取工具', () => {
  it('列出条目并归一化 package/ 前缀', () => {
    const entries = listTarballEntries(gunzipSync(tarGz({ 'package.json': '{}', 'lib/a.js': 'x' })));
    expect(entries.map((entry) => entry.name)).toEqual(['package/package.json', 'package/lib/a.js']);
    expect(normalizeEntryName('package/lib/a.js')).toBe('lib/a.js');
    expect(normalizeEntryName('./lib/a.js')).toBe('lib/a.js');
  });
});
