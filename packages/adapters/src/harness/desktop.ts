import { join } from 'node:path';

import type { RouteReport } from '@dda/spec';

import { runCommand, fileExists } from '../process/runner';
import { detectRoute, type RouteSignals } from '@dda/core';

export interface DetectRouteOptions {
  dshHome: string;
  managedDshVersion?: string;
  pathDshVersion?: string;
  regExe?: string;
}

/**
 * Best-effort Desktop detection. The registry is the most reliable signal, but `appId` is not a
 * stable constant (M0), so we match on `uninstallDisplayName = "DeepSeek Harness"`.
 * Unreadable registry -> `undefined` (not "absent"), so the caller can degrade to `unknown`.
 */
export async function readDesktopRegistry(regExe = 'C:\\Windows\\System32\\reg.exe'): Promise<RouteSignals['desktopRegistry']> {
  try {
    const { stdout } = await runCommand({
      exePath: regExe,
      args: [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        '/s',
        '/f',
        'DeepSeek Harness',
        '/d',
      ],
      timeoutMs: 20_000,
    });
    const lines = stdout.split(/\r?\n/);
    const keyLine = lines.find((l) => /Uninstall\\.+\\/.test(l) || /Uninstall\\[^\\]+$/.test(l.trim()));
    const display = /DisplayName\s+REG_SZ\s+(.+)/i.exec(stdout)?.[1]?.trim();
    const version = /DisplayVersion\s+REG_SZ\s+(.+)/i.exec(stdout)?.[1]?.trim();
    const location = /InstallLocation\s+REG_SZ\s+(.+)/i.exec(stdout)?.[1]?.trim();
    if (!display) return undefined;
    return { displayName: display, version, installLocation: location ?? keyLine?.trim() };
  } catch {
    return undefined;
  }
}

export async function detectHarnessRoute(options: DetectRouteOptions): Promise<RouteReport> {
  const desktopRegistry = await readDesktopRegistry(options.regExe);
  const desktopDirExists = desktopRegistry?.installLocation
    ? await fileExists(join(desktopRegistry.installLocation, 'DeepSeek Harness.exe'))
    : undefined;

  const desktopProfilePath = join(options.dshHome, 'profiles', 'desktop');
  return detectRoute({
    managedCliVersion: options.managedDshVersion,
    pathCliVersion: options.pathDshVersion,
    homeExists: await fileExists(join(options.dshHome, 'profiles')),
    desktopProfileExists: await fileExists(desktopProfilePath),
    desktopRegistry,
    desktopDirExists,
    dshHome: options.dshHome,
  });
}
