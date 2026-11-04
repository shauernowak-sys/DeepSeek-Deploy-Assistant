import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import { appPaths, pnpmCliJs } from '@dda/adapters';
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
import { ProfileRecoveryService } from './services/profile-recovery-service';
import { attachEventForwarding, registerIpc } from './ipc/register';
import { describeStartupError, recordStartupFailure } from './startup-guard';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | undefined;
  /** Undefined until the container exists: a startup failure must still be recorded. */
  let logger: Logger | undefined;
  /** Set as soon as an exit has been claimed, by either the fatal path or the quit handshake. */
  let quitting = false;
  /** Latched before the first await: two exceptions in one tick must not produce two dialogs. */
  let fatalClaimed = false;
  /** Set once cleanup has run, so the re-entrant `app.quit()` below is allowed through. */
  let shutdownComplete = false;
  let deployService: DeployService | undefined;
  let shutdownHooks: Array<() => Promise<void> | void> = [];
  let shutdownRun: Promise<void> | undefined;

  /**
   * Same directory the rest of the app writes to (`paths.logs`), so `startup-error.log` shows up
   * in "打开日志目录" and in the exported diagnostic bundle instead of an orphaned `userData` dir.
   */
  function startupLogDir(): string {
    try {
      const localAppData = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local');
      return appPaths(localAppData).logs;
    } catch {
      try {
        return app.getPath('userData');
      } catch {
        return '.';
      }
    }
  }

  function runShutdownHooks(): Promise<void> {
    if (!shutdownRun) {
      shutdownRun = (async () => {
        for (const hook of shutdownHooks) {
          try {
            await hook();
          } catch {
            // One failing hook must not skip the rest.
          }
        }
      })();
    }
    return shutdownRun;
  }

  /**
   * Fatal path: record (redacted) → dialog → stop the work → leave with a non-zero code.
   *
   * Recording an exception is not the same as recovering from it. `uncaughtException` leaves
   * Node's process state undefined, and a rejection while files are being written leaves the
   * on-disk state unknown, so both must end the process rather than let it keep clicking.
   */
  async function reportFatal(phase: string, error: unknown): Promise<void> {
    if (fatalClaimed) return;
    fatalClaimed = true;
    quitting = true;

    const record = await recordStartupFailure(startupLogDir(), error, phase);
    try {
      await logger?.error('startup', `${phase}: ${record.summary}`);
    } catch {
      // Logging after a failed startup may itself fail; the dialog below still runs.
    }
    try {
      dialog.showErrorBox(
        'DeepSeek Deploy Assistant 需要退出',
        record.logPath
          ? `${record.summary}\n\n已写入诊断日志（不含密钥）：\n${record.logPath}`
          : record.summary,
      );
    } catch {
      // The dialog itself failing must not hide the log we just wrote.
    }

    // Bounded: a hung child process must not keep a broken app on screen.
    await Promise.race([runShutdownHooks(), new Promise((done) => setTimeout(done, 5000))]);
    app.exit(1);
  }

  /**
   * Rejections that cannot be attributed to an in-flight file operation are recoverable: IPC
   * handlers already surface their errors to the renderer, so logging is the whole response.
   */
  function reportRecoverable(scope: string, error: unknown): void {
    if (quitting) return;
    if (logger) {
      void logger.warn(scope, describeStartupError(error));
      return;
    }
    void recordStartupFailure(startupLogDir(), error, scope);
  }

  function fileWorkInFlight(): boolean {
    try {
      return deployService?.isRunning ?? false;
    } catch {
      return false;
    }
  }

  process.on('uncaughtException', (error) => {
    // Node guarantees nothing about process state after this point. Continuing would risk
    // deleting half a directory or publishing a half-written journal.
    void reportFatal('uncaughtException', error);
  });

  process.on('unhandledRejection', (reason) => {
    // A rejection while a deploy/cancel/rollback is writing means the disk state is unknown.
    if (fileWorkInFlight()) {
      void reportFatal('unhandledRejection', reason);
      return;
    }
    reportRecoverable('unhandledRejection', reason);
  });

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  /**
   * Electron does not await an async `before-quit` listener, so the handler holds the quit,
   * runs the shutdown hooks, and only then lets `app.quit()` through on its second pass.
   */
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    quitting = true;
    void Promise.race([runShutdownHooks(), new Promise((done) => setTimeout(done, 5000))]).then(() => {
      shutdownComplete = true;
      app.quit();
    });
  });

  async function bootstrap(): Promise<void> {
    const container = await createContainer();
    logger = container.logger;
    await container.logger.info('app', `starting ${app.getVersion()} (packaged=${app.isPackaged})`);

    // Hide Electron's default application menu and retain native Windows window controls.
    Menu.setApplicationMenu(null);
    const win = new BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 900,
      minHeight: 640,
      show: false,
      title: 'DeepSeek Deploy Assistant',
      ...(process.platform === 'win32' ? {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: { color: '#f0f4fa', symbolColor: '#52637a', height: 36 },
      } : {}),
      icon: app.isPackaged ? join(process.resourcesPath, 'app-icon.png') : join(app.getAppPath(), 'apps', 'desktop', 'resources', 'app-icon.png'),
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
    // 门禁先于执行器创建：DeployService 的 start 必须经过 EnvService.authorize。
    const env = new EnvService(container);
    const deploy = new DeployService({
      container,
      onEvent: broadcast,
      authorize: (planId, confirmed) => env.authorize(planId, confirmed),
    });
    deployService = deploy;
    // A journal stuck at `running` from a killed process must not survive into this session.
    await deploy.reconcileInterrupted();
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
    // §21.10「回到上一可用」：D08 的备份/恢复能力接到用户入口，恢复前先打保险备份。
    const recovery = new ProfileRecoveryService({
      container,
      restore: (backupDir) => harness.restoreProfile(backupDir),
      listPlugins: () => harness.listPlugins(),
      isHarnessRunning: () => harness.hasSession,
      hasPnpm: async () => {
        try {
          await access(pnpmCliJs(container.paths), fsConstants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    });

    // Registered here rather than at the very end, so a failure while loading the renderer still
    // stops the child processes we spawned instead of leaving them orphaned.
    shutdownHooks = [
      // 明确的生命周期策略：退出时停止我们启动的 SnowLuma 与 Harness，但不删除任何文件。
      () => deployment.dispose(),
      () => harness.stop(),
    ];

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
      recovery,
      broadcast,
    });

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) {
      await win.loadURL(rendererUrl);
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'));
    }
  }

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => reportFatal('whenReady', error));

  app.on('window-all-closed', () => {
    app.quit();
  });
}
