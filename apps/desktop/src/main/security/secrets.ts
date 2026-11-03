import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStorage } from 'electron';

import { writeFileAtomic } from '@dda/core';

/**
 * Secrets never leave the main process: only ciphertext touches disk and only a mask
 * ever travels over IPC. DPAPI is per-user, so a copied file is useless on another account.
 *
 * Writes go through a temp file + rename, so a crash mid-write can never truncate the file that
 * still holds the user's credentials.
 */
export class Secrets {
  constructor(private readonly root: string) {}

  /** Set when the stored file exists but could not be parsed: preserved before the next overwrite. */
  private unreadable = false;

  private get file(): string {
    return join(this.root, 'secrets.bin');
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch (error) {
      this.unreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      return {};
    }
  }

  private async writeAll(all: Record<string, string>): Promise<void> {
    if (this.unreadable) {
      // Keep the unreadable ciphertext instead of silently discarding unknown credentials.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await copyFile(this.file, `${this.file}.corrupt-${stamp}`).catch(() => undefined);
      this.unreadable = false;
    }
    await writeFileAtomic(this.file, JSON.stringify(all));
  }

  async set(key: string, value: string): Promise<{ masked: string }> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用（DPAPI）');
    const all = await this.readAll();
    all[key] = safeStorage.encryptString(value).toString('base64');
    await this.writeAll(all);
    return { masked: mask(value) };
  }

  async get(key: string): Promise<string | undefined> {
    const all = await this.readAll();
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
    const all = await this.readAll();
    if (!(key in all)) return;
    delete all[key];
    await this.writeAll(all);
  }
}

export function mask(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}