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
  setApiKey: (value: string) => ipcRenderer.invoke('secret:set', { key: 'deepseek.apiKey', value }),
  secretStatus: () => ipcRenderer.invoke('secret:status'),
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
