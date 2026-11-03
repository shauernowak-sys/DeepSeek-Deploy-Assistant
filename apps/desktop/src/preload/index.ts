import { contextBridge, ipcRenderer } from 'electron';

/**
 * Fixed allowlist. No dynamic channel names, no ipcRenderer exposure.
 * Every payload is validated again on the main side with zod.
 */
const api = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  scanEnv: () => ipcRenderer.invoke('env:scan', {}),
  startDeploy: (fresh = false) => ipcRenderer.invoke('task:start', { scenario: 'full-deploy', fresh }),
  resumeDeploy: (taskId: string) => ipcRenderer.invoke('task:resume', { taskId }),
  taskStatus: (taskId: string) => ipcRenderer.invoke('task:status', { taskId }),
  pauseDeploy: (taskId: string) => ipcRenderer.invoke('task:pause', { taskId }),
  cancelPreview: (taskId: string) => ipcRenderer.invoke('task:cancel-preview', { taskId }),
  cancelDeploy: (taskId: string, cleanup: boolean) => ipcRenderer.invoke('task:cancel', { taskId, cleanup }),
  rollback: (taskId: string) => ipcRenderer.invoke('task:rollback', { taskId }),
  launchHarness: (port = 0) => ipcRenderer.invoke('harness:launch', { port }),
  stopHarness: () => ipcRenderer.invoke('harness:stop'),
  harnessStatus: () => ipcRenderer.invoke('harness:status'),
  openHarness: () => ipcRenderer.invoke('harness:open'),
  listPlugins: () => ipcRenderer.invoke('plugin:list'),
  installQqPlugin: () => ipcRenderer.invoke('plugin:install-qq'),
  apiStatus: () => ipcRenderer.invoke('api:status'),
  apiTest: (payload: { config: unknown; apiKey?: string }) => ipcRenderer.invoke('api:test', payload),
  apiSave: (payload: { config: unknown; apiKey?: string }) => ipcRenderer.invoke('api:save', payload),
  apiDelete: () => ipcRenderer.invoke('api:delete', {}),
  apiStoredRefs: () => ipcRenderer.invoke('api:refs', {}),
  qqStatus: (refresh = false) => ipcRenderer.invoke('qq:status', { refresh }),
  qqSettings: () => ipcRenderer.invoke('qq:settings'),
  qqOutput: () => ipcRenderer.invoke('qq:output'),
  qqSaveCredentials: (payload: { appId: string; appSecret: string }) =>
    ipcRenderer.invoke('qq:save-credentials', payload),
  qqDeleteCredentials: () => ipcRenderer.invoke('qq:delete-credentials', {}),
  qqSaveSettings: (payload: { settings: unknown; mode: 'env' | 'qr' }) =>
    ipcRenderer.invoke('qq:save-settings', payload),
  qqStartBinding: (regenerate = false) => ipcRenderer.invoke('qq:start-binding', { regenerate }),
  qqCancelBinding: () => ipcRenderer.invoke('qq:cancel-binding', {}),
  qqMigrate: (confirm: boolean) => ipcRenderer.invoke('qq:migrate', { confirm }),
  qqRepairPlugin: () => ipcRenderer.invoke('qq:repair-plugin', {}),
  qqOpenBind: () => ipcRenderer.invoke('qq:open-bind', {}),
  // ---- 个人 QQ（SnowLuma 路线）----
  personalStatus: () => ipcRenderer.invoke('personal:status'),
  personalSettings: () => ipcRenderer.invoke('personal:settings'),
  personalGuide: () => ipcRenderer.invoke('personal:guide'),
  personalInstallAdapter: () => ipcRenderer.invoke('personal:install-adapter', {}),
  personalPushBridge: () => ipcRenderer.invoke('personal:push-bridge', {}),
  personalBindPrivate: (sessionId: string, uin: string) =>
    ipcRenderer.invoke('personal:bind-private', { sessionId, uin }),
  personalVerifyMessage: (verified: boolean) => ipcRenderer.invoke('personal:verify-message', { verified }),
  personalOpen: (target: 'project' | 'releases' | 'license' | 'eula' | 'webui') =>
    ipcRenderer.invoke('personal:open', { target }),
  personalPickInstallDir: () => ipcRenderer.invoke('personal:pick-install-dir', {}),
  // ---- 个人 QQ 自动部署（SnowLuma）----
  deployStatus: () => ipcRenderer.invoke('personal:deploy-status'),
  deployProcess: () => ipcRenderer.invoke('personal:deploy-process'),
  deployOutput: () => ipcRenderer.invoke('personal:deploy-output'),
  installDiscovery: () => ipcRenderer.invoke('personal:install-discovery', {}),
  installVerify: (installDir?: string) =>
    ipcRenderer.invoke('personal:install-verify', installDir ? { installDir } : {}),
  installUse: (installDir: string) => ipcRenderer.invoke('personal:install-use', { installDir }),
  deployStart: (payload: { installDir?: string; repair?: boolean }) =>
    ipcRenderer.invoke('personal:deploy-start', payload),
  deployStep: (stepId: string) => ipcRenderer.invoke('personal:deploy-step', { stepId }),
  deployCancel: () => ipcRenderer.invoke('personal:deploy-cancel', {}),
  deployStop: () => ipcRenderer.invoke('personal:deploy-stop', {}),
  deployCredentials: () => ipcRenderer.invoke('personal:deploy-credentials', {}),
  deployConfig: () => ipcRenderer.invoke('personal:deploy-config', {}),
  deployConfigBackups: () => ipcRenderer.invoke('personal:deploy-config-backups', {}),
  deployConfigRestore: (name: string) => ipcRenderer.invoke('personal:deploy-config-restore', { name }),
  personalUninstall: (input: unknown) => ipcRenderer.invoke('personal:uninstall', input),
  personalOpenInstallDir: () => ipcRenderer.invoke('personal:open-install-dir', {}),
  onDeployEvent: (handler: (snapshot: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on('personal:deploy-event', listener);
    return () => ipcRenderer.removeListener('personal:deploy-event', listener);
  },
  openLogs: () => ipcRenderer.invoke('log:open'),
  exportLogs: () => ipcRenderer.invoke('log:export'),
  harnessInfo: () => ipcRenderer.invoke('harness:info'),
  diagPreview: () => ipcRenderer.invoke('diag:preview'),
  diagExport: (confirmed: boolean) => ipcRenderer.invoke('diag:export', { confirmed }),
  onTaskEvent: (handler: (event: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on('task:event', listener);
    return () => ipcRenderer.removeListener('task:event', listener);
  },
};

contextBridge.exposeInMainWorld('dda', api);

export type DdaApi = typeof api;
