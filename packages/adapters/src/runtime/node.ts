import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { RuntimeManifestSchema, type RuntimeInfo, type RuntimeManifest } from '@dda/spec';
import { extractZip } from '@dda/core';

import { fileExists, runCommand } from '../process/runner';
import type { AppPaths } from '../paths';
import { nodeExe } from '../paths';

export async function loadNodeManifest(manifestsDir: string): Promise<RuntimeManifest> {
  const raw = JSON.parse(await readFile(join(manifestsDir, 'node.json'), 'utf8')) as unknown;
  return RuntimeManifestSchema.parse(raw);
}

export async function detectManagedNode(paths: AppPaths): Promise<RuntimeInfo> {
  const exe = nodeExe(paths);
  if (!(await fileExists(exe))) return { id: 'node', installed: false };
  try {
    const { stdout } = await runCommand({ exePath: exe, args: ['-v'], timeoutMs: 15_000 });
    return { id: 'node', installed: true, version: stdout.trim().replace(/^v/, ''), path: exe };
  } catch {
    return { id: 'node', installed: false, path: exe };
  }
}

export interface InstallNodeOptions {
  paths: AppPaths;
  manifest: RuntimeManifest;
  zipPath: string;
  log: (m: string) => void;
}

/** Extract the portable Node zip into `runtimes/node/<ver>/` (idempotent: precheck by caller). */
export async function installNodeRuntime(options: InstallNodeOptions): Promise<void> {
  const { paths, manifest, zipPath, log } = options;
  const staging = join(paths.runtimes, 'node', '.staging');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  log(`解压 Node ${manifest.version} 到 ${paths.nodeDir}`);
  const result = await extractZip({ zipPath, destDir: staging, stripTopLevelDir: true, maxTotalBytes: 512 * 1024 * 1024 });
  log(`解压完成: ${result.files} 个文件, ${(result.bytes / 1024 / 1024).toFixed(1)} MB`);

  await rm(paths.nodeDir, { recursive: true, force: true });
  await mkdir(join(paths.nodeDir, '..'), { recursive: true });
  const { rename } = await import('node:fs/promises');
  await rename(staging, paths.nodeDir);
}
