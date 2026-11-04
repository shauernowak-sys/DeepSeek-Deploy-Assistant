import { app } from 'electron';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { loadMatrix, Logger } from '@dda/core';
import { RuntimeManifestSchema } from '@dda/spec';
import type { CompatMatrix, RuntimeManifest } from '@dda/spec';
import {
  appPaths,
  describeProxyReport,
  findDeadProxySettings,
  type AppPaths,
} from '@dda/adapters';

export interface Container {
  paths: AppPaths;
  logger: Logger;
  matrix: CompatMatrix;
  nodeManifest: RuntimeManifest;
  manifestsDir: string;
  registry: string;
  /**
   * P-11：探测到不可达的代理变量名。只从本软件启动的子进程 env 里剔除，
   * 不改 `process.env`，更不改用户系统设置。
   */
  childEnvExclusions: string[];
}

export function manifestsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'manifests')
    : join(app.getAppPath(), 'apps', 'desktop', 'resources', 'manifests');
}

export async function createContainer(): Promise<Container> {
  const localAppData = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local');
  const paths = appPaths(localAppData);
  const dir = manifestsDir();

  const logger = await Logger.create(paths.logs, `app-${new Date().toISOString().slice(0, 10)}.log`);
  const matrix = loadMatrix(JSON.parse(await readFile(join(dir, 'compat.json'), 'utf8')));
  const nodeManifest = RuntimeManifestSchema.parse(JSON.parse(await readFile(join(dir, 'node.json'), 'utf8')));

  // P-11：VPN 客户端遗留的死端口代理会把安装拖到 70 s 级；这里探测一次，只用于子进程剔除。
  const proxy = await findDeadProxySettings(process.env, { timeoutMs: 1200 });
  await logger.info('env', `代理检测：${describeProxyReport(proxy)}`);

  return {
    paths,
    logger,
    matrix,
    nodeManifest,
    manifestsDir: dir,
    registry: process.env.DDA_REGISTRY ?? 'https://registry.npmmirror.com',
    childEnvExclusions: proxy.dead.map((setting) => setting.name),
  };
}
