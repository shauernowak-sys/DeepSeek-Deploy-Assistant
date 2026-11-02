import type { Evidence, RouteReport } from '@dda/spec';

export interface RouteSignals {
  /** Managed CLI install (our runtime dir) — most authoritative for the CLI route. */
  managedCliVersion?: string;
  /** `dsh` found on PATH. */
  pathCliVersion?: string;
  /** `<DSH_HOME>/profiles` exists. */
  homeExists: boolean;
  /** `<DSH_HOME>/profiles/desktop` exists (created only by the official Desktop app). */
  desktopProfileExists: boolean;
  /** HKCU uninstall entry `DisplayName = "DeepSeek Harness"` (best effort; undefined = could not read). */
  desktopRegistry?: { displayName: string; installLocation?: string; version?: string };
  /** Existence of the install dir derived from the registry entry. */
  desktopDirExists?: boolean;
  dshHome: string;
}

/**
 * Four states plus `unknown`. `unknown` is mandatory when signals contradict each other:
 * we must never guess `none` and start installing on top of an existing installation.
 */
export function detectRoute(s: RouteSignals): RouteReport {
  const evidence: Evidence[] = [];
  const cliVersion = s.managedCliVersion ?? s.pathCliVersion;

  evidence.push({ signal: 'cli.managedVersion', ok: Boolean(s.managedCliVersion), raw: s.managedCliVersion ?? '-' });
  evidence.push({ signal: 'cli.pathVersion', ok: Boolean(s.pathCliVersion), raw: s.pathCliVersion ?? '-' });
  evidence.push({ signal: 'home.profiles', ok: s.homeExists, raw: s.dshHome });
  evidence.push({ signal: 'home.desktopProfile', ok: s.desktopProfileExists, raw: s.desktopProfileExists ? 'present' : 'absent' });
  evidence.push({
    signal: 'desktop.registry',
    ok: Boolean(s.desktopRegistry),
    raw: s.desktopRegistry ? `${s.desktopRegistry.displayName} ${s.desktopRegistry.version ?? ''}`.trim() : 'not-found',
  });
  evidence.push({
    signal: 'desktop.installDir',
    ok: Boolean(s.desktopDirExists),
    raw: s.desktopDirExists ? (s.desktopRegistry?.installLocation ?? 'present') : 'absent',
  });

  const cliPresent = Boolean(cliVersion);
  const desktopPresent = Boolean(s.desktopRegistry) || s.desktopProfileExists;

  // Contradiction: registry entry without its directory, or a desktop profile without any desktop trace.
  const registryWithoutDir = Boolean(s.desktopRegistry) && s.desktopDirExists === false;
  if (registryWithoutDir) {
    return { kind: 'unknown', evidence, dshHome: s.dshHome };
  }

  if (cliPresent && desktopPresent) {
    return {
      kind: 'multiple',
      evidence,
      desktopInstallDir: s.desktopRegistry?.installLocation,
      dshHome: s.dshHome,
    };
  }
  if (cliPresent) return { kind: 'cli', evidence, dshHome: s.dshHome };
  if (desktopPresent) {
    return {
      kind: 'desktop',
      evidence,
      desktopInstallDir: s.desktopRegistry?.installLocation,
      dshHome: s.dshHome,
    };
  }
  return { kind: 'none', evidence, dshHome: s.dshHome };
}

/** Desktop owns `profiles/desktop`; writes must be refused regardless of route detection. */
export function isWritableProfile(profileName: string, desktopProfileExists: boolean): boolean {
  if (profileName === 'desktop') return false;
  if (desktopProfileExists && profileName === 'desktop') return false;
  return true;
}
