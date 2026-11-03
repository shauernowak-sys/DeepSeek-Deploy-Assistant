import { join, normalize, sep } from 'node:path';

import type { InstallCheck, InstallVerification, LocateCandidate } from '@dda/spec';

import { REQUIRED_PACKAGE_FILES } from './install';

/**
 * SnowLuma 安装位置定位与只读校验（M3.3.1 第二步/第三步）。
 *
 * 产品流程调整为"用户自行从官方渠道下载安装"后，本模块负责两件事：
 *  1. **找得到**：在常见目录（含桌面/下载/文档里解压出来的 SnowLuma-v2.4.0-win-x64）里找；
 *  2. **验得准**：逐项只读校验 release.json / node.exe / index.mjs / launcher.bat / client / native，
 *     并给出实际版本。
 *
 * 只读：不写文件、不改配置、不启动进程；也不要求用户改动 SnowLuma 源码。
 * 校验结果类型定义在 `@dda/spec`（IPC 与渲染层共用同一份）。
 */

export interface LocateFsDeps {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

interface ReleaseJsonShape {
  version?: unknown;
  target?: unknown;
}

const REQUIRED_LABEL: Record<string, string> = {
  'release.json': '版本清单 release.json',
  'package.json': '包描述 package.json',
  'index.mjs': '运行时 index.mjs',
  'node.exe': '内置 Node 运行时 node.exe',
  'launcher.bat': '启动脚本 launcher.bat',
  'client/index.html': 'WebUI 静态资源 client/',
  'native/snowluma-win32-x64.node': '原生组件 native/',
};

/**
 * 校验一个安装目录。
 *
 * 若 `<dir>/release.json` 不存在，会自动下钻一层：很多用户把 zip 解压成 `…\SnowLuma-v2.4.0-win-x64\`
 * 后直接选了父目录。找到唯一候选就采用，避免让用户再去翻一层。
 */
export async function verifyInstallDir(
  deps: LocateFsDeps,
  options: { installDir: string; expectedVersion: string },
): Promise<InstallVerification> {
  const requestedDir = normalize(options.installDir);
  let installDir = requestedDir;
  let resolvedFromChild = false;

  let hasRelease = await deps.exists(join(installDir, 'release.json'));
  if (!hasRelease) {
    const children = await deps.readdir(installDir).catch(() => [] as string[]);
    const matches = children.filter((name) => /snowluma/i.test(name));
    const found: string[] = [];
    for (const name of matches.slice(0, 20)) {
      const candidate = join(installDir, name);
      if (await deps.exists(join(candidate, 'release.json'))) found.push(candidate);
    }
    if (found.length === 1) {
      installDir = found[0]!;
      resolvedFromChild = true;
      hasRelease = true;
    }
  }

  if (!hasRelease) {
    return {
      requestedDir,
      installDir: undefined,
      resolvedFromChild,
      exists: false,
      valid: false,
      expectedVersion: options.expectedVersion,
      versionMatches: false,
      checks: [],
      problems: [
        '这个目录里没有 release.json，看起来不是 SnowLuma 的安装目录（常见原因：只解压了一半、选错了层级、或解压到了别的位置）',
      ],
      hasConfig: false,
      hasData: false,
    };
  }

  const checks: InstallCheck[] = [];
  const problems: string[] = [];

  let version: string | undefined;
  let target: string | undefined;
  let releaseOk = false;
  try {
    const raw = JSON.parse(await deps.readFile(join(installDir, 'release.json'))) as ReleaseJsonShape;
    version = typeof raw.version === 'string' ? raw.version : undefined;
    target = typeof raw.target === 'string' ? raw.target : undefined;
    releaseOk = Boolean(version);
    checks.push({
      id: 'release',
      label: REQUIRED_LABEL['release.json']!,
      ok: releaseOk,
      detail: version ? `版本 ${version}${target ? ` / ${target}` : ''}` : '没有 version 字段',
    });
    if (!releaseOk) problems.push('release.json 没有 version 字段，无法确认版本');
  } catch (error) {
    checks.push({
      id: 'release',
      label: REQUIRED_LABEL['release.json']!,
      ok: false,
      detail: `无法解析：${error instanceof Error ? error.message : String(error)}`,
    });
    problems.push('release.json 无法解析（文件可能被截断或不是官方包）');
  }

  for (const relative of REQUIRED_PACKAGE_FILES) {
    if (relative === 'release.json') continue;
    const path = join(installDir, relative.replace(/\//g, sep));
    const ok = await deps.exists(path);
    checks.push({ id: relative, label: REQUIRED_LABEL[relative] ?? relative, ok });
    if (!ok) problems.push(`缺少 ${relative}`);
  }

  const versionMatches = version !== undefined && version === options.expectedVersion;
  if (version && !versionMatches) {
    problems.push(`检测到 ${version}，本产品验证过的版本是 ${options.expectedVersion}（可以继续，但 OneBot 配置与端口行为可能需要复核）`);
  }
  if (target && target !== 'win32-x64') {
    problems.push(`包内平台是 ${target}，不是 Windows x64`);
  }

  const hasConfig = await deps.exists(join(installDir, 'config'));
  const hasData = await deps.exists(join(installDir, 'data'));

  const coreOk = checks
    .filter((check) => ['release', 'node.exe', 'index.mjs', 'launcher.bat'].includes(check.id))
    .every((check) => check.ok);
  const platformOk = target === undefined || target === 'win32-x64';

  return {
    requestedDir,
    installDir,
    resolvedFromChild,
    exists: true,
    valid: releaseOk && coreOk && platformOk,
    version,
    target,
    expectedVersion: options.expectedVersion,
    versionMatches,
    checks,
    problems,
    hasConfig,
    hasData,
  };
}

interface DiscoverOptions {
  env: Record<string, string | undefined>;
  expectedVersion: string;
  /** 我们自己的受管目录（自动部署用；引导安装时也会列出来，方便升级/复用）。 */
  managedDir?: string;
  /** 用户已保存的目录优先。 */
  settingsDir?: string;
}

/**
 * 在常见位置找已安装的 SnowLuma。
 *
 * 扫描是**有界**的：只列一层子目录、每层最多 200 项，且只认名字里带 snowluma 的目录，
 * 不会递归整个磁盘（避免真实用户机器上的卡顿）。
 */
export async function discoverInstallDirs(
  deps: LocateFsDeps,
  options: DiscoverOptions,
): Promise<LocateCandidate[]> {
  const candidates: { dir: string; source: LocateCandidate['source'] }[] = [];
  const seen = new Set<string>();

  const add = (dir: string | undefined, source: LocateCandidate['source']) => {
    if (!dir) return;
    const key = normalize(dir).replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ dir, source });
  };

  add(options.settingsDir, 'settings');
  add(options.managedDir, 'managed');

  const localAppData = options.env.LOCALAPPDATA;
  const programFiles = options.env.ProgramFiles;
  const programFilesX86 = options.env['ProgramFiles(x86)'];
  const profile = options.env.USERPROFILE;

  if (localAppData) {
    add(join(localAppData, 'SnowLuma'), 'common');
    add(join(localAppData, 'Programs', 'SnowLuma'), 'common');
  }
  for (const base of [programFiles, programFilesX86]) {
    if (base) add(join(base, 'SnowLuma'), 'common');
  }
  add('C:\\SnowLuma', 'common');
  add('D:\\SnowLuma', 'common');
  if (profile) add(join(profile, 'SnowLuma'), 'common');

  // 用户最常见的落点：桌面 / 下载 / 文档 里解压出来的 SnowLuma-v2.4.0-win-x64。
  if (profile) {
    for (const folder of ['Desktop', 'Downloads', 'Documents']) {
      const base = join(profile, folder);
      const names = await deps.readdir(base).catch(() => [] as string[]);
      for (const name of names.slice(0, 200)) {
        if (!/snowluma/i.test(name)) continue;
        add(join(base, name), 'profile-scan');
      }
    }
  }

  const results: LocateCandidate[] = [];
  for (const candidate of candidates) {
    const verification = await verifyInstallDir(deps, {
      installDir: candidate.dir,
      expectedVersion: options.expectedVersion,
    });
    // 只返回"确实有 release.json"的候选；用户显式设置的目录即使无效也返回（便于解释原因）。
    if (verification.exists || candidate.source === 'settings') {
      results.push({ dir: verification.installDir ?? candidate.dir, source: candidate.source, verification });
    }
  }
  return results;
}
