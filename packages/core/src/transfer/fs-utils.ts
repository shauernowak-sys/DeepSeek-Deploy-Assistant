import { access, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function fileExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write-through-rename: readers (and a crash) see either the old file or the new one, never a
 * half-written mix. `fsync` runs before the rename so the new bytes are on disk first.
 *
 * Windows can transiently refuse the rename while an antivirus scanner or another reader holds
 * the target open, so retry briefly; on final failure the temp file is removed and the original
 * file is left untouched.
 */
export async function writeFileAtomic(path: string, data: string, encoding: BufferEncoding = 'utf8'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;

  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data, encoding);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const retryable = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!retryable.has(code) || attempt >= 6) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}