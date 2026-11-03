import { app, BrowserWindow, dialog, session } from 'electron';
import { join } from 'node:path';

import type { Logger } from '@dda/core';

import { createContainer } from './services/container';
import { DeployService } from './services/deploy-service';
import { DiagnosticsService } from './services/diag-service';
import { EnvService } from './services/env-service';
import { HarnessService } from './services/harness-service';
import { Secrets } from './security/secrets';
import { ApiService } from './services/api-service';
import { QqService } from './services/qq-service';
import { PersonalQqService } from './services/personal-qq-service';
import { SnowLumaDeploymentService } from './services/snowluma-deployment-service';
import { attachEventForwarding, registerIpc } from './ipc/register';
import { describeStartupError, recordStartupFailure } from './startup-guard';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | undefined;
  /** Undefined until the container exists: a startup failure must still be recorded. */
  let logger: Logger | undefined;
  let quitting = false;

  /**
   * A failure before the window exists would otherwise leave the user with no window and no
   * explanation. Record it (redacted), show a readable dialog, then exit.
   */
  async function reportFatal(phase: string, error: unknown): Promise<void> {
    const record = await recordStartupFailure(app.getPath('userData'), error, phase);
    try {
      await logger?.error('startup', `${phase}: ${record.summary}`);
    } catch {
      // Logging after a failed startup may itself fail; the dialog below still runs.
    }
    try {
      dialog.showErrorBox(
        'DeepSeek Deploy Assistant 启动失败',
        record.logPath
          ? `${record.summary}\n\n已写入诊断日志（不含密钥）：\n${record.logPath}`
          : record.summary,
      );
    } catch {
      // The dialog itself failing must not hide the log we just wrote.
    }
    quitting = true;
    app.quit();
  }

  /** Runtime exceptions are logged; only "no window at all" escalates to the fatal dialog. */
  function reportRuntime(scope: string, error: unknown): void {
    if (quitting) return;
    if (logger) {
      void logger.error(scope, describeStartupError(error));
      return;
    }
    void recordStartupFailure(app.getPath('userData'), error, scope);
    if (!mainWindow || mainWindow.isDestroyed()) void reportFatal(scope, error);
  }

  process.on('unhandledRejection', (reason) => reportRuntime('unhandledRejection', reason));
  process.on('uncaughtException', (error) => reportRuntime('uncaughtException', error));

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  async function bootstrap(): Promise<void> {
    const container = await createContainer();
    logger = container.logger;
    await container.logger.info('app', `starting ${app.getVersion()} (packaged=${app.isPackaged})`);

    const win = new BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 900,
      minHeight: 640,
      show: false,
      title: 'DeepSeek Deploy Assistant',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: !app.isPackaged,
      },
    });
    mainWindow = win;
    win.once('ready-to-show', () => win.show());

    // Renderer is local-only: no remote content, no popups, no permission escalation.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url));
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://') && !url.startsWith('http://localhost')) event.preventDefault();
    });
    // A blank window with no explanation is the worst outcome: make renderer failures visible.
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      void logger?.error('window', `renderer 加载失败 code=${code} ${description} ${url}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      void logger?.error('window', `renderer 进程异常退出 reason=${details.reason} exitCode=${details.exitCode}`);
      if (!quitting && !win.isDestroyed()) {
        dialog.showErrorBox('界面已停止运行', '界面进程意外退出。请重新启动应用；若反复出现，请导出诊断日志。');
      }
    });

    const broadcast = attachEventForwarding(win);
    const deploy = new DeployService({ container, onEvent: broadcast });
    const env = new EnvService(container);
    const secrets = new Secrets(container.paths.root);
    const api = new ApiService(container, secrets);
    let qq: QqService | undefined;
    // One merged environment for the child process: model key (M3.1) + QQ bot credentials (M3.2).
    const harness = new HarnessService(container, async () => ({
      ...(await api.launchEnv()),
      ...(qq ? await qq.launchEnv() : {}),
    }));
    qq = new QqService(container, secrets, harness);
    const personal = new PersonalQqService(container, harness);
    const deployment = new SnowLumaDeploymentService(container, harness, personal, {
      onUpdate: (snapshot) => {
        if (!win.isDestroyed()) win.webContents.send('personal:deploy-event', snapshot);
      },
    });
    const diagnostics = new DiagnosticsService(container, env, harness, () => deploy.summary());

    registerIpc({
      container,
      deploy,
      env,
      harness,
      diagnostics,
      secrets,
      api,
      qq,
      personal,
      deployment,
      broadcast,
    });

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) {
      await win.loadURL(rendererUrl);
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    app.on('before-quit', async () => {
      // 明确的生命周期策略：退出时停止我们启动的 SnowLuma 与 Harness，但不删除任何文件。
      await deployment.dispose().catch(() => undefined);
      await harness.stop().catch(() => undefined);
    });
  }

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => reportFatal('whenReady', error));

  app.on('window-all-closed', () => {
    app.quit();
  });
}
