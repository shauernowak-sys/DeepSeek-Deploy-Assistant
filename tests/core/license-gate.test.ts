import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OFFICIAL_QQBOT_ENTRY } from '../../catalog/entries/official-qqbot';
import {
  assertRedistributable,
  classifyLicense,
  evaluateClosure,
  normalizeSpdx,
  parsePnpmListJson,
  readLicenseFromDir,
  renderThirdPartyNotices,
  resolveClosureLicenses,
} from '@dda/core';
import { DdaError, ERROR_CODES } from '@dda/spec';

describe('SPDX 归一化（前置验证 §5.4 的覆盖缺口）', () => {
  it('把非 SPDX 写法映射为规范标识', () => {
    expect(normalizeSpdx('Apache 2.0')).toBe('Apache-2.0');
    expect(normalizeSpdx('  apache   license, version 2.0 ')).toBe('Apache-2.0');
    expect(normalizeSpdx('Python 2.0')).toBe('Python-2.0');
    expect(normalizeSpdx('MIT(from file)')).toBe('MIT');
  });

  it('未知写法原样保留（交给 needs-review，而不是猜成允许）', () => {
    expect(normalizeSpdx('Weird-1.0')).toBe('Weird-1.0');
    expect(classifyLicense('Weird-1.0')).toBe('needs-review');
  });
});

describe('许可三态判定', () => {
  it('UNLICENSED / SEE LICENSE IN / 未声明 一律 denied', () => {
    expect(classifyLicense('UNLICENSED')).toBe('denied');
    expect(classifyLicense('SEE LICENSE IN LICENSE')).toBe('denied');
    expect(classifyLicense('NOASSERTION')).toBe('denied');
    expect(classifyLicense(undefined)).toBe('denied');
    expect(classifyLicense('   ')).toBe('denied');
  });

  it('宽松许可 allowed，含 copyleft 的表达式 needs-review', () => {
    expect(classifyLicense('MIT')).toBe('allowed');
    expect(classifyLicense('Apache 2.0')).toBe('allowed');
    expect(classifyLicense('MIT OR Apache-2.0')).toBe('allowed');
    expect(classifyLicense('MPL-2.0')).toBe('needs-review');
    expect(classifyLicense('MIT AND GPL-3.0-only')).toBe('needs-review');
  });

  it('表达式里出现被拒项时整体被拒', () => {
    expect(classifyLicense('MIT OR UNLICENSED')).toBe('denied');
  });
});

describe('QQ 插件闭包门禁（D11 验收：含 UNLICENSED 的包无法被打进离线包）', () => {
  const report = evaluateClosure('official-qqbot', OFFICIAL_QQBOT_ENTRY.depsClosure);

  it('命中 @tencent-connect/qqbot-connector@1.2.0 并判 denied', () => {
    expect(report.verdict).toBe('denied');
    const connector = report.denied.find((entry) => entry.name === '@tencent-connect/qqbot-connector');
    expect(connector?.version).toBe('1.2.0');
    expect(connector?.license).toBe('UNLICENSED');
    expect(connector?.redistributable).toBe(false);
  });

  it('其余 36 个包在允许列表内（闭包总量与前置验证 §5.2 的 37 一致）', () => {
    expect(report.entries).toHaveLength(37);
    expect(report.denied).toHaveLength(1);
    expect(report.needsReview).toHaveLength(0);
    expect(report.byLicense).toEqual(
      expect.arrayContaining([
        { license: 'MIT', count: 26 },
        { license: 'ISC', count: 8 },
        { license: 'Apache-2.0', count: 1 },
        { license: 'Python-2.0', count: 1 },
        { license: 'UNLICENSED', count: 1 },
      ]),
    );
  });

  it('分发门禁抛 E_LICENSE_BLOCKED，并点名包名与版本', () => {
    try {
      assertRedistributable(report);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(DdaError);
      const ddaError = error as DdaError;
      expect(ddaError.code).toBe(ERROR_CODES.E_LICENSE_BLOCKED);
      expect(ddaError.message).toContain('@tencent-connect/qqbot-connector@1.2.0');
      expect(ddaError.hint).toContain('在线安装');
    }
  });

  it('全允许闭包可以通过，且 NOTICE 片段不含被拒包', () => {
    const allowed = evaluateClosure('fixture', [
      { name: 'a', version: '1.0.0', license: 'MIT' },
      { name: 'b', version: '1.0.0', license: 'Apache 2.0' },
    ]);
    expect(allowed.verdict).toBe('allowed');
    expect(() => assertRedistributable(allowed)).not.toThrow();

    const notices = renderThirdPartyNotices(report);
    expect(notices).toContain('qrcode-terminal');
    expect(notices).not.toContain('qqbot-connector');
  });
});

describe('pnpm 输出解析与真实目录读取', () => {
  it('展平嵌套依赖并保留安装路径', () => {
    const raw = JSON.stringify([
      {
        name: 'root',
        dependencies: {
          '@tencent-connect/dsh-qqbot': {
            version: '0.5.5',
            path: 'C:\\profiles\\web\\node_modules\\@tencent-connect\\dsh-qqbot',
            dependencies: {
              '@tencent-connect/qqbot-connector': {
                version: '1.2.0',
                path: 'C:\\profiles\\web\\node_modules\\@tencent-connect\\qqbot-connector',
              },
            },
          },
        },
      },
    ]);
    const packages = parsePnpmListJson(raw);
    expect(packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      '@tencent-connect/dsh-qqbot@0.5.5',
      '@tencent-connect/qqbot-connector@1.2.0',
    ]);
    expect(packages[1]?.dir).toContain('qqbot-connector');
  });

  it('package.json 优先，其次 LICENSE 文件，两者都没有时返回 undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dda-license-'));

    const withField = join(root, 'with-field');
    await mkdir(withField, { recursive: true });
    await writeFile(join(withField, 'package.json'), JSON.stringify({ license: 'ISC' }), 'utf8');
    await expect(readLicenseFromDir(withField)).resolves.toEqual({ license: 'ISC', source: 'package.json' });

    const withFile = join(root, 'with-file');
    await mkdir(withFile, { recursive: true });
    await writeFile(join(withFile, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    await writeFile(join(withFile, 'LICENSE'), 'Apache License Version 2.0', 'utf8');
    await expect(readLicenseFromDir(withFile)).resolves.toEqual({
      license: 'Apache-2.0',
      source: 'LICENSE',
    });

    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, 'package.json'), JSON.stringify({ name: 'y' }), 'utf8');
    await expect(readLicenseFromDir(empty)).resolves.toEqual({ source: 'no-license' });

    const resolved = await resolveClosureLicenses([
      { name: 'with-field', version: '1.0.0', dir: withField },
      { name: 'empty', version: '1.0.0', dir: empty },
    ]);
    expect(classifyLicense(resolved[0]?.license)).toBe('allowed');
    expect(classifyLicense(resolved[1]?.license)).toBe('denied');
  });
});

describe('本产品闭包不回归（原 license-check 的行为保持）', () => {
  it('生产闭包从真实 node_modules 读许可后仍为 allowed', async () => {
    const raw = execFileSync(
      process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm',
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'pnpm list --prod --depth Infinity --json']
        : ['list', '--prod', '--depth', 'Infinity', '--json'],
      {
        cwd: join(__dirname, '..', '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const packages = parsePnpmListJson(raw);
    const report = evaluateClosure('product', await resolveClosureLicenses(packages));
    expect(packages.length).toBeGreaterThan(5);
    expect(report.denied).toEqual([]);
    expect(report.verdict).toBe('allowed');
  });
});
