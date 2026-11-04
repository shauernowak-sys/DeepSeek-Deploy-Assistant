import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

/**
 * `safeStorage` is the only Electron API involved; the fake keeps the "ciphertext only on disk"
 * property observable. Two independent keys must survive concurrent saves — the previous
 * read-modify-write cycle rebuilt the whole map from one shared stale snapshot, so the later
 * writer silently dropped the earlier credential.
 */
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  },
}));

const { Secrets } = await import('../../apps/desktop/src/main/security/secrets');

async function fixture(): Promise<{ dir: string; secrets: InstanceType<typeof Secrets> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dda-secrets-concurrent-'));
  return { dir, secrets: new Secrets(dir) };
}

describe('Secrets：并发更新不丢键', () => {
  it('并发 set 不同 key 时全部保留', async () => {
    const { secrets } = await fixture();
    const keys = Array.from({ length: 8 }, (_, index) => `key-${index}`);

    await Promise.all(keys.map((key) => secrets.set(key, `value-${key}`)));

    const stored = await Promise.all(keys.map((key) => secrets.get(key)));
    expect(stored).toEqual(keys.map((key) => `value-${key}`));
  });

  it('并发 set / remove 之后磁盘上仍是可解析的密文表，且无临时文件残留', async () => {
    const { dir, secrets } = await fixture();
    await secrets.set('keep', 'kept');
    await secrets.set('drop', 'dropped');

    await Promise.all([
      secrets.set('added-1', 'a'),
      secrets.remove('drop'),
      secrets.set('added-2', 'b'),
    ]);

    expect(await secrets.get('keep')).toBe('kept');
    expect(await secrets.get('drop')).toBeUndefined();
    expect(await secrets.get('added-1')).toBe('a');
    expect(await secrets.get('added-2')).toBe('b');

    const raw = JSON.parse(await readFile(join(dir, 'secrets.bin'), 'utf8')) as Record<string, string>;
    expect(Object.keys(raw)).not.toContain('drop');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('写入失败后队列不会卡死，后续写入仍会成功', async () => {
    const { dir, secrets } = await fixture();
    await secrets.set('first', 'v1');

    // Make the replacement of secrets.bin fail: Windows refuses a read-only target, POSIX lets
    // the containing directory decide.
    const { chmod, stat } = await import('node:fs/promises');
    const file = join(dir, 'secrets.bin');
    let restore: () => Promise<void>;
    if (process.platform === 'win32') {
      await chmod(file, 0o444);
      restore = () => chmod(file, 0o666);
    } else {
      const dirMode = (await stat(dir)).mode;
      await chmod(dir, 0o555);
      restore = () => chmod(dir, dirMode);
    }

    try {
      await expect(secrets.set('blocked', 'v2')).rejects.toThrow();
    } finally {
      await restore();
    }

    await expect(secrets.set('third', 'v3')).resolves.toMatchObject({ masked: expect.any(String) });
    expect(await secrets.get('third')).toBe('v3');
    expect(await secrets.get('first')).toBe('v1');
  });
});
