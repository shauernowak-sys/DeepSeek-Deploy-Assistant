import { dirname, join } from 'node:path';

import { decideInstallation, evaluateEnvironment, type DecideOptions, type EnvironmentProbes } from '@dda/core';
import type { DecisionPreferences, EnvironmentReport, InstallationDecision } from '@dda/spec';

export const BASELINE = { node: '22.23.4', pnpm: '11.28.5', dsh: '0.2.0-rc.2' };
export const NODE_MIN = '20.3.0';

export function probes(overrides: Partial<EnvironmentProbes> = {}): EnvironmentProbes {
  const base: EnvironmentProbes = {
    checkedAt: '2026-11-04T05:00:00.000Z',
    os: { caption: 'Windows_NT 10.0.22631', build: '10.0.22631', arch: 'x64', platform: 'win32', supported: true },
    admin: false,
    disk: { root: 'C:\\', freeBytes: 20 * 1024 ** 3 },
    directories: { root: 'C:\\Users\\u\\AppData\\Local\\DeepSeekDeployAssistant', exists: false, writable: true, checkedPath: 'C:\\Users\\u\\AppData\\Local' },
    network: {
      primaryOk: true,
      mirrorOk: true,
      detail: 'ok',
      targets: [{ name: 'node-primary', url: 'https://cdn.example/node.zip', ok: true, detail: 'HTTP 200' }],
    },
    systemNodes: [],
    systemHarness: [],
    desktop: { registryRead: true, exeExists: false, profileExists: false },
    route: { kind: 'none', evidence: [{ signal: 'route', ok: true, raw: 'none' }] },
    profiles: { home: 'C:\\data\\dsh-home', homeExists: false, webExists: false, desktopExists: false },
    probeErrors: [],
  };
  return { ...base, ...overrides };
}

export function report(overrides: Partial<EnvironmentProbes> = {}): EnvironmentReport {
  return evaluateEnvironment(probes(overrides), { baseline: BASELINE, nodeMinVersion: NODE_MIN });
}

export function decide(
  result: EnvironmentReport,
  preferences: DecisionPreferences = {},
  overrides: Partial<DecideOptions> = {},
): InstallationDecision {
  return decideInstallation(result, {
    baseline: BASELINE,
    nodeMinVersion: NODE_MIN,
    targets: {
      managedNodeExe: join('C:\\data', 'runtimes', 'node', '22.23.4', 'node.exe'),
      managedNodeDir: join('C:\\data', 'runtimes', 'node', '22.23.4'),
      managedHarnessBin: join('C:\\data', 'harness', '0.2.0-rc.2', 'lib', 'bin.js'),
    },
    preferences,
    ...overrides,
  });
}

export function desktopInstalled(version = '0.2.0') {
  return {
    registryRead: true,
    displayName: 'DeepSeek Harness',
    version,
    installDir: 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness',
    exeExists: true,
    profileExists: true,
  };
}

export function stableSystemNode(version = '22.23.4', path = 'C:\\Program Files\\nodejs\\node.exe') {
  return { path, version, source: 'common' as const, runnable: true, stable: true, hasNpm: true };
}

export function managedNode(version = '22.23.4', runnable = true) {
  return { path: join('C:\\data', 'runtimes', 'node', version, 'node.exe'), version, runnable };
}

export function managedPnpm(version = '11.28.5', runnable = true) {
  return { path: join('C:\\data', 'runtimes', 'pnpm', 'pnpm.cjs'), version, runnable };
}

export function managedHarness(version = '0.2.0-rc.2', runnable = true) {
  return { path: join('C:\\data', 'harness', version, 'lib', 'bin.js'), version, runnable };
}

export function systemHarness(version = '0.2.0-rc.2', options: { stable?: boolean; runnable?: boolean } = {}) {
  const path = 'C:\\Users\\u\\AppData\\Roaming\\npm\\dsh.cmd';
  return {
    path,
    binPath: join(dirname(path), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    version,
    runnable: options.runnable ?? true,
    stable: options.stable ?? true,
    onPathOrder: 0,
  };
}

/** 一套「已经装好、无需联网」的完整私有环境。 */
export function fullyInstalledProbes(): Partial<EnvironmentProbes> {
  return {
    managedNode: managedNode(),
    managedPnpm: managedPnpm(),
    managedHarness: managedHarness(),
    route: { kind: 'cli', evidence: [{ signal: 'cli.managedVersion', ok: true, raw: BASELINE.dsh }] },
    profiles: { home: 'C:\\data\\dsh-home', homeExists: true, webExists: true, desktopExists: false },
    network: { primaryOk: false, mirrorOk: false, detail: 'offline', targets: [] },
  };
}
