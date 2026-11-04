import { access, readFile, readdir, stat, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch, release, type as osType } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

import {
  detectAdmin,
  detectRoute,
  evaluateEnvironment,
  type DesktopProbe,
  type EnvironmentProbes,
  type ManagedRuntimeProbe,
  type NetworkProbe,
  type NodeProbe,
  type SystemHarnessProbe,
} from '@dda/core';
import type { EnvironmentReport, RuntimeManifest } from '@dda/spec';
import { BASELINE } from '@dda/spec';

import { fileExists, runCommand, tryRunCommand } from '../process/runner';
import { dshBinJs, nodeExe, npmCliFor, pnpmCliJs, type AppPaths } from '../paths';

const MAX_CANDIDATES = 12;

export interface ProbeEnvironmentOptions {
  paths: AppPaths;
  manifest: RuntimeManifest;
  nodeMinVersion: string;
  registry: string;
  /** Per-command ceiling; filesystem/network probes have their own ceiling. */
  commandTimeoutMs?: number;
  /** Injectable for tests that need a deterministic clock. */
  now?: () => Date;
}

function pathEntries(): string[] {
  return (process.env.PATH ?? '')
    .split(';')
    .map((p) => p.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function isVersionManagerPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes('\\nvm\\') ||
    lower.includes('\\fnm_multishells\\') ||
    lower.includes('\\volta\\') ||
    lower.includes('\\scoop\\apps\\') ||
    lower.includes('\\appdata\\local\\temp\\') ||
    lower.includes('\\temp\\') ||
    lower.includes('\\tmp\\')
  );
}

async function enumerateDirs(pattern: string, parent: string, candidate: (dir: string) => string): Promise<string[]> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && pattern !== '' && new RegExp(pattern).test(e.name))
    .slice(0, 5)
    .map((e) => candidate(join(parent, e.name)));
}

async function discoverNodeCandidates(): Promise<NodeProbe[]> {
  const found = new Map<string, { path: string; source: NodeProbe['source']; onPathOrder?: number }>();

  const add = async (path: string, source: NodeProbe['source'], onPathOrder?: number) => {
    const key = resolve(path).toLowerCase();
    if (found.has(key)) return;
    if (!(await fileExists(path))) return;
    found.set(key, { path, source, onPathOrder });
  };

  for (const [index, dir] of pathEntries().entries()) {
    await add(join(dir, 'node.exe'), 'path', index);
  }

  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  const userProfile = process.env.USERPROFILE;

  const common = [
    programFiles ? join(programFiles, 'nodejs', 'node.exe') : undefined,
    programFilesX86 ? join(programFilesX86, 'nodejs', 'node.exe') : undefined,
    localAppData ? join(localAppData, 'Programs', 'nodejs', 'node.exe') : undefined,
    userProfile ? join(userProfile, 'scoop', 'apps', 'nodejs', 'current', 'node.exe') : undefined,
  ].filter((p): p is string => Boolean(p));
  for (const path of common) await add(path, 'common');

  if (appData) {
    for (const path of await enumerateDirs('^v\\d', join(appData, 'nvm'), (dir) => join(dir, 'node.exe'))) {
      await add(path, 'version-manager');
    }
  }
  if (process.env.NVM_HOME) {
    for (const path of await enumerateDirs('^v\\d', process.env.NVM_HOME, (dir) => join(dir, 'node.exe'))) {
      await add(path, 'version-manager');
    }
  }
  if (localAppData) {
    for (const path of await enumerateDirs('.+', join(localAppData, 'fnm_multishells'), (dir) => join(dir, 'node.exe'))) {
      await add(path, 'version-manager');
    }
    for (const path of await enumerateDirs(
      '^\\d',
      join(localAppData, 'Volta', 'tools', 'image', 'node'),
      (dir) => join(dir, 'node.exe'),
    )) {
      await add(path, 'version-manager');
    }
  }

  const entries = [...found.values()].slice(0, MAX_CANDIDATES);
  const results = await Promise.all(
    entries.map(async (entry): Promise<NodeProbe> => {
      try {
        const { stdout } = await runCommand({ exePath: entry.path, args: ['-v'], timeoutMs: 8_000 });
        const version = stdout.trim().replace(/^v/, '');
        if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`无法解析版本输出: ${stdout.trim().slice(0, 80)}`);
        return {
          path: entry.path,
          version,
          source: entry.source,
          runnable: true,
          stable: !isVersionManagerPath(entry.path),
          onPathOrder: entry.onPathOrder,
          hasNpm: await fileExists(npmCliFor(entry.path)),
        };
      } catch (error) {
        return {
          path: entry.path,
          source: entry.source,
          runnable: false,
          stable: !isVersionManagerPath(entry.path),
          onPathOrder: entry.onPathOrder,
          hasNpm: await fileExists(npmCliFor(entry.path)),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return results;
}

async function probeManagedRuntime(
  name: string,
  file: string,
  node: string | undefined,
  argsFor: (file: string) => string[],
): Promise<ManagedRuntimeProbe | undefined> {
  if (!(await fileExists(file))) return undefined;
  if (!node) return { path: file, runnable: false, error: '没有可用于读取版本的 Node.js 运行时' };
  try {
    const { stdout } = await runCommand({ exePath: node, args: argsFor(file), timeoutMs: 20_000 });
    const version = stdout.trim().split(/\r?\n/)[0]?.trim().replace(/^v/, '');
    return { path: file, version, runnable: true };
  } catch (error) {
    return { path: file, runnable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveShimEntry(file: string, content: string): string | undefined {
  const base = dirname(file);
  const tokens = new Set<string>();
  for (const match of content.matchAll(/"([^"]+\.js)"/g)) tokens.add(match[1]!);
  for (const match of content.matchAll(/([^\s"]+\.js)/g)) tokens.add(match[1]!);

  for (const token of tokens) {
    const expanded = token
      .replace(/%~dp0\\?/gi, `${base}\\`)
      .replace(/%dp0%\\?/gi, `${base}\\`)
      .replace(/\$basedir/gi, base)
      .replace(/^\$basedir[\\/]/i, '');
    const absolute = /^[A-Za-z]:[\\/]/.test(expanded) ? expanded : resolve(base, expanded);
    if (absolute.toLowerCase().startsWith(base.toLowerCase())) return absolute;
  }
  return undefined;
}

async function discoverSystemHarness(probeNode: string | undefined): Promise<SystemHarnessProbe[]> {
  const dirs = new Map<string, number | undefined>();
  for (const [index, dir] of pathEntries().entries()) dirs.set(dir, index);
  const extra = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm') : undefined,
  ].filter((p): p is string => Boolean(p));
  for (const dir of extra) if (!dirs.has(dir)) dirs.set(dir, undefined);

  const found: { path: string; onPathOrder?: number }[] = [];
  for (const [dir, onPathOrder] of dirs) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!/^dsh(\.cmd|\.exe|\.ps1)?$/i.test(name)) continue;
      const path = join(dir, name);
      if (await fileExists(path)) found.push({ path, onPathOrder });
    }
  }

  const results = await Promise.all(
    found.slice(0, MAX_CANDIDATES).map(async (entry): Promise<SystemHarnessProbe> => {
      const stable = !isVersionManagerPath(entry.path);
      const base = { path: entry.path, stable, onPathOrder: entry.onPathOrder };
      if (/\.exe$/i.test(entry.path)) {
        return { ...base, runnable: false, error: 'dsh.exe 不在安全执行白名单内，无法读取版本' };
      }
      const info = await stat(entry.path).catch(() => undefined);
      if (!info || info.size > 64 * 1024) {
        return { ...base, runnable: false, error: 'shim 文件异常（不可读或超过 64 KB）' };
      }
      const content = await readFile(entry.path, 'utf8').catch(() => '');
      const binPath = content ? resolveShimEntry(entry.path, content) : undefined;
      if (!binPath) return { ...base, runnable: false, error: '无法从 shim 解析出 JS 入口' };
      if (!probeNode) return { ...base, binPath, runnable: false, error: '没有可用于读取版本的 Node.js 运行时' };
      try {
        const { stdout } = await runCommand({ exePath: probeNode, args: [binPath, '--version'], timeoutMs: 20_000 });
        return {
          ...base,
          binPath,
          version: stdout.trim().split(/\r?\n/)[0]?.trim().replace(/^v/, ''),
          runnable: true,
        };
      } catch (error) {
        return { ...base, binPath, runnable: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return results;
}

async function probeDesktop(profileExists: boolean): Promise<{ probe: DesktopProbe; error?: string }> {
  const empty: DesktopProbe = { registryRead: false, exeExists: false, profileExists };
  try {
    // 先确认卸载注册表本身可读：键存在但查询失败(1)与“读不到”是两件事。
    const baseKey = await tryRunCommand({
      exePath: 'C:\\Windows\\System32\\reg.exe',
      args: ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
      timeoutMs: 10_000,
    });
    if (baseKey.code !== 0) {
      return {
        probe: { ...empty, registryRead: false },
        error: baseKey.timedOut
          ? '读取注册表超时'
          : `${baseKey.stdout}\n${baseKey.stderr}`.trim() || `reg query 退出码 ${baseKey.code}`,
      };
    }

    const result = await tryRunCommand({
      exePath: 'C:\\Windows\\System32\\reg.exe',
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
    // `reg query` exits 1 when no value matches; a timeout is a different fact.
    if (result.timedOut) {
      return { probe: { ...empty, registryRead: false }, error: '读取注册表超时' };
    }
    if (result.code !== 0) {
      return { probe: { ...empty, registryRead: true } };
    }
    const display = /DisplayName\s+REG_SZ\s+(.+)/i.exec(result.stdout)?.[1]?.trim();
    if (!display) return { probe: { ...empty, registryRead: true } };
    const version = /DisplayVersion\s+REG_SZ\s+(.+)/i.exec(result.stdout)?.[1]?.trim();
    const installLocation = /InstallLocation\s+REG_SZ\s+(.+)/i.exec(result.stdout)?.[1]?.trim();
    const exe = installLocation ? join(installLocation, 'DeepSeek Harness.exe') : undefined;
    const exeExists = exe ? await fileExists(exe) : await probeDesktopCommonExe();
    return {
      probe: {
        registryRead: true,
        displayName: display,
        version,
        installDir: installLocation,
        exeExists,
        profileExists,
      },
    };
  } catch (error) {
    return {
      probe: { ...empty, registryRead: false },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeDesktopCommonExe(): Promise<boolean> {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const candidates = [
    localAppData ? join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe') : undefined,
    localAppData ? join(localAppData, 'Programs', 'deepseek-harness', 'DeepSeek Harness.exe') : undefined,
    programFiles ? join(programFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe') : undefined,
    programFilesX86 ? join(programFilesX86, 'DeepSeek Harness', 'DeepSeek Harness.exe') : undefined,
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) if (await fileExists(candidate)) return true;
  return false;
}

async function probeUrl(name: string, url: string): Promise<{ name: string; url: string; ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    if ([400, 403, 405].includes(res.status)) {
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
        redirect: 'follow',
      });
    }
    const ok = res.ok || res.status === 416;
    return { name, url, ok, detail: `HTTP ${res.status}` };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeNetwork(registry: string, manifest: RuntimeManifest): Promise<NetworkProbe> {
  const primaryTargets = [
    { name: 'node-primary', url: manifest.source.url },
    { name: 'registry', url: `${registry.replace(/\/$/, '')}/-/ping` },
  ];
  const mirrorTargets = [
    ...manifest.source.mirrors.map((url, index) => ({ name: `node-mirror-${index + 1}`, url })),
    { name: 'npm-official', url: 'https://registry.npmjs.org/-/ping' },
  ];
  const [primary, mirrors] = await Promise.all([
    Promise.all(primaryTargets.map((t) => probeUrl(t.name, t.url))),
    Promise.all(mirrorTargets.map((t) => probeUrl(t.name, t.url))),
  ]);
  const targets = [...primary, ...mirrors];
  const primaryOk = primary.every((t) => t.ok);
  const mirrorOk = mirrors.some((t) => t.ok);
  return {
    primaryOk,
    mirrorOk,
    targets,
    detail: primary
      .map((t) => `${t.name}:${t.ok ? 'ok' : 'fail'}`)
      .concat(mirrors.map((t) => `${t.name}:${t.ok ? 'ok' : 'fail'}`))
      .join(' '),
  };
}

async function probeWritable(root: string): Promise<{ exists: boolean; writable: boolean; checkedPath: string }> {
  let current = resolve(root);
  let exists = await fileExists(current);
  // Walk up without creating anything: detection is strictly read-only (PRD §7.1).
  for (let i = 0; i < 12 && !exists; i += 1) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    exists = await fileExists(current);
  }
  try {
    await access(current, constants.W_OK);
    return { exists: await fileExists(root), writable: true, checkedPath: current };
  } catch {
    return { exists: await fileExists(root), writable: false, checkedPath: current };
  }
}

async function probeDisk(root: string): Promise<{ root: string; freeBytes: number }> {
  const drive = parse(resolve(root)).root || 'C:\\';
  try {
    const stats = await statfs(drive);
    return { root: drive, freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch {
    return { root: drive, freeBytes: 0 };
  }
}

function probeOs(): EnvironmentProbes['os'] {
  const systemVersion =
    (process as unknown as { getSystemVersion?: () => string }).getSystemVersion?.() ?? release();
  const major = Number(systemVersion.split('.')[0]);
  const platform = process.platform;
  return {
    platform,
    caption: `${osType()} ${systemVersion}`,
    build: release(),
    arch: arch(),
    supported: platform === 'win32' && Number.isFinite(major) && major >= 10,
  };
}

export async function probeEnvironment(options: ProbeEnvironmentOptions): Promise<EnvironmentReport> {
  const { paths, manifest, nodeMinVersion, registry } = options;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const probeErrors: { probe: string; message: string }[] = [];

  const systemNodes = await discoverNodeCandidates().catch((error: unknown) => {
    probeErrors.push({ probe: 'node-system', message: error instanceof Error ? error.message : String(error) });
    return [] as NodeProbe[];
  });

  const managedNodeFile = nodeExe(paths);
  const managedNode = await probeManagedRuntime('node-managed', managedNodeFile, managedNodeFile, () => ['-v']);
  const probeNode = managedNode?.runnable ? managedNodeFile : systemNodes.find((n) => n.runnable)?.path;

  const [managedPnpm, managedHarness] = await Promise.all([
    probeManagedRuntime('pnpm-managed', pnpmCliJs(paths), probeNode, (file) => [file, '--version']),
    probeManagedRuntime('harness-managed', dshBinJs(paths), probeNode, (file) => [file, '--version']),
  ]);

  const systemHarness = await discoverSystemHarness(probeNode).catch((error: unknown) => {
    probeErrors.push({ probe: 'harness-system', message: error instanceof Error ? error.message : String(error) });
    return [] as SystemHarnessProbe[];
  });

  const profilesDir = join(paths.dshHome, 'profiles');
  const desktopProfileExists = await fileExists(join(profilesDir, 'desktop'));
  const webProfileExists = await fileExists(join(profilesDir, BASELINE.dsh.profile));
  const homeExists = await fileExists(profilesDir);

  const desktopResult = await probeDesktop(desktopProfileExists);
  if (desktopResult.error) probeErrors.push({ probe: 'desktop', message: desktopResult.error });
  const desktop = desktopResult.probe;

  const [network, disk, writable, admin] = await Promise.all([
    probeNetwork(registry, manifest).catch((error: unknown) => {
      probeErrors.push({ probe: 'network', message: error instanceof Error ? error.message : String(error) });
      return {
        primaryOk: false,
        mirrorOk: false,
        detail: 'network probe failed',
        targets: [],
      } satisfies NetworkProbe;
    }),
    probeDisk(paths.root),
    probeWritable(paths.root),
    detectAdmin(),
  ]);

  const managedVersion = managedHarness?.runnable ? managedHarness.version : undefined;
  const pathHarness = systemHarness.find((h) => h.runnable && h.version);
  const route = detectRoute({
    managedCliVersion: managedVersion,
    pathCliVersion: pathHarness?.version,
    homeExists,
    desktopProfileExists,
    desktopRegistry:
      desktop.registryRead && desktop.displayName
        ? {
            displayName: desktop.displayName,
            installLocation: desktop.installDir,
            version: desktop.version,
          }
        : undefined,
    desktopDirExists: desktop.registryRead && desktop.displayName ? desktop.exeExists : undefined,
    dshHome: paths.dshHome,
  });

  const probes: EnvironmentProbes = {
    checkedAt,
    os: probeOs(),
    admin,
    disk,
    directories: { root: paths.root, ...writable },
    network,
    systemNodes,
    managedNode,
    managedPnpm,
    managedHarness,
    systemHarness,
    desktop,
    route,
    profiles: { home: paths.dshHome, homeExists, webExists: webProfileExists, desktopExists: desktopProfileExists },
    probeErrors,
  };

  return evaluateEnvironment(probes, {
    baseline: { node: BASELINE.node.version, pnpm: BASELINE.pnpm.version, dsh: BASELINE.dsh.version },
    nodeMinVersion,
  });
}
