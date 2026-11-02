export interface StepContext {
  /** Report sub-progress of the current step (0..1). */
  progress: (fraction: number) => void;
  /** Tell the journal that we created a path, so rollback can delete it. */
  created: (path: string) => void;
  log: (message: string) => void;
  /** Aborted when the user cancels; long operations must observe it. */
  signal: AbortSignal;
  /** Cooperative check for steps that loop. */
  isCancelled: () => boolean;
}

export interface Step {
  id: string;
  title: string;
  weight: number;
  /** Returning true means "already in the target state" — the step is recorded as skipped. */
  precondition?: (ctx: StepContext) => Promise<boolean>;
  run: (ctx: StepContext) => Promise<void>;
  rollback?: (ctx: StepContext) => Promise<void>;
  retries?: number;
}

export function totalWeight(steps: Step[]): number {
  return steps.reduce((sum, s) => sum + s.weight, 0);
}

/** Sequential plan in dependency order (topological by construction, see docs 01 §6.3). */
export function plan(...steps: Step[]): Step[] {
  return steps;
}
