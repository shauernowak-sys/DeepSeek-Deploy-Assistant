import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStorage } from 'electron';

import { writeFileAtomic } from '@dda/core';

/**
 * Secrets never leave the main process: only ciphertext touches disk and only a mask
 * ever travels over IPC. DPAPI is per-user, so a copied file is useless on another account.
 *
 * Writes go through `writeFileAtomic`, so a crash mid-write can never truncate the file that
 * still holds the user's credentials. The read-modify-write cycles are serialised too: two
 * concurrent saves of different keys used to each build their map from the same stale snapshot,
 * and the later one silently dropped the other's credential.
 */
export class Secrets {
  constructor(private readonly root: string) {}

  /** Tail of the read-modify-write chain. Reads take consistent snapshots, so they skip it. */
  private queue: Promise<unknown> = Promise.resolve();

  private get file(): string {
    return join(this.root, 'secrets.bin');
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    // Chain regardless of the previous outcome: one failed save must not wedge every later one.
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAll(): Promise<{ all: Record<string, string>; unreadable: boolean }> {
    try {
      return { all: JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>, unreadable: false };
    } catch (error) {
      return { all: {}, unreadable: (error as NodeJS.ErrnoException).code !== 'ENOENT' };
    }
  }

  private async writeAll(all: Record<string, string>, unreadable: boolean): Promise<void> {
    if (unreadable) {
      // Keep the unreadable ciphertext instead of silently discarding unknown credentials.
      // If the copy cannot be made we refuse the write: the alternative is losing them for good.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await copyFile(this.file, `${this.file}.corrupt-${stamp}`).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code ?? String(error);
        throw new Error(`密钥文件无法解析，且备份失败（${code}），已中止写入以保留原始数据`);
      });
    }
    await writeFileAtomic(this.file, JSON.stringify(all));
  }

  async set(key: string, value: string): Promise<{ masked: string }> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用（DPAPI）');
    const encrypted = safeStorage.encryptString(value).toString('base64');
    return this.exclusive(async () => {
      const { all, unreadable } = await this.readAll();
      all[key] = encrypted;
      await this.writeAll(all, unreadable);
      return { masked: mask(value) };
    });
  }

  async get(key: string): Promise<string | undefined> {
    const { all } = await this.readAll();
    const blob = all[key];
    if (!blob) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return undefined;
    }
  }

  async masked(key: string): Promise<string | undefined> {
    const value = await this.get(key);
    return value ? mask(value) : undefined;
  }

  /** Removes a stored secret (used when the user deletes the provider configuration). */
  async remove(key: string): Promise<void> {
    await this.exclusive(async () => {
      const { all, unreadable } = await this.readAll();
      if (!(key in all)) return;
      delete all[key];
      await this.writeAll(all, unreadable);
    });
  }
}

export function mask(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
