import { readFile } from 'node:fs/promises';

import type { StepState, TaskSummary } from '@dda/spec';

import { writeFileAtomic } from '../transfer/fs-utils';

export interface JournalData {
  taskId: string;
  scenario: string;
  status: TaskSummary['status'];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** true when the last pause/cancel was requested by the user (not a failure). */
  pausedByUser?: boolean;
  /**
   * 为什么会停在 `paused`。`user` = 用户点暂停；`step-retry` = 单步重试成功后按设计停在
   * 后续步骤之前。两者都不算失败，但文案必须不同（不能把"重试成功"说成"你暂停了"）。
   */
  pausedReason?: 'user' | 'step-retry';
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
   * Atomic write through the shared `writeFileAtomic`: unique temp name, fsync before rename and
   * per-path serialisation. A private copy of that logic previously gave the journal a fixed
   * `<file>.tmp`, so two saves could publish each other's content.
   */
  async save(data: JournalData): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(data, null, 2));
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
      pausedReason: data.pausedReason,
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
