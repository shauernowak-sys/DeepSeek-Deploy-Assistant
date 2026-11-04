import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createTaskControl, executePlan, Journal, rollbackPlan, classifyRollbackTargets } from '@dda/core';
import type { RollbackPreview, RollbackResult, TaskEvent, TaskSummary } from '@dda/spec';
import { BASELINE } from '@dda/spec';

import type { Container } from './container';
import { buildDeploySteps, QQ_PLUGIN_SPEC } from './deploy-plan';

export { QQ_PLUGIN_SPEC };
const SCENARIO = 'full-deploy';

export interface DeployServiceDeps {
  container: Container;
  onEvent: (event: TaskEvent) => void;
}

export interface CancelResult {
  summary?: TaskSummary;
  /** Absolute paths that were removed (only paths this task created). */
  cleaned: string[];
  cleanupSkipped: boolean;
}

export class DeployService {
  private running?: Promise<TaskSummary>;
  private controlHandle?: ReturnType<typeof createTaskControl>;
  /** Tail of the lifecycle chain: start / cancel / rollback must never interleave. */
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DeployServiceDeps) {}

  get taskId(): string {
    return `${SCENARIO}-${BASELINE.dsh.version.replace(/\./g, '_')}`;
  }

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  /**
   * Serialises the three operations that inspect then mutate the same journal and the same files.
   * Without it, a `rollback` that had already passed its `isRunning` check could resume after a
   * `start` and delete the artifacts the new run had just created.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(operation, operation);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  journalPath(): string {
    return join(this.deps.container.paths.stateTasks, `${this.taskId}.json`);
  }

  /** Moves the previous journal aside so a fresh run re-executes every step. */
  private retireJournal(): void {
    const file = this.journalPath();
    if (!existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      renameSync(file, join(dirname(file), `${this.taskId}.${stamp}.history.json`));
    } catch (error) {
      void this.deps.container.logger.warn('deploy', `旧任务记录无法归档: ${String(error)}`);
    }
  }

  async summary(): Promise<TaskSummary | undefined> {
    const data = await Journal.load(this.journalPath());
    if (!data) return undefined;
    return new Journal(this.journalPath()).toSummary(data);
  }

  /** Paths a cancel-with-cleanup would delete. Shown in the confirmation dialog. */
  async cleanupPreview(): Promise<{ paths: string[]; existing: string[]; count: number }> {
    const data = await Journal.load(this.journalPath());
    const paths = data?.created ?? [];
    return { paths, existing: paths.filter((p) => existsSync(p)), count: paths.length };
  }

  /**
   * Starts (or resumes) the plan in the background; progress arrives through `onEvent`.
   * `fresh` retires the current journal first so an already successful deployment is
   * re-verified step by step instead of being skipped as "nothing to do".
   */
  start(options: { fresh?: boolean } = {}): Promise<{ taskId: string }> {
    return this.serialize(async () => {
      if (!this.running) {
        if (options.fresh) this.retireJournal();
        this.controlHandle = createTaskControl();
        const handle = this.controlHandle;
        this.running = this.execute(handle.control)
          .catch((error: unknown) => this.failUnexpected(error))
          .finally(() => {
            this.running = undefined;
            this.controlHandle = undefined;
          });
      }
      return { taskId: this.taskId };
    });
  }

  /**
   * A journal left at `running` means the previous process died mid-step. Nothing is running
   * now, so that stored status is a lie: the UI would disable both "deploy" and "rollback"
   * forever and a click on "pause" would report a pause that never happened.
   */
  async reconcileInterrupted(): Promise<void> {
    if (this.isRunning) return;
    const data = await Journal.load(this.journalPath());
    if (!data || data.status !== 'running') return;

    const interrupted = data.steps.find((step) => step.status === 'running');
    if (interrupted) {
      interrupted.status = 'failed';
      interrupted.message = '上次运行被中断';
      interrupted.finishedAt = new Date().toISOString();
    }
    data.status = 'failed';
    data.error = '上次运行未正常结束（应用被关闭或崩溃）。已完成的步骤会保留，可直接重试。';
    data.pausedByUser = false;
    data.finishedAt = new Date().toISOString();
    await new Journal(this.journalPath()).save(data);
    await this.deps.container.logger.warn('deploy', '检测到上次运行被中断，已把任务状态修正为 failed');
  }

  /**
   * An unexpected engine error (e.g. the journal could not be written) must never leave the
   * task stuck at `running` with an unhandled rejection: record it and tell the UI.
   */
  private async failUnexpected(error: unknown): Promise<TaskSummary> {
    const { container } = this.deps;
    const message = error instanceof Error ? error.message : String(error);
    await container.logger.error('deploy', `任务异常终止: ${message}`);

    const journal = new Journal(this.journalPath());
    const data = await Journal.load(this.journalPath());
    if (data) {
      data.status = 'failed';
      data.error = message;
      data.finishedAt = new Date().toISOString();
      await journal.save(data).catch(() => undefined);
    }
    return (
      (data && journal.toSummary(data)) ?? {
        taskId: this.taskId,
        status: 'failed',
        steps: [],
        startedAt: new Date().toISOString(),
        error: message,
      }
    );
  }

  /** Cooperative pause: takes effect at the next step boundary (never mid-write). */
  async pause(): Promise<TaskSummary | undefined> {
    this.controlHandle?.pause();
    await this.waitForIdle();
    return this.summary();
  }

  /**
   * Cancel + optional cleanup. Cleanup deletes ONLY paths recorded in this task's journal,
   * so user-installed Harness/profile/config outside this task are untouched.
   */
  cancel(cleanup: boolean): Promise<CancelResult> {
    return this.serialize(() => this.cancelNow(cleanup));
  }

  private async cancelNow(cleanup: boolean): Promise<CancelResult> {
    const wasRunning = this.isRunning;
    this.controlHandle?.cancel();
    await this.waitForIdle();

    if (!cleanup) {
      return { summary: await this.summary(), cleaned: [], cleanupSkipped: true };
    }

    const journal = new Journal(this.journalPath());
    const data = await Journal.load(this.journalPath());
    if (!data) return { cleaned: [], cleanupSkipped: true };

    const cleaned: string[] = [];
    const outcome = await rollbackPlan(data, this.plan(), (m) => void this.deps.container.logger.warn('cancel-cleanup', m), {
      pruneAbove: this.deps.container.paths.root,
      allowedRoots: [this.deps.container.paths.root],
    });
    cleaned.push(...outcome.deleted);
    await journal.save(data);
    await this.deps.container.logger.info(
      'deploy',
      `cancelled (wasRunning=${wasRunning}); cleaned ${cleaned.length} path(s) created by this task, refused ${outcome.refused.length}`,
    );
    return { summary: journal.toSummary(data), cleaned, cleanupSkipped: false };
  }

  async waitForIdle(): Promise<TaskSummary | undefined> {
    if (this.running) await this.running;
    return this.summary();
  }

  /**
   * Read-only half of the rollback dialog: what a confirmed rollback would delete, and which
   * recorded paths are refused because they cannot be attributed to a managed folder.
   */
  async rollbackPreview(): Promise<RollbackPreview> {
    const roots = [this.deps.container.paths.root];
    const data = await Journal.load(this.journalPath());
    const created = data?.created ?? [];
    const entries = created.length > 0 ? await classifyRollbackTargets(created, { roots }) : [];
    return {
      taskId: this.taskId,
      entries,
      deletableCount: entries.filter((e) => e.exists && e.deletable).length,
      existingCount: entries.filter((e) => e.exists).length,
      roots,
    };
  }

  /**
   * Destructive: deletes the paths this task recorded. Requires `confirmed` so a stray click or
   * a renderer bug can never trigger it, and every path is re-verified against the managed root.
   */
  rollback(confirmed: boolean): Promise<RollbackResult> {
    return this.serialize(() => this.rollbackNow(confirmed));
  }

  private async rollbackNow(confirmed: boolean): Promise<RollbackResult> {
    const { container } = this.deps;
    const empty: RollbackResult = { ok: false, message: '', deleted: [], refused: [] };

    if (!confirmed) {
      return { ...empty, message: '回滚需要二次确认，未删除任何文件' };
    }
    if (this.isRunning) {
      return { ...empty, message: '任务正在运行，请先取消部署再回滚' };
    }

    const journal = new Journal(this.journalPath());
    const data = await Journal.load(this.journalPath());
    if (!data) {
      return { ...empty, message: '没有可回滚的任务记录' };
    }

    const outcome = await rollbackPlan(data, this.plan(), (m) => void container.logger.info('rollback', m), {
      pruneAbove: container.paths.root,
      allowedRoots: [container.paths.root],
    });
    await journal.save(data);

    const refusedNote =
      outcome.refused.length > 0 ? `；有 ${outcome.refused.length} 个路径无法确认归属，已保留未删除` : '';
    return {
      ok: outcome.refused.length === 0,
      message:
        outcome.deleted.length === 0
          ? `没有需要删除的内容${refusedNote}`
          : `已删除本次任务创建的 ${outcome.deleted.length} 个路径${refusedNote}`,
      summary: journal.toSummary(data),
      deleted: outcome.deleted,
      refused: outcome.refused,
    };
  }

  private plan() {
    const { container } = this.deps;
    return buildDeploySteps({
      paths: container.paths,
      manifest: container.nodeManifest,
      matrix: container.matrix,
      registry: container.registry,
      log: (m) => void container.logger.info('deploy', m),
    });
  }

  private async execute(control: ReturnType<typeof createTaskControl>['control']): Promise<TaskSummary> {
    const { container } = this.deps;
    const journal = new Journal(this.journalPath());
    const result = await executePlan({
      taskId: this.taskId,
      scenario: SCENARIO,
      steps: this.plan(),
      journal,
      resume: true,
      control,
      log: (m) => container.logger.info('deploy', m),
      onEvent: this.deps.onEvent,
    });
    return result.summary;
  }
}
