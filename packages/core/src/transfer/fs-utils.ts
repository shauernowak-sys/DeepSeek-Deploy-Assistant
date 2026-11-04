import { randomUUID } from 'node:crypto';
import { access, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function fileExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Windows transiently reports these while an antivirus scanner or another reader holds a file. */
const LOCKED_CODES = ['EPERM', 'EACCES', 'EBUSY'];

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function withRetry<T>(operation: () => Promise<T>, extraCodes: string[] = [], attempts = 7): Promise<T> {
  const retryable = new Set([...LOCKED_CODES, ...extraCodes]);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!retryable.has(code) || attempt >= attempts) throw error;
      await sleep(25 * attempt);
    }
  }
}

/** Flushes the rename itself. Windows cannot open a directory for fsync, so this is POSIX-only. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is a durability optimisation, never a reason to fail an otherwise good write.
  }
}

/** Tail of the per-path write chain. Serialising writers is what keeps two saves from swapping bytes. */
const writeChains = new Map<string, Promise<void>>();

/**
 * Write-through-rename: readers (and a crash) see either the old file or the new one, never a
 * half-written mix. `fsync` runs before the rename so the new bytes are on disk first.
 *
 * Three properties are required and easy to lose:
 *  - the temp name must be unique per write, otherwise two writers share one file and the winner
 *    of the rename publishes the *other* writer's bytes;
 *  - writes to the same path must be serialised, because "unique temp + rename" alone still lets
 *    a later `rename` replace an earlier one in an order the callers never asked for;
 *  - open/write/fsync need the same Windows retry treatment as rename, since antivirus software
 *    locks the freshly created temp file just as readily as the target.
 */
export function writeFileAtomic(path: string, data: string, encoding: BufferEncoding = 'utf8'): Promise<void> {
  const key = resolve(path);
  const previous = writeChains.get(key) ?? Promise.resolve();
  // Run regardless of whether the previous writer succeeded: one failed save must not wedge the file.
  const run = previous.then(
    () => writeFileAtomicNow(path, data, encoding),
    () => writeFileAtomicNow(path, data, encoding),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(key, tail);
  void tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  });
  return run;
}

async function writeFileAtomicNow(path: string, data: string, encoding: BufferEncoding): Promise<void> {
  await withRetry(() => mkdir(dirname(path), { recursive: true }));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await withRetry(async () => {
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(data, encoding);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await withRetry(() => rename(tmp, path), ['EEXIST']);
    await syncDirectory(dirname(path));
  } catch (error) {
    // Never leave our own temp file behind; the target still holds the previous content.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
