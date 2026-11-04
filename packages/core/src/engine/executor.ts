import { readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import type { RollbackTarget, StepState, TaskEvent, TaskSummary } from '@dda/spec';

import { Journal } from './journal';
import type { JournalData } from './journal';
import type { Step, StepContext } from './plan';
import { totalWeight } from './plan';
import { classifyRollbackTargets } from './safety';

/**
 * Cooperative control channel. The engine only *observes* flags; it never kills processes
 * itself, so a cancelled task always goes through the same cleanup path as a rollback.
 */
export interface TaskControl {
  pauseRequested: boolean;
  cancelRequested: boolean;
  /** Aborted as soon as cancel is requested, so long transfers can stop early. */
  signal: AbortSignal;
}

export function createTaskControl(): { control: TaskControl; pause(): void; cancel(): void } {
  const controller = new AbortController();
  const control: TaskControl = { pauseRequested: false, cancelRequested: false, signal: controller.signal };
  return {
    control,
    pause: () => {
      control.pauseRequested = true;
    },
    cancel: () => {
      control.cancelRequested = true;
      controller.abort();
    },
  };
}

export interface ExecuteOptions {
  taskId: string;
  scenario: string;
  steps: Step[];
  journal: Journal;
  log: (message: string) => Promise<void> | void;
  onEvent?: (event: TaskEvent) => void;
  /** Resume an existing journal: steps already `succeeded`/`skipped` are not re-run. */
  resume?: boolean;
  control?: TaskControl;
}

export interface ExecuteResult {
  summary: TaskSummary;
  data: JournalData;
}

/**
 * Runs steps in order. Guarantees:
 *  - idempotent: `precondition` true -> `skipped`, safe to re-run
 *  - resumable: any interruption (failure / user pause) keeps completed steps
 *  - cancellable: user cancel stops at the next checkpoint and marks the task `cancelled`
 *  - honest status: `paused` only for a user pause, `failed` for a step error, so the UI can
 *    never present a broken deployment as "paused, you can continue"
 *  - rollback: only deletes paths recorded in `created[]` (never user data)
 */
export async function executePlan(options: ExecuteOptions): Promise<ExecuteResult> {
  const { taskId, scenario, steps, journal, log, control } = options;
  const weight = totalWeight(steps) || 1;

  const existing = options.resume ? await Journal.load(journal.filePath) : undefined;
  const data: JournalData =
    existing && existing.taskId === taskId
      ? {
          ...existing,
          // 计划可能因「复用系统运行时 / 私有运行时」而增减步骤；按 step.id 对齐，
          // 既不丢已完成进度，也不会因索引错位把进度记到别的步骤上。
          steps: steps.map<StepState>((s) => {
            const previous = existing.steps.find((p) => p.id === s.id);
            return previous ? { ...previous, title: s.title } : { id: s.id, title: s.title, status: 'pending', attempts: 0 };
          }),
        }
      : {
          taskId,
          scenario,
          status: 'pending',
          startedAt: new Date().toISOString(),
          steps: steps.map<StepState>((s) => ({ id: s.id, title: s.title, status: 'pending', attempts: 0 })),
          created: [],
        };

  data.status = 'running';
  data.pausedByUser = undefined;
  data.error = undefined;
  await journal.save(data);

  let completedWeight = 0;
  const finish = async (
    status: TaskSummary['status'],
    extra: { error?: string; pausedByUser?: boolean } = {},
  ): Promise<ExecuteResult> => {
    data.status = status;
    data.finishedAt = new Date().toISOString();
    if (extra.error !== undefined) data.error = extra.error;
    if (extra.pausedByUser !== undefined) data.pausedByUser = extra.pausedByUser;
    await journal.save(data);
    return { summary: journal.toSummary(data), data };
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const state = data.steps[index]!;

    if (state.status === 'succeeded' || state.status === 'skipped') {
      completedWeight += step.weight;
      continue;
    }

    // Checkpoint between steps: cancel wins over pause.
    if (control?.cancelRequested) {
      state.status = 'cancelled';
      state.finishedAt = new Date().toISOString();
      state.message = '用户取消';
      options.onEvent?.({ taskId, stepId: step.id, status: 'cancelled', progress: completedWeight / weight, message: '用户取消' });
      return finish('cancelled', { error: '用户取消任务' });
    }
    if (control?.pauseRequested) {
      return finish('paused', { pausedByUser: true });
    }

    state.status = 'running';
    state.attempts += 1;
    state.startedAt = new Date().toISOString();
    state.message = undefined;
    await journal.save(data);
    options.onEvent?.({
      taskId,
      stepId: step.id,
      status: 'running',
      progress: completedWeight / weight,
      message: step.title,
    });

    const ctx: StepContext = {
      progress: (fraction) => {
        const p = (completedWeight + step.weight * Math.min(Math.max(fraction, 0), 1)) / weight;
        options.onEvent?.({ taskId, stepId: step.id, status: 'running', progress: p, message: step.title });
      },
      created: (path) => {
        if (!data.created.includes(path)) data.created.push(path);
      },
      log: (message) => void log(`[${step.id}] ${message}`),
      signal: control?.signal ?? new AbortController().signal,
      isCancelled: () => Boolean(control?.cancelRequested),
    };

    try {
      if (step.precondition && (await step.precondition(ctx))) {
        state.status = 'skipped';
        state.message = '已是目标状态，跳过';
        state.finishedAt = new Date().toISOString();
        completedWeight += step.weight;
        await journal.save(data);
        options.onEvent?.({
          taskId,
          stepId: step.id,
          status: 'skipped',
          progress: completedWeight / weight,
          message: state.message,
        });
        continue;
      }

      const attempts = Math.max(1, step.retries ?? 1);
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await step.run(ctx);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (control?.cancelRequested) break;
          await log(`[${step.id}] 第 ${attempt}/${attempts} 次失败: ${String(error)}`);
          if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }

      if (control?.cancelRequested) {
        state.status = 'cancelled';
        state.finishedAt = new Date().toISOString();
        state.message = '用户取消';
        options.onEvent?.({
          taskId,
          stepId: step.id,
          status: 'cancelled',
          progress: completedWeight / weight,
          message: '用户取消',
        });
        return finish('cancelled', { error: '用户取消任务' });
      }

      if (lastError) throw lastError;

      state.status = 'succeeded';
      state.finishedAt = new Date().toISOString();
      completedWeight += step.weight;
      await journal.save(data);
      options.onEvent?.({
        taskId,
        stepId: step.id,
        status: 'succeeded',
        progress: completedWeight / weight,
        message: step.title,
      });
    } catch (error) {
      state.status = 'failed';
      state.message = error instanceof Error ? error.message : String(error);
      state.finishedAt = new Date().toISOString();
      options.onEvent?.({
        taskId,
        stepId: step.id,
        status: 'failed',
        progress: completedWeight / weight,
        message: state.message,
      });
      // A step error is a failure, not a pause: only a user pause may report `paused`, otherwise
      // the UI would show "已暂停（可继续）" for a task that actually needs attention.
      return finish('failed', { error: state.message, pausedByUser: false });
    }
  }

  return finish('succeeded');
}

/**
 * Delete only paths that this task created (reverse order, tolerate already-missing).
 * Used by both "rollback" and "cancel with cleanup" — never touches user data.
 *
 * With `allowedRoots` every journal path is verified first (see `classifyRollbackTargets`);
 * anything that cannot be attributed to a managed folder is refused instead of deleted.
 * With `pruneAbove`, directories left empty by the deletion are pruned, but never above it.
 */
export interface RollbackOptions {
  pruneAbove?: string;
  allowedRoots?: string[];
}

export interface RollbackOutcome {
  deleted: string[];
  refused: RollbackTarget[];
}

export async function rollbackPlan(
  data: JournalData,
  steps: Step[],
  log: (m: string) => void,
  options: RollbackOptions = {},
): Promise<RollbackOutcome> {
  for (const step of [...steps].reverse()) {
    if (!step.rollback) continue;
    const ctx: StepContext = {
      progress: () => undefined,
      created: () => undefined,
      log: (m) => log(`[rollback:${step.id}] ${m}`),
      signal: new AbortController().signal,
      isCancelled: () => false,
    };
    try {
      await step.rollback(ctx);
    } catch (error) {
      log(`[rollback:${step.id}] 失败: ${String(error)}`);
    }
  }

  const targets: RollbackTarget[] = options.allowedRoots?.length
    ? await classifyRollbackTargets(data.created, { roots: options.allowedRoots })
    : data.created.map((path) => ({ path, exists: true, deletable: true }));

  const deleted: string[] = [];
  const refused: RollbackTarget[] = [];
  for (const target of targets) {
    if (!target.deletable) {
      refused.push(target);
      log(`[rollback] 拒绝删除 ${target.path}: ${target.reason ?? '无法确认归属'}`);
      continue;
    }
    if (!target.exists) continue;
    try {
      await rm(target.path, { recursive: true, force: true });
      deleted.push(target.path);
    } catch (error) {
      refused.push({ ...target, deletable: false, reason: String(error) });
      log(`[rollback] 无法删除 ${target.path}: ${String(error)}`);
    }
    if (options.pruneAbove) await pruneEmptyParents(target.path, options.pruneAbove);
  }
  data.status = 'rolled-back';
  data.finishedAt = new Date().toISOString();
  return { deleted, refused };
}

/** Removes directories that our own deletion emptied; stops at the first non-empty parent. */
async function pruneEmptyParents(target: string, root: string): Promise<void> {
  const stop = resolve(root);
  let current = dirname(resolve(target));
  while (current !== stop && current.startsWith(stop + sep)) {
    try {
      if ((await readdir(current)).length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
