import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createTaskControl, executePlan, Journal, rollbackPlan } from '@dda/core';
import type { TaskEvent, TaskSummary } from '@dda/spec';
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

  constructor(private readonly deps: DeployServiceDeps) {}

  get taskId(): string {
    return `${SCENARIO}-${BASELINE.dsh.version.replace(/\./g, '_')}`;
  }

  get isRunning(): boolean {
    return this.running !== undefined;
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
  start(options: { fresh?: boolean } = {}): { taskId: string } {
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
  async cancel(cleanup: boolean): Promise<CancelResult> {
    const wasRunning = this.isRunning;
    this.controlHandle?.cancel();
    await this.waitForIdle();

    if (!cleanup) {
      return { summary: await this.summary(), cleaned: [], cleanupSkipped: true };
    }

    const journal = new Journal(this.journalPath());
    const data = await Journal.load(this.journalPath());
    if (!data) return { cleaned: [], cleanupSkipped: true };

    const cleaned = [...data.created];
    await rollbackPlan(data, this.plan(), (m) => void this.deps.container.logger.warn('cancel-cleanup', m), this.deps.container.paths.root);
    await journal.save(data);
    await this.deps.container.logger.info(
      'deploy',
      `cancelled (wasRunning=${wasRunning}); cleaned ${cleaned.length} path(s) created by this task`,
    );
    return { summary: journal.toSummary(data), cleaned, cleanupSkipped: false };
  }

  async waitForIdle(): Promise<TaskSummary | undefined> {
    if (this.running) await this.running;
    return this.summary();
  }

  async rollback(): Promise<TaskSummary> {
    const { container } = this.deps;
    const journal = new Journal(this.journalPath());
    const data = await Journal.load(this.journalPath());
    if (!data) {
      return {
        taskId: this.taskId,
        status: 'failed',
        steps: [],
        startedAt: new Date().toISOString(),
        error: '没有可回滚的任务',
      };
    }
    await rollbackPlan(data, this.plan(), (m) => void container.logger.info('rollback', m), container.paths.root);
    await journal.save(data);
    return journal.toSummary(data);
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
