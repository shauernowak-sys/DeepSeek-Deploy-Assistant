import { statfs } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { arch, release, type } from 'node:os';

import type { EnvReport, RuntimeInfo, RuntimeId, RouteReport } from '@dda/spec';

export interface RuntimeProbe {
  detect(id: RuntimeId): Promise<RuntimeInfo>;
}

export interface EnvDetectDeps {
  probe: RuntimeProbe;
  route: () => Promise<RouteReport>;
  /** Drive to report free space for (default: system drive). */
  driveRoot?: string;
}

export async function detectAdmin(): Promise<boolean> {
  try {
    // Reading the SAM database requires an elevated token; failure means "not admin".
    const handle = await open('C:\\Windows\\System32\\config\\SAM', 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

export async function detectEnv(deps: EnvDetectDeps): Promise<EnvReport> {
  const diskFreeBytes = await freeBytes(deps.driveRoot ?? 'C:\\');
  const runtimes = await Promise.all([deps.probe.detect('node'), deps.probe.detect('pnpm'), deps.probe.detect('dsh')]);
  return {
    os: {
      caption: `${type()} ${release()}`,
      build: process.env.OS_BUILD ?? '',
      arch: arch(),
      admin: await detectAdmin(),
    },
    diskFreeBytes,
    runtimes,
    route: await deps.route(),
    checkedAt: new Date().toISOString(),
  };
}

export async function freeBytes(root: string): Promise<number> {
  try {
    const stats = await statfs(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
