import { randomUUID } from 'node:crypto';

import type {
  ComponentCandidate,
  ComponentCheck,
  ComponentDiagnosis,
  ComponentState,
  EnvReport,
  EnvironmentReport,
  EnvironmentResolution,
  Evidence,
  PrerequisiteCheck,
} from '@dda/spec';

import { compareVersions, satisfiesMin } from '../compat/matrix';
import { MIN_FREE_BYTES } from './env';
import type { EnvironmentProbes, ManagedRuntimeProbe, NodeProbe, SystemHarnessProbe } from './probes';

const NODE_LABEL = '运行环境 Node.js';
const MANAGED_NODE_LABEL = '本软件自带的 Node.js';
const PNPM_LABEL = '包管理器 pnpm';
const HARNESS_MANAGED_LABEL = 'Harness（本软件安装）';
const HARNESS_SYSTEM_LABEL = 'Harness CLI（系统已安装）';
const DESKTOP_LABEL = 'Harness Desktop（官方桌面端）';

export interface EvaluateOptions {
  baseline: { node: string; pnpm: string; dsh: string };
  nodeMinVersion: string;
}

function evidence(signal: string, ok: boolean, raw: string): Evidence {
  return { signal, ok, raw };
}

function candidateEvidence(items: ComponentCandidate[]): Evidence[] {
  if (items.length === 0) return [evidence('candidates', false, 'none')];
  return items.map((c, index) =>
    evidence(
      `candidate[${index}]`,
      c.runnable,
      `${c.path}${c.version ? ` => ${c.version}` : ''}${c.stable ? '' : ' (unstable)'}${
        c.onPathOrder === undefined ? '' : ` path#${c.onPathOrder}`
      }${c.error ? ` (${c.error})` : ''}`,
    ),
  );
}

function missingComponent(
  id: ComponentCheck['id'],
  label: string,
  required: string,
  detail: string,
  checkedAt: string,
  candidates: ComponentCandidate[] = [],
  probeError?: string,
): ComponentCheck {
  if (probeError) {
    return {
      id,
      label,
      required,
      state: 'probe-failed',
      diagnosis: 'probe-error',
      candidates,
      evidence: [evidence('probe', false, probeError)],
      detail: `无法确认：${probeError}`,
      checkedAt,
    };
  }
  return {
    id,
    label,
    required,
    state: 'missing',
    diagnosis: 'not-found',
    candidates,
    evidence: [evidence('candidates', false, 'none')],
    detail,
    checkedAt,
  };
}

function fromManaged(
  id: 'node-managed' | 'pnpm-managed' | 'harness-managed',
  label: string,
  probe: ManagedRuntimeProbe | undefined,
  expected: string,
  minVersion: string | undefined,
  checkedAt: string,
): ComponentCheck {
  const required = minVersion ? `>= ${minVersion}（锁定 ${expected}）` : `= ${expected}`;
  if (!probe) return missingComponent(id, label, required, '未安装（本软件的私有目录中不存在）', checkedAt);

  const candidates: ComponentCandidate[] = [
    {
      path: probe.path,
      version: probe.version,
      source: 'managed',
      runnable: probe.runnable,
      stable: true,
      error: probe.error,
    },
  ];
  const ev = candidateEvidence(candidates);
  if (!probe.runnable || !probe.version) {
    return {
      id,
      label,
      required,
      state: 'probe-failed',
      diagnosis: 'not-executable',
      path: probe.path,
      candidates,
      evidence: ev,
      detail: probe.error ? `文件存在但无法执行：${probe.error}` : '文件存在但无法执行',
      checkedAt,
    };
  }

  let state: ComponentState;
  let diagnosis: ComponentDiagnosis;
  if (probe.version === expected) {
    state = 'installed';
    diagnosis = 'ok';
  } else if (minVersion) {
    // 私有运行时：低于下限必须修复；低于锁定版本可以升级；高于锁定版本属于版本不符。
    state = satisfiesMin(probe.version, minVersion) ? 'upgrade-required' : 'version-mismatch';
    diagnosis = 'version-different';
  } else {
    state = compareVersions(probe.version, expected) < 0 ? 'upgrade-required' : 'version-mismatch';
    diagnosis = 'version-different';
  }

  return {
    id,
    label,
    required,
    state,
    diagnosis,
    version: probe.version,
    path: probe.path,
    candidates,
    evidence: ev,
    detail:
      state === 'installed'
        ? `已安装 ${probe.version}`
        : `已安装 ${probe.version}，与锁定版本 ${expected} 不同`,
    checkedAt,
  };
}

function systemNodeCheck(nodes: NodeProbe[], nodeMinVersion: string, checkedAt: string): ComponentCheck {
  const candidates = nodes.map<ComponentCandidate>((n) => ({
    path: n.path,
    version: n.version,
    source: n.source,
    runnable: n.runnable,
    stable: n.stable,
    onPathOrder: n.onPathOrder,
    hasNpm: n.hasNpm,
    error: n.error,
  }));
  const required = `>= ${nodeMinVersion}`;
  if (candidates.length === 0) {
    return missingComponent('node-system', NODE_LABEL, required, '系统未检测到 Node.js（PATH 与常见安装目录都没有）', checkedAt);
  }

  const runnable = candidates.filter((c) => c.runnable && c.version);
  if (runnable.length === 0) {
    return {
      id: 'node-system',
      label: NODE_LABEL,
      required,
      state: 'probe-failed',
      diagnosis: 'not-executable',
      path: candidates[0]?.path,
      candidates,
      evidence: candidateEvidence(candidates),
      detail: '检测到 Node.js 文件，但无法执行（可能已损坏或被安全软件拦截）',
      checkedAt,
    };
  }

  const belowMin = runnable.filter((c) => !satisfiesMin(c.version!, nodeMinVersion));
  const stable = runnable.filter((c) => c.stable);
  const chosen = stable[0] ?? runnable[0]!;
  const state: ComponentState = belowMin.length === runnable.length ? 'version-mismatch' : 'installed';
  const diagnosis: ComponentDiagnosis =
    state === 'version-mismatch'
      ? 'version-too-low'
      : stable.length === 0
        ? 'unstable-path'
        : stable.length > 1
          ? 'multiple-versions'
          : 'ok';

  return {
    id: 'node-system',
    label: NODE_LABEL,
    required,
    state,
    diagnosis,
    version: chosen.version,
    path: chosen.path,
    candidates,
    evidence: candidateEvidence(candidates),
    detail:
      state === 'version-mismatch'
        ? `已安装 ${chosen.version}，低于要求 ${nodeMinVersion}（不会改动你已有的 Node）`
        : diagnosis === 'unstable-path'
          ? `已安装 ${chosen.version}，但来自版本管理器/临时路径，默认不复用`
          : diagnosis === 'multiple-versions'
            ? `检测到 ${stable.length} 个可用版本，需要确认使用哪一个`
            : `已安装 ${chosen.version}（${chosen.path}）`,
    checkedAt,
  };
}

function systemHarnessCheck(items: SystemHarnessProbe[], expected: string, checkedAt: string): ComponentCheck {
  const required = `= ${expected}`;
  const candidates = items.map<ComponentCandidate>((h) => ({
    path: h.binPath ?? h.path,
    version: h.version,
    source: 'path',
    runnable: h.runnable,
    stable: h.stable,
    onPathOrder: h.onPathOrder,
    error: h.error,
  }));
  if (candidates.length === 0) {
    return missingComponent('harness-system', HARNESS_SYSTEM_LABEL, required, 'PATH 中未检测到 Harness CLI', checkedAt);
  }

  const runnable = candidates.filter((c) => c.runnable && c.version);
  if (runnable.length === 0) {
    return {
      id: 'harness-system',
      label: HARNESS_SYSTEM_LABEL,
      required,
      state: 'probe-failed',
      diagnosis: 'not-executable',
      path: candidates[0]?.path,
      candidates,
      evidence: candidateEvidence(candidates),
      detail: '检测到 Harness CLI 入口，但无法在没有 shell 的情况下执行或读取版本',
      checkedAt,
    };
  }

  const exact = runnable.filter((c) => c.version === expected);
  const chosen = exact[0] ?? runnable[0]!;
  const state: ComponentState = exact.length > 0 ? 'installed' : 'version-mismatch';
  return {
    id: 'harness-system',
    label: HARNESS_SYSTEM_LABEL,
    required,
    state,
    diagnosis: exact.length > 0 ? (runnable.length > 1 ? 'multiple-versions' : 'ok') : 'version-different',
    version: chosen.version,
    path: chosen.path,
    candidates,
    evidence: candidateEvidence(candidates),
    detail:
      state === 'installed'
        ? `已安装 ${chosen.version}，可直接复用`
        : `已安装 ${chosen.version}，与锁定版本 ${expected} 不同（不会覆盖它）`,
    checkedAt,
  };
}

function desktopCheck(
  probe: EnvironmentProbes['desktop'],
  probeError: string | undefined,
  checkedAt: string,
): ComponentCheck {
  const required = '官方桌面端（只读识别）';
  if (!probe) {
    return missingComponent(
      'harness-desktop',
      DESKTOP_LABEL,
      required,
      '未检测到官方桌面端',
      checkedAt,
      [],
      probeError,
    );
  }
  if (!probe.registryRead) {
    return {
      id: 'harness-desktop',
      label: DESKTOP_LABEL,
      required,
      state: 'probe-failed',
      diagnosis: 'probe-error',
      candidates: [],
      evidence: [evidence('registry', false, probe.error ?? 'unreadable')],
      detail: '无法读取卸载注册表，不能确认是否安装了桌面端',
      checkedAt,
    };
  }
  if (!probe.displayName) {
    return missingComponent('harness-desktop', DESKTOP_LABEL, required, '未检测到官方桌面端', checkedAt);
  }
  const candidate: ComponentCandidate = {
    path: probe.installDir ?? probe.displayName,
    version: probe.version,
    source: 'registry',
    runnable: probe.exeExists,
    stable: true,
    error: probe.exeExists ? undefined : 'install-dir-missing',
  };
  if (!probe.exeExists) {
    return {
      id: 'harness-desktop',
      label: DESKTOP_LABEL,
      required,
      state: 'probe-failed',
      diagnosis: 'ambiguous',
      version: probe.version,
      path: probe.installDir,
      candidates: [candidate],
      evidence: candidateEvidence([candidate]),
      detail: '注册表记录了桌面端，但安装目录中找不到主程序（状态无法确认）',
      checkedAt,
    };
  }
  return {
    id: 'harness-desktop',
    label: DESKTOP_LABEL,
    required,
    state: 'installed',
    diagnosis: 'ok',
    version: probe.version,
    path: probe.installDir,
    candidates: [candidate],
    evidence: candidateEvidence([candidate]),
    detail: `已安装${probe.version ? ` ${probe.version}` : ''}（不会被修改）`,
    checkedAt,
  };
}

function prerequisites(p: EnvironmentProbes): PrerequisiteCheck[] {
  const at = p.checkedAt;
  const osOk = p.os.supported;
  const diskOk = p.disk.freeBytes >= MIN_FREE_BYTES;
  const networkState = p.network.primaryOk
    ? 'primary-available'
    : p.network.mirrorOk
      ? 'mirror-only'
      : 'unavailable';
  return [
    {
      id: 'os',
      label: 'Windows 版本与架构',
      ok: osOk,
      state: osOk ? 'supported' : 'unsupported',
      detail: osOk ? `${p.os.caption} · ${p.os.arch}` : `不支持的平台：${p.os.caption} · ${p.os.arch}`,
      evidence: [evidence('os', osOk, `${p.os.platform} ${p.os.caption} build=${p.os.build} arch=${p.os.arch}`)],
      checkedAt: at,
    },
    {
      id: 'disk',
      label: '磁盘空间',
      ok: diskOk,
      state: diskOk ? 'sufficient' : 'insufficient',
      detail: `${p.disk.root} 可用 ${(p.disk.freeBytes / 1024 ** 3).toFixed(1)} GB（至少需要 ${MIN_FREE_BYTES / 1024 ** 3} GB）`,
      evidence: [
        evidence('disk.freeBytes', diskOk, String(p.disk.freeBytes)),
        evidence('disk.root', true, p.disk.root),
      ],
      checkedAt: at,
    },
    {
      id: 'permissions',
      label: '权限',
      ok: true,
      state: p.admin ? 'elevated' : 'standard',
      detail: p.admin ? '当前以管理员身份运行（本软件不需要管理员权限）' : '普通用户（正常，本软件不需要管理员权限）',
      evidence: [evidence('admin', true, String(p.admin))],
      checkedAt: at,
    },
    {
      id: 'network',
      label: '网络与下载源',
      ok: p.network.primaryOk || p.network.mirrorOk,
      state: networkState,
      detail:
        networkState === 'primary-available'
          ? '主源可用'
          : networkState === 'mirror-only'
            ? '主源不可用，备用镜像可用'
            : '主源与镜像均不可用',
      evidence: [
        evidence('network.primary', p.network.primaryOk, p.network.detail),
        ...p.network.targets.map((t) => evidence(`network.${t.name}`, t.ok, `${t.url} ${t.detail}`)),
      ],
      checkedAt: at,
    },
    {
      id: 'directories',
      label: '安装目录可写',
      ok: p.directories.writable,
      state: p.directories.writable ? 'writable' : 'unwritable',
      detail: p.directories.writable
        ? `可写入：${p.directories.checkedPath}`
        : `无法写入：${p.directories.checkedPath}`,
      evidence: [
        evidence('dir.root', true, p.directories.root),
        evidence('dir.exists', p.directories.exists, String(p.directories.exists)),
        evidence('dir.writable', p.directories.writable, p.directories.checkedPath),
      ],
      checkedAt: at,
    },
  ];
}

export function evaluateEnvironment(probes: EnvironmentProbes, options: EvaluateOptions): EnvironmentReport {
  const at = probes.checkedAt;
  const probeError = (name: string): string | undefined => probes.probeErrors.find((e) => e.probe === name)?.message;

  const components: ComponentCheck[] = [
    systemNodeCheck(probes.systemNodes, options.nodeMinVersion, at),
    fromManaged('node-managed', MANAGED_NODE_LABEL, probes.managedNode, options.baseline.node, options.nodeMinVersion, at),
    fromManaged('pnpm-managed', PNPM_LABEL, probes.managedPnpm, options.baseline.pnpm, undefined, at),
    fromManaged('harness-managed', HARNESS_MANAGED_LABEL, probes.managedHarness, options.baseline.dsh, undefined, at),
    systemHarnessCheck(probes.systemHarness, options.baseline.dsh, at),
    desktopCheck(probes.desktop, probeError('desktop'), at),
  ];

  const nodeSystem = components.find((c) => c.id === 'node-system')!;
  const nodeManaged = components.find((c) => c.id === 'node-managed')!;
  const harnessManaged = components.find((c) => c.id === 'harness-managed')!;
  const harnessSystem = components.find((c) => c.id === 'harness-system')!;

  const reusableNodes = (nodeSystem.candidates ?? []).filter(
    (c) => c.runnable && c.stable && c.version && satisfiesMin(c.version, options.nodeMinVersion),
  );
  const reusableNode = reusableNodes[0];
  const pathNode = nodeSystem.candidates.find((c) => c.onPathOrder !== undefined && c.runnable);

  const reusableHarness = harnessSystem.candidates.find(
    (c) => c.runnable && c.stable && c.version === options.baseline.dsh,
  );
  const systemHarnessProbe = reusableHarness
    ? probes.systemHarness.find((h) => (h.binPath ?? h.path) === reusableHarness.path && h.runnable)
    : undefined;

  const managedNodeVersion = nodeManaged.state === 'installed' ? nodeManaged.version : undefined;
  const managedHarnessVersion = harnessManaged.state === 'installed' ? harnessManaged.version : undefined;

  const resolution: EnvironmentResolution = {
    pathNode: pathNode ? { path: pathNode.path, version: pathNode.version } : undefined,
    reusableSystemNode: reusableNode ? { path: reusableNode.path, version: reusableNode.version! } : undefined,
    managedNode: probes.managedNode ? { path: probes.managedNode.path, version: probes.managedNode.version } : undefined,
    managedHarness: probes.managedHarness
      ? { path: probes.managedHarness.path, version: probes.managedHarness.version }
      : undefined,
    reusableSystemHarness:
      systemHarnessProbe?.binPath && reusableHarness?.version
        ? { path: systemHarnessProbe.path, binPath: systemHarnessProbe.binPath, version: reusableHarness.version }
        : undefined,
    desktopProfileExists: probes.profiles.desktopExists,
    profiles: {
      home: probes.profiles.home,
      homeExists: probes.profiles.homeExists,
      webExists: probes.profiles.webExists,
      desktopExists: probes.profiles.desktopExists,
    },
    activeNode:
      managedNodeVersion !== undefined
        ? { mode: 'managed', path: nodeManaged.path, version: managedNodeVersion }
        : reusableNode
          ? { mode: 'system', path: reusableNode.path, version: reusableNode.version }
          : { mode: 'none' },
    activeHarness:
      managedHarnessVersion !== undefined
        ? { mode: 'managed', path: harnessManaged.path, version: managedHarnessVersion }
        : systemHarnessProbe?.binPath && reusableHarness?.version
          ? { mode: 'system', path: systemHarnessProbe.binPath, version: reusableHarness.version }
          : { mode: 'none' },
  };

  const runtimes = [
    probes.managedNode
      ? { id: 'node' as const, installed: probes.managedNode.runnable, version: probes.managedNode.version, path: probes.managedNode.path }
      : { id: 'node' as const, installed: false },
    probes.managedPnpm
      ? { id: 'pnpm' as const, installed: probes.managedPnpm.runnable, version: probes.managedPnpm.version, path: probes.managedPnpm.path }
      : { id: 'pnpm' as const, installed: false },
    probes.managedHarness
      ? { id: 'dsh' as const, installed: probes.managedHarness.runnable, version: probes.managedHarness.version, path: probes.managedHarness.path }
      : { id: 'dsh' as const, installed: false },
  ];

  const base: EnvReport = {
    os: {
      caption: probes.os.caption,
      build: probes.os.build,
      arch: probes.os.arch,
      admin: probes.admin,
    },
    diskFreeBytes: probes.disk.freeBytes,
    runtimes,
    route: probes.route,
    checkedAt: at,
  };

  return {
    ...base,
    schemaVersion: 2,
    scanId: randomUUID(),
    components,
    prerequisites: prerequisites(probes),
    resolution,
    probeErrors: probes.probeErrors,
  };
}

export function componentById(report: EnvironmentReport, id: ComponentCheck['id']): ComponentCheck {
  const found = report.components.find((c) => c.id === id);
  if (!found) throw new Error(`环境报告缺少组件 ${id}`);
  return found;
}
