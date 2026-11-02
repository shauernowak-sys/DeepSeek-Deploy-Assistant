import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';

import {
  DiagExportSchema,
  EnvScanSchema,
  HarnessLaunchSchema,
  ApiEmptySchema,
  ApiSaveSchema,
  ApiTestSchema,
  TaskCancelSchema,
  TaskIdSchema,
  TaskStartSchema,
  BASELINE,
} from '@dda/spec';
import { DEEPSEEK_MODELS, DEEPSEEK_TEMPLATE } from '@dda/core';
import type { TaskEvent } from '@dda/spec';

import type { Container } from '../services/container';
import { DeployService } from '../services/deploy-service';
import { DiagnosticsService } from '../services/diag-service';
import { EnvService } from '../services/env-service';
import { HarnessService } from '../services/harness-service';
import type { ApiService } from '../services/api-service';
import { Secrets } from '../security/secrets';

export const QQ_GATE_01 = {
  id: 'QQ-GATE-01',
  title: 'QQ 真实链路验收',
  status: 'not-passed' as const,
  verified: ['插件安装', '插件加载', '绑定二维码/链接生成'],
  notVerified: ['真实扫码授权', '群/私聊消息收发', '图片消息', '断线重连', '重启后免扫码恢复'],
  note: '缺乏真实机器人凭据，任何一项都不得标记为通过；Mock 测试仅覆盖安装流程与界面。',
};

export interface IpcContext {
  container: Container;
  deploy: DeployService;
  env: EnvService;
  harness: HarnessService;
  diagnostics: DiagnosticsService;
  secrets: Secrets;
  api: ApiService;
  broadcast: (event: TaskEvent) => void;
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle('app:bootstrap', async () => ({
    appVersion: app.getVersion(),
    baseline: BASELINE,
    qqGate: QQ_GATE_01,
    dataDir: ctx.container.paths.root,
    registry: ctx.container.registry,
    lastTask: await ctx.deploy.summary(),
    // Single source of truth for the "verified DeepSeek template" shown in the UI.
    apiTemplate: DEEPSEEK_TEMPLATE,
    apiModels: DEEPSEEK_MODELS,
    apiStatus: await ctx.api.status(),
  }));

  ipcMain.handle('env:scan', async (_event, raw: unknown) => {
    EnvScanSchema.parse(raw ?? {});
    return ctx.env.scan();
  });

  ipcMain.handle('task:start', async (_event, raw: unknown) => {
    const payload = TaskStartSchema.parse(raw);
    return ctx.deploy.start({ fresh: payload.fresh });
  });

  ipcMain.handle('task:resume', async (_event, raw: unknown) => {
    TaskIdSchema.parse(raw);
    return ctx.deploy.start();
  });

  ipcMain.handle('task:status', async (_event, raw: unknown) => {
    TaskIdSchema.parse(raw);
    return ctx.deploy.summary();
  });

  ipcMain.handle('task:rollback', async (_event, raw: unknown) => {
    TaskIdSchema.parse(raw);
    return ctx.deploy.rollback();
  });

  ipcMain.handle('task:pause', async (_event, raw: unknown) => {
    TaskIdSchema.parse(raw);
    return ctx.deploy.pause();
  });

  ipcMain.handle('task:cancel-preview', async (_event, raw: unknown) => {
    TaskIdSchema.parse(raw);
    return ctx.deploy.cleanupPreview();
  });

  ipcMain.handle('task:cancel', async (_event, raw: unknown) => {
    const input = TaskCancelSchema.parse(raw);
    return ctx.deploy.cancel(input.cleanup);
  });

  ipcMain.handle('harness:launch', async (_event, raw: unknown) => {
    const { port } = HarnessLaunchSchema.parse(raw ?? {});
    return ctx.harness.launch(port);
  });

  ipcMain.handle('harness:stop', async () => {
    await ctx.harness.stop();
    return { ok: true };
  });

  ipcMain.handle('harness:status', async () => ctx.harness.status());

  ipcMain.handle('harness:info', async () => {
    const report = await ctx.env.scan();
    const dsh = report.runtimes.find((r) => r.id === 'dsh');
    const node = report.runtimes.find((r) => r.id === 'node');
    return {
      dshVersion: dsh?.version,
      nodeVersion: node?.version,
      profile: BASELINE.dsh.profile,
      profileExists: dsh?.installed ?? false,
      plugins: await ctx.harness.listPlugins().catch(() => []),
      task: await ctx.deploy.summary(),
    };
  });

  ipcMain.handle('harness:open', async () => {
    const url = ctx.harness.bindUrl;
    if (!url) return { ok: false, reason: '尚未启动 Harness' };
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('plugin:list', async () => ctx.harness.listPlugins());

  ipcMain.handle('plugin:install-qq', async () => {
    await ctx.harness.installQqPlugin();
    return ctx.harness.listPlugins();
  });

  ipcMain.handle('api:status', async () => ctx.api.status());

  ipcMain.handle('api:test', async (_event, raw: unknown) => {
    const input = ApiTestSchema.parse(raw);
    return ctx.api.test(input);
  });

  ipcMain.handle('api:save', async (_event, raw: unknown) => {
    const input = ApiSaveSchema.parse(raw);
    return ctx.api.save(input);
  });

  ipcMain.handle('api:delete', async (_event, raw: unknown) => {
    ApiEmptySchema.parse(raw ?? {});
    return ctx.api.remove();
  });

  ipcMain.handle('log:open', async () => {
    await shell.openPath(ctx.container.paths.logs);
    return { path: ctx.container.paths.logs };
  });

  ipcMain.handle('diag:preview', async () => ctx.diagnostics.preview());

  ipcMain.handle('diag:export', async (_event, raw: unknown) => {
    const input = DiagExportSchema.parse(raw ?? { confirmed: false });
    if (!input.confirmed) {
      return { cancelled: true as const };
    }
    const result = await ctx.diagnostics.export();
    await shell.showItemInFolder(result.zipPath);
    return { cancelled: false as const, ...result };
  });

  ipcMain.handle('log:export', async () => {
    const target = join(ctx.container.paths.root, 'logs-export.txt');
    await shell.openPath(ctx.container.paths.logs);
    return { path: target, note: 'M1 阶段仅打开日志目录；诊断包打包在 M5 实现' };
  });
}

export function attachEventForwarding(win: BrowserWindow): (event: TaskEvent) => void {
  return (event: TaskEvent) => {
    if (!win.isDestroyed()) win.webContents.send('task:event', event);
  };
}
