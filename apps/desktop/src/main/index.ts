import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';

import { createContainer } from './services/container';
import { DeployService } from './services/deploy-service';
import { DiagnosticsService } from './services/diag-service';
import { EnvService } from './services/env-service';
import { HarnessService } from './services/harness-service';
import { Secrets } from './security/secrets';
import { ApiService } from './services/api-service';
import { attachEventForwarding, registerIpc } from './ipc/register';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | undefined;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const container = await createContainer();
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

    const broadcast = attachEventForwarding(win);
    const deploy = new DeployService({ container, onEvent: broadcast });
    const env = new EnvService(container);
    const secrets = new Secrets(container.paths.root);
    const api = new ApiService(container, secrets);
    const harness = new HarnessService(container, () => api.launchEnv());
    const diagnostics = new DiagnosticsService(container, env, harness, () => deploy.summary());

    registerIpc({ container, deploy, env, harness, diagnostics, secrets, api, broadcast });

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) {
      await win.loadURL(rendererUrl);
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    app.on('before-quit', async () => {
      await harness.stop().catch(() => undefined);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
