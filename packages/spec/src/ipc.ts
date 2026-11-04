import { z } from 'zod';

export const EmptySchema = z.object({}).strict();

export const EnvScanSchema = z.object({}).strict();

/** 决策偏好来自用户在选择页的显式选择；主进程会再次校验。 */
export const DecisionPreferencesSchema = z
  .object({
    node: z.enum(['auto', 'system', 'private']).optional(),
    harness: z.enum(['auto', 'system', 'private']).optional(),
    nodePath: z.string().min(1).max(1000).optional(),
    harnessPath: z.string().min(1).max(1000).optional(),
    routeAcknowledged: z.boolean().optional(),
  })
  .strict();

export const EnvInspectSchema = z
  .object({ preferences: DecisionPreferencesSchema.optional() })
  .strict();

/**
 * 部署必须先拿到一次「环境检测 + 安装决策」的 planId，并由用户显式确认。
 * 缺任何一个都拒绝：UI 不得绕过决策门禁直接调用部署执行器。
 */
export const TaskStartSchema = z
  .object({
    scenario: z.literal('full-deploy'),
    qqMode: z.enum(['official', 'personal']).default('official'),
    /** Re-verify an already successful deployment by starting from a fresh journal. */
    fresh: z.boolean().default(false),
    planId: z.string().min(8).max(128),
    confirmed: z.boolean(),
  })
  .strict();

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

/**
 * §21.10「回到上一可用」：恢复 profile 备份会覆盖 profile 的声明文件并重建依赖，
 * 因此和 rollback 一样必须显式 `confirmed: true`；`id` 省略表示"最近一份"。
 */
export const ProfileRestoreSchema = z
  .object({
    id: z.string().min(1).optional(),
    confirmed: z.boolean(),
  })
  .strict();

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
