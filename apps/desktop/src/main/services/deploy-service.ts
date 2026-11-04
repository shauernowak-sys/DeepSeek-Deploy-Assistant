import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createTaskControl, executePlan, Journal, rollbackPlan, classifyRollbackTargets } from '@dda/core';
import { loadRuntimeSelection, saveRuntimeSelection, loadDeploymentQqMode } from '@dda/adapters';
import {
  DdaError,
  ERROR_CODES,
  type DeploymentDecisionAuthorization,
  type RollbackPreview,
  type RollbackResult,
  type RuntimeSelection,
  type TaskEvent,
  type TaskSummary,
} from '@dda/spec';
import { BASELINE } from '@dda/spec';

import type { Container } from './container';
import { buildDeploySteps, QQ_PLUGIN_SPEC } from './deploy-plan';

export { QQ_PLUGIN_SPEC };
const SCENARIO = 'full-deploy';

export interface DeployServiceDeps {
  container: Container;
  onEvent: (event: TaskEvent) => void;
  /**
   * 决策门禁。必须由 EnvService.authorize 提供；UI 不可能绕过它直接调用执行器。
   * 测试可注入固定实现，但生产装配只允许真实门禁。
   */
  authorize: (planId: string, confirmed: boolean) => Promise<DeploymentDecisionAuthorization>;
}

export interface StartDeployOptions {
  planId: string;
  confirmed: boolean;
  fresh?: boolean;
  qqMode?: 'official' | 'personal';
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

  async savedQqMode(): Promise<'official' | 'personal' | undefined> {
    try { return await loadDeploymentQqMode(this.deps.container.paths); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
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
   * Starts the plan only after the decision gate approves `planId` and the user confirmed.
   * `fresh` retires the current journal first so an already successful deployment is
   * re-verified step by step instead of being skipped as "nothing to do".
   */
  start(options: StartDeployOptions): Promise<{ taskId: string }> {
    return this.serializeAfterAuthorization(options);
  }

  private async serializeAfterAuthorization(options: StartDeployOptions): Promise<{ taskId: string }> {
    // Authorization happens before taking the lifecycle lock: it is read-only and can fail fast.
    const authorization = await this.deps.authorize(options.planId, options.confirmed);
    return this.serialize(async () => {
      if (!this.running) {
        const previous = await Journal.load(this.journalPath());
        if (previous && !options.fresh) {
          const previousMode = await loadDeploymentQqMode(this.deps.container.paths).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 'official' as const; throw error; });
          if (previousMode !== (options.qqMode ?? 'official')) {
            throw new DdaError(ERROR_CODES.E_DECISION_REQUIRED, '已有其他 QQ 路线的部署任务', '请先继续或处理已有任务，再开始新路线');
          }
        }
        if (options.fresh) this.retireJournal();
        // 先落盘本次确认的运行时，Harness 启动/重启后才能继续使用同一套 Node 与 CLI。
        await saveRuntimeSelection(this.deps.container.paths, authorization.runtime, authorization.decision.planId, options.qqMode ?? 'official');
        this.controlHandle = createTaskControl();
        const handle = this.controlHandle;
        this.running = this.execute(handle.control, authorization.runtime, options.qqMode ?? 'official')
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
   * 继续一个「已经过门禁」的任务：必须存在任务记录，不能凭空启动一次部署。
   * 这保住了暂停/失败后的可恢复性，同时不打开绕过决策门禁的第二条路。
   */
  resume(taskId: string): Promise<{ taskId: string }> {
    return this.serialize(async () => {
      if (taskId !== this.taskId) {
        throw new DdaError(ERROR_CODES.E_DECISION_REQUIRED, '任务 ID 不匹配，已拒绝继续', '请重新检测环境后再部署');
      }
      const data = await Journal.load(this.journalPath());
      if (!data) {
        throw new DdaError(
          ERROR_CODES.E_DECISION_REQUIRED,
          '没有可继续的任务记录，已拒绝执行部署',
          '请先完成「环境检测」并按推荐方案确认',
        );
      }
      if (!this.running) {
        const runtime = await loadRuntimeSelection(this.deps.container.paths);
        const qqMode = await loadDeploymentQqMode(this.deps.container.paths).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 'official' as const; throw error; });
        this.controlHandle = createTaskControl();
        const handle = this.controlHandle;
        this.running = this.execute(handle.control, runtime, qqMode)
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

  private plan(runtime?: RuntimeSelection, qqMode: 'official' | 'personal' = 'official') {
    const { container } = this.deps;
    return buildDeploySteps({
      paths: container.paths,
      manifest: container.nodeManifest,
      matrix: container.matrix,
      registry: container.registry,
      log: (m) => void container.logger.info('deploy', m),
      runtime,
      qqMode,
    });
  }

  private async execute(
    control: ReturnType<typeof createTaskControl>['control'],
    runtime: RuntimeSelection,
    qqMode: 'official' | 'personal',
  ): Promise<TaskSummary> {
    const { container } = this.deps;
    const journal = new Journal(this.journalPath());
    const result = await executePlan({
      taskId: this.taskId,
      scenario: SCENARIO,
      steps: this.plan(runtime, qqMode),
      journal,
      resume: true,
      control,
      log: (m) => container.logger.info('deploy', m),
      onEvent: this.deps.onEvent,
    });
    return result.summary;
  }
}
