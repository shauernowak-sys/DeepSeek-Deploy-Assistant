import { z } from 'zod';

export const EmptySchema = z.object({}).strict();

export const EnvScanSchema = z.object({}).strict();

export const TaskStartSchema = z.object({
  scenario: z.literal('full-deploy'),
  /** Re-verify an already successful deployment by starting from a fresh journal. */
  fresh: z.boolean().default(false),
}).strict();

export const TaskIdSchema = z.object({ taskId: z.string().min(1) }).strict();

export const TaskCancelSchema = z
  .object({
    taskId: z.string().min(1),
    cleanup: z.boolean(),
  })
  .strict();

/**
 * Rollback deletes files, so the renderer must send an explicit `confirmed: true`.
 * `task:rollback-preview` is the read-only half: it lists what would be removed.
 */
export const TaskRollbackSchema = z
  .object({
    taskId: z.string().min(1),
    confirmed: z.boolean(),
  })
  .strict();

export const DiagExportSchema = z.object({ confirmed: z.boolean() }).strict();

export const HarnessLaunchSchema = z.object({
  port: z.number().int().min(0).max(65535).default(0),
}).strict();

/** Provider settings coming from the renderer. Values are re-validated in the main process. */
export const ApiProviderSchema = z
  .object({
    template: z.enum(['deepseek', 'openai-compatible']),
    label: z.string().min(1).max(64),
    protocol: z.enum(['anthropic-messages', 'openai-completions']),
    baseUrl: z.string().min(1).max(500),
    model: z.string().min(1).max(200),
    credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    contextWindow: z.number().int().positive().max(100_000_000).optional(),
  })
  .strict();

export const ApiSaveSchema = z
  .object({
    config: ApiProviderSchema,
    /** Omit to keep the already stored key. */
    apiKey: z.string().min(8).max(4096).optional(),
  })
  .strict();

export const ApiTestSchema = ApiSaveSchema;

export const ApiEmptySchema = z.object({}).strict();

export type TaskStartInput = z.infer<typeof TaskStartSchema>;
export type TaskRollbackInput = z.infer<typeof TaskRollbackSchema>;
export type HarnessLaunchInput = z.infer<typeof HarnessLaunchSchema>;
