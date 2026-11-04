import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { writeFileAtomic } from '@dda/core';

/**
 * `safeStorage` is the only Electron API involved; the fake keeps the "ciphertext only on disk"
 * property observable and makes the atomic-write behaviour testable outside Electron.
 */
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  },
}));

/**
 * Makes every replacement of `file` fail, without touching its content.
 *
 * The previous trick — putting a directory at `<file>.tmp` — only worked while the temp name was
 * fixed. With per-write unique temp names it became a silent no-op, so fail at the rename instead:
 * Windows refuses to replace a read-only target, while POSIX ignores the file's own mode and lets
 * the containing directory decide.
 */
async function denyReplacing(file: string): Promise<() => Promise<void>> {
  if (process.platform === 'win32') {
    await chmod(file, 0o444);
    return () => chmod(file, 0o666);
  }
  const dir = dirname(file);
  const before = (await stat(dir)).mode;
  await chmod(dir, 0o555);
  return () => chmod(dir, before);
}

const { Secrets } = await import('../../apps/desktop/src/main/security/secrets');

const KEY = 'sk-secrets-atomic-test-000111222333';

async function fixture(): Promise<{ dir: string; secrets: InstanceType<typeof Secrets> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-secrets-'));
  return { dir, secrets: new Secrets(dir) };
}

describe('敏感数据写入可靠性', () => {
  let dir: string;
  let secrets: InstanceType<typeof Secrets>;

  beforeEach(async () => {
    ({ dir, secrets } = await fixture());
  });

  it('写入后磁盘上只有密文，且不残留临时文件', async () => {
    await secrets.set('api.credential', KEY);
    const raw = await readFile(join(dir, 'secrets.bin'), 'utf8');

    expect(raw).not.toContain(KEY);
    const stored = (JSON.parse(raw) as Record<string, string>)['api.credential']!;
    expect(Buffer.from(stored, 'base64').toString('utf8')).toBe(`enc:${KEY}`);
    expect(await secrets.get('api.credential')).toBe(KEY);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('写入失败时不破坏已有凭证', async () => {
    await secrets.set('api.credential', KEY);
    const before = await readFile(join(dir, 'secrets.bin'), 'utf8');

    // Make the replacement of secrets.bin fail: the write must fail instead of truncating the store.
    const restore = await denyReplacing(join(dir, 'secrets.bin'));
    try {
      await expect(secrets.set('other.key', 'new-value')).rejects.toThrow();
    } finally {
      await restore();
    }

    expect(await readFile(join(dir, 'secrets.bin'), 'utf8')).toBe(before);
    expect(await secrets.get('api.credential')).toBe(KEY);
  });

  it('多份密钥互不覆盖', async () => {
    await secrets.set('a', 'value-a');
    await secrets.set('b', 'value-b');
    expect(await secrets.get('a')).toBe('value-a');
    expect(await secrets.get('b')).toBe('value-b');

    await secrets.remove('a');
    expect(await secrets.get('a')).toBeUndefined();
    expect(await secrets.get('b')).toBe('value-b');
  });

  it('文件损坏时保留原始密文副本，不静默丢弃', async () => {
    await writeFile(join(dir, 'secrets.bin'), 'not-json{', 'utf8');
    await secrets.set('fresh', 'value');

    const names = await readdir(dir);
    const preserved = names.filter((name) => name.startsWith('secrets.bin.corrupt-'));
    expect(preserved).toHaveLength(1);
    expect(await readFile(join(dir, preserved[0]!), 'utf8')).toBe('not-json{');
    expect(await secrets.get('fresh')).toBe('value');
  });

  it('损坏文件之后仍可正常读写（不会反复报错）', async () => {
    await writeFile(join(dir, 'secrets.bin'), '{', 'utf8');
    await secrets.set('a', 'v1');
    await secrets.set('b', 'v2');
    expect(await secrets.get('a')).toBe('v1');
    expect(await secrets.get('b')).toBe('v2');
  });
});

describe('writeFileAtomic', () => {
  it('成功后替换内容且不留下临时文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-atomic-'));
    const file = join(dir, 'config.json');

    await writeFileAtomic(file, '{"v":1}');
    await writeFileAtomic(file, '{"v":2}');

    expect(await readFile(file, 'utf8')).toBe('{"v":2}');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('写入失败时保持旧文件内容不变，且不残留临时文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-atomic-'));
    const file = join(dir, 'config.json');
    await writeFileAtomic(file, '{"v":1}');

    const restore = await denyReplacing(file);
    try {
      await expect(writeFileAtomic(file, '{"v":2}')).rejects.toThrow();
    } finally {
      await restore();
    }

    expect(await readFile(file, 'utf8')).toBe('{"v":1}');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
