import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { StepState, TaskSummary } from '@dda/spec';

export interface JournalData {
  taskId: string;
  scenario: string;
  status: TaskSummary['status'];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** true when the last pause/cancel was requested by the user (not a failure). */
  pausedByUser?: boolean;
  steps: StepState[];
  /** Everything created by this task, so rollback only removes our own artifacts. */
  created: string[];
}

export class Journal {
  constructor(readonly filePath: string) {}

  static async load(filePath: string): Promise<JournalData | undefined> {
    try {
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw) as JournalData;
    } catch {
      return undefined;
    }
  }

  /**
   * Atomic write: temp file + rename, so a crash never leaves a half-written journal.
   * Windows can transiently reject the rename while another process (antivirus, a reader,
   * the diagnostic exporter) holds the target open, so retry briefly before giving up.
   */
  async save(data: JournalData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');

    const retryable = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(tmp, this.filePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!retryable.has(code) || attempt >= 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }

  toSummary(data: JournalData): TaskSummary {
    return {
      taskId: data.taskId,
      status: data.status,
      steps: data.steps,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      error: data.error,
      pausedByUser: data.pausedByUser,
    };
  }
}

/** Stable task id from scenario + target versions: re-running the same target hits the same task. */
export function deriveTaskId(scenario: string, versions: Record<string, string>): string {
  const material = `${scenario}|${Object.keys(versions)
    .sort()
    .map((k) => `${k}=${versions[k]}`)
    .join(',')}`;
  let hash = 0;
  for (let i = 0; i < material.length; i += 1) {
    hash = (hash * 31 + material.charCodeAt(i)) >>> 0;
  }
  return `${scenario}-${hash.toString(16)}`;
}
