import { dirname, join } from 'node:path';

import { BASELINE } from '@dda/spec';

export interface AppPaths {
  root: string;
  runtimes: string;
  nodeDir: string;
  pnpmPrefix: string;
  harnessDir: string;
  dshHome: string;
  stateTasks: string;
  logs: string;
  downloads: string;
  licenses: string;
}

export function appPaths(localAppData: string): AppPaths {
  const root = join(localAppData, 'DeepSeekDeployAssistant');
  return {
    root,
    runtimes: join(root, 'runtimes'),
    nodeDir: join(root, 'runtimes', 'node', BASELINE.node.version),
    pnpmPrefix: join(root, 'runtimes', 'pnpm'),
    harnessDir: join(root, 'harness', BASELINE.dsh.version),
    dshHome: join(root, 'dsh-home'),
    stateTasks: join(root, 'state', 'tasks'),
    logs: join(root, 'logs'),
    downloads: join(root, 'cache', 'downloads'),
    licenses: join(root, 'licenses'),
  };
}

export function nodeExe(paths: AppPaths): string {
  return join(paths.nodeDir, 'node.exe');
}

export function npmCliJs(paths: AppPaths): string {
  return join(paths.nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** npm 随 Node 一起安装；复用系统 Node 时从同一个目录解析 npm 入口。 */
export function npmCliFor(nodeExePath: string): string {
  return join(dirname(nodeExePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

export function pnpmCliJs(paths: AppPaths): string {
  return join(paths.pnpmPrefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
}

export function dshBinJs(paths: AppPaths): string {
  return join(paths.harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
