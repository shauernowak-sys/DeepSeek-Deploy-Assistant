import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStorage } from 'electron';

/**
 * Secrets never leave the main process: only ciphertext touches disk and only a mask
 * ever travels over IPC. DPAPI is per-user, so a copied file is useless on another account.
 */
export class Secrets {
  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'secrets.bin');
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async set(key: string, value: string): Promise<{ masked: string }> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用（DPAPI）');
    const all = await this.readAll();
    all[key] = safeStorage.encryptString(value).toString('base64');
    await mkdir(this.root, { recursive: true });
    await writeFile(this.file, JSON.stringify(all), 'utf8');
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
}

export function mask(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
