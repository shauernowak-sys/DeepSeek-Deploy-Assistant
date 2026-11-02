import { app } from 'electron';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { loadMatrix, Logger } from '@dda/core';
import { RuntimeManifestSchema } from '@dda/spec';
import type { CompatMatrix, RuntimeManifest } from '@dda/spec';
import { appPaths, type AppPaths } from '@dda/adapters';

export interface Container {
  paths: AppPaths;
  logger: Logger;
  matrix: CompatMatrix;
  nodeManifest: RuntimeManifest;
  manifestsDir: string;
  registry: string;
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

  return {
    paths,
    logger,
    matrix,
    nodeManifest,
    manifestsDir: dir,
    registry: process.env.DDA_REGISTRY ?? 'https://registry.npmmirror.com',
  };
}
