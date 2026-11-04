import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import {
  DiagExportSchema,
  EnvInspectSchema,
  HarnessLaunchSchema,
  ApiEmptySchema,
  ApiSaveSchema,
  ApiTestSchema,
  QqConfirmSchema,
  QqBindingSchema,
  QqCredentialsSchema,
  QqEmptySchema,
  QqSettingsSaveSchema,
  QqStatusQuerySchema,
  PersonalQqBindSchema,
  PersonalQqOpenSchema,
  PersonalQqVerifyMessageSchema,
  ProfileRestoreSchema,
  SnowLumaEmptySchema,
  SnowLumaRestoreConfigSchema,
  SnowLumaRunStepSchema,
  SnowLumaUninstallSchema,
  SnowLumaUseInstallSchema,
  SnowLumaVerifyInstallSchema,
  TaskCancelSchema,
  TaskIdSchema,
  TaskRetryStepSchema,
  TaskRollbackSchema,
  TaskStartSchema,
  BASELINE,
  QQ_GATE_01,
  QQ_GATE_02,
} from '@dda/spec';
import { DEEPSEEK_MODELS, DEEPSEEK_TEMPLATE } from '@dda/core';
import type { TaskEvent } from '@dda/spec';

import type { Container } from '../services/container';
import { DeployService } from '../services/deploy-service';
import { DiagnosticsService } from '../services/diag-service';
import { EnvService } from '../services/env-service';
import { HarnessService } from '../services/harness-service';
import type { ApiService } from '../services/api-service';
import type { QqService } from '../services/qq-service';
import type { PersonalQqService } from '../services/personal-qq-service';
import type { SnowLumaDeploymentService } from '../services/snowluma-deployment-service';
import type { ProfileRecoveryService } from '../services/profile-recovery-service';
import { Secrets } from '../security/secrets';

/**
 * 门禁状态的唯一事实源在 `@dda/spec`（gates.ts）。这里只做转发，避免再出现
 * "代码常量与证据文件不一致"的问题（审计发现 A-06）。
 */
export { QQ_GATE_01, QQ_GATE_02 };

export interface IpcContext {
  container: Container;
  deploy: DeployService;
  env: EnvService;
  harness: HarnessService;
  diagnostics: DiagnosticsService;
  secrets: Secrets;
  api: ApiService;
  qq: QqService;
  personal: PersonalQqService;
  deployment: SnowLumaDeploymentService;
  recovery: ProfileRecoveryService;
  broadcast: (event: TaskEvent) => void;
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle('app:bootstrap', async () => ({
    appVersion: app.getVersion(),
    baseline: BASELINE,
    qqGate: QQ_GATE_01,
    qqGate02: QQ_GATE_02,
    dataDir: ctx.container.paths.root,
    registry: ctx.container.registry,
    lastTask: await ctx.deploy.summary(),
    lastTaskQqMode: await ctx.deploy.savedQqMode().catch(() => undefined),
    // Single source of truth for the "verified DeepSeek template" shown in the UI.
    apiTemplate: DEEPSEEK_TEMPLATE,
    apiModels: DEEPSEEK_MODELS,
    apiStatus: await ctx.api.status(),
    qqSettings: await ctx.qq.settings(),
  }));

  ipcMain.handle('qq:status', async (_event, raw: unknown) => {
    const { refresh } = QqStatusQuerySchema.parse(raw ?? {});
    return ctx.qq.status({ refreshPlugins: refresh });
  });
  ipcMain.handle('qq:settings', async () => ctx.qq.settings());
  ipcMain.handle('qq:output', async () => ctx.harness.outputTail(30));

  ipcMain.handle('qq:save-credentials', async (_event, raw: unknown) => {
    const payload = QqCredentialsSchema.parse(raw);
    return ctx.qq.saveCredentials(payload);
  });

  ipcMain.handle('qq:delete-credentials', async (_event, raw: unknown) => {
    QqEmptySchema.parse(raw ?? {});
    return ctx.qq.deleteCredentials();
  });

  ipcMain.handle('qq:save-settings', async (_event, raw: unknown) => {
    const payload = QqSettingsSaveSchema.parse(raw);
    return ctx.qq.saveSettings(payload);
  });

  ipcMain.handle('qq:start-binding', async (_event, raw: unknown) => {
    const { regenerate } = QqBindingSchema.parse(raw ?? {});
    return ctx.qq.startBinding({ regenerate });
  });

  ipcMain.handle('qq:cancel-binding', async (_event, raw: unknown) => {
    QqEmptySchema.parse(raw ?? {});
    return ctx.qq.cancelBinding();
  });

  ipcMain.handle('qq:migrate', async (_event, raw: unknown) => {
    const { confirm } = QqConfirmSchema.parse(raw);
    if (!confirm) return { ok: false, message: '需要确认后才能迁移明文凭据', problems: ['未确认'] };
    return ctx.qq.migrateToDpapi();
  });

  ipcMain.handle('qq:repair-plugin', async (_event, raw: unknown) => {
    QqEmptySchema.parse(raw ?? {});
    return ctx.qq.repairPlugin();
  });

  ipcMain.handle('qq:open-bind', async (_event, raw: unknown) => {
    QqEmptySchema.parse(raw ?? {});
    const status = await ctx.qq.status();
    if (!status.bindUrl) return { ok: false, reason: '还没有生成扫码链接，请先点"用官方扫码绑定"' };
    // 只允许打开 QQ 官方域名，避免把任意 URL 交给系统浏览器。
    let host: string;
    try {
      host = new URL(status.bindUrl).host;
    } catch {
      return { ok: false, reason: '扫描链接格式异常，已拒绝打开' };
    }
    if (host !== 'q.qq.com') return { ok: false, reason: '非 QQ 官方链接，已拒绝打开' };
    await shell.openExternal(status.bindUrl);
    return { ok: true };
  });

  ipcMain.handle('env:inspect', async (_event, raw: unknown) => {
    const { preferences } = EnvInspectSchema.parse(raw ?? {});
    return ctx.env.inspect(preferences);
  });

  ipcMain.handle('env:decide', async (_event, raw: unknown) => {
    const { preferences } = EnvInspectSchema.parse(raw ?? {});
    return ctx.env.decide(preferences);
  });

  // ---- 个人 QQ（SnowLuma 路线）----
  // 只做检测、引导、适配插件与配置；不下载/安装/启动 SnowLuma（产品决策 + 许可约束）。
  ipcMain.handle('personal:status', async () => ctx.personal.status());
  ipcMain.handle('personal:settings', async () => ctx.personal.settings());
  ipcMain.handle('personal:guide', async () => ctx.personal.guide());

  ipcMain.handle('personal:install-adapter', async () => ctx.personal.installAdapter());
  ipcMain.handle('personal:push-bridge', async () => ctx.personal.pushBridgeConfig());

  ipcMain.handle('personal:bind-private', async (_event, raw: unknown) => {
    const payload = PersonalQqBindSchema.parse(raw);
    return ctx.personal.bindPrivateSession(payload);
  });

  ipcMain.handle('personal:verify-message', async (_event, raw: unknown) => {
    const payload = PersonalQqVerifyMessageSchema.parse(raw);
    const saved = await ctx.personal.markMessageVerified(payload.verified);
    return { ok: true, settings: saved };
  });

  ipcMain.handle('personal:open', async (_event, raw: unknown) => {
    const { target } = PersonalQqOpenSchema.parse(raw);
    // URL 只从清单里取，不接受渲染层传入的任意地址。
    const url = await ctx.personal.targetUrl(target);
    await shell.openExternal(url);
    return { ok: true, url };
  });

  ipcMain.handle('personal:pick-install-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 SnowLuma 安装目录（解压后的目录，里面有 release.json）',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    // 只返回路径，不落盘：由用户在界面上确认"校验通过"后再写入设置。
    return { ok: true, installDir: result.filePaths[0] };
  });

  // ---- 个人 QQ 自动部署（M3.3）：编排全部在主进程，渲染层只读快照 ----
  ipcMain.handle('personal:deploy-status', async () => ctx.deployment.snapshot());
  ipcMain.handle('personal:deploy-process', async () => ctx.deployment.processInfo);
  ipcMain.handle('personal:deploy-output', async () => ctx.deployment.outputTail(40));

  // M3.3.1 引导安装：找目录 → 只读校验 → 用户确认使用
  ipcMain.handle('personal:install-discovery', async (_event, raw: unknown) => {
    SnowLumaEmptySchema.parse(raw ?? {});
    return ctx.deployment.discoverInstall();
  });

  ipcMain.handle('personal:install-verify', async (_event, raw: unknown) => {
    const { installDir } = SnowLumaVerifyInstallSchema.parse(raw ?? {});
    return ctx.deployment.verifyInstall(installDir);
  });

  ipcMain.handle('personal:install-use', async (_event, raw: unknown) => {
    const { installDir } = SnowLumaUseInstallSchema.parse(raw);
    return ctx.deployment.useInstallDir(installDir);
  });

  ipcMain.handle('personal:deploy-step', async (_event, raw: unknown) => {
    const { stepId } = SnowLumaRunStepSchema.parse(raw);
    return ctx.deployment.retryStep(stepId);
  });

  ipcMain.handle('personal:deploy-cancel', async (_event, raw: unknown) => {
    SnowLumaEmptySchema.parse(raw ?? {});
    return ctx.deployment.cancel();
  });

  ipcMain.handle('personal:deploy-stop', async (_event, raw: unknown) => {
    SnowLumaEmptySchema.parse(raw ?? {});
    return ctx.deployment.stopProcess();
  });

  // WebUI 初始口令由上游只在控制台打印一次；主进程内存里保留，展示给用户后不再落任何地方。
  ipcMain.handle('personal:deploy-credentials', async (_event, raw: unknown) => {
    SnowLumaEmptySchema.parse(raw ?? {});
    return ctx.deployment.webuiCredentials();
  });

  ipcMain.handle('personal:deploy-config', async (_event, raw: unknown) => {
    SnowLumaEmptySchema.parse(raw ?? {});
    return ctx.deployment.configInspection();
  });

  ipcMain.handle('personal:deploy-config-backups', async (_event, raw: unknown) => {
    SnowLumaEmptySchema.parse(raw ?? {});
    return ctx.deployment.configBackups();
  });

  ipcMain.handle('personal:deploy-config-restore', async (_event, raw: unknown) => {
    const { name } = SnowLumaRestoreConfigSchema.parse(raw);
    return ctx.deployment.restoreConfigBackup(name);
  });

  ipcMain.handle('personal:uninstall', async (_event, raw: unknown) => {
    const input = SnowLumaUninstallSchema.parse(raw ?? {});
    return ctx.deployment.uninstall(input);
  });

  ipcMain.handle('personal:open-install-dir', async (_event, raw: unknown) => {
    SnowLumaEmptySchema.parse(raw ?? {});
    const snapshot = await ctx.deployment.snapshot();
    await shell.openPath(snapshot.installDir);
    return { ok: true, path: snapshot.installDir };
  });

  ipcMain.handle('task:start', async (_event, raw: unknown) => {
    const payload = TaskStartSchema.parse(raw);
    return ctx.deploy.start({ planId: payload.planId, confirmed: payload.confirmed, fresh: payload.fresh, qqMode: payload.qqMode });
  });

  ipcMain.handle('task:resume', async (_event, raw: unknown) => {
    const { taskId } = TaskIdSchema.parse(raw);
    return ctx.deploy.resume(taskId);
  });

  // §21.10：只重跑当前卡住的那一步，成功后停下（任务保持 paused），由用户决定是否继续。
  ipcMain.handle('task:retry-step', async (_event, raw: unknown) => {
    const { taskId, stepId } = TaskRetryStepSchema.parse(raw);
    return ctx.deploy.retryStep(taskId, stepId);
  });

  ipcMain.handle('task:status', async (_event, raw: unknown) => {
    TaskIdSchema.parse(raw);
    return ctx.deploy.summary();
  });

  ipcMain.handle('task:rollback-preview', async (_event, raw: unknown) => {
    TaskIdSchema.parse(raw);
    return ctx.deploy.rollbackPreview();
  });

  // ---- §21.10「回到上一可用」：profile 备份恢复（D08 能力 → 用户入口）----
  ipcMain.handle('profile:recovery-preview', async () => ctx.recovery.preview());

  ipcMain.handle('profile:restore', async (_event, raw: unknown) => {
    const input = ProfileRestoreSchema.parse(raw);
    return ctx.recovery.restore(input);
  });

  ipcMain.handle('task:rollback', async (_event, raw: unknown) => {
    const input = TaskRollbackSchema.parse(raw);
    return ctx.deploy.rollback(input.confirmed);
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
}

export function attachEventForwarding(win: BrowserWindow): (event: TaskEvent) => void {
  return (event: TaskEvent) => {
    if (!win.isDestroyed()) win.webContents.send('task:event', event);
  };
}
