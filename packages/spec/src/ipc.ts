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

export const DiagExportSchema = z.object({ confirmed: z.boolean() }).strict();

export const HarnessLaunchSchema = z.object({
  port: z.number().int().min(0).max(65535).default(0),
}).strict();

export const PluginInstallSchema = z
  .object({
    name: z.string().min(1).max(214),
    version: z.string().regex(/^[0-9A-Za-z.\-+]+$/),
  })
  .strict();

export const SecretSetSchema = z
  .object({
    key: z.enum(['deepseek.apiKey']),
    value: z.string().min(1).max(4096),
  })
  .strict();

export const LogPathSchema = z.object({}).strict();

export type TaskStartInput = z.infer<typeof TaskStartSchema>;
export type HarnessLaunchInput = z.infer<typeof HarnessLaunchSchema>;
export type PluginInstallInput = z.infer<typeof PluginInstallSchema>;
