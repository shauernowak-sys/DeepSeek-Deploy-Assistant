import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import type {
  ComponentCheck,
  ComponentDecision,
  DecisionAction,
  DecisionOption,
  DecisionPreferences,
  EnvironmentReport,
  InstallationDecision,
  PrerequisiteCheck,
  RuntimeSelection,
} from '@dda/spec';

import { compareVersions, satisfiesMin } from '../compat/matrix';
import { componentById } from '../detect/evaluate';

export interface DecideTargets {
  managedNodeExe: string;
  managedNodeDir: string;
  managedHarnessBin: string;
}

export interface DecideOptions {
  baseline: { node: string; pnpm: string; dsh: string };
  nodeMinVersion: string;
  targets: DecideTargets;
  preferences?: DecisionPreferences;
  now?: () => Date;
}

const ACTION_PRIORITY: DecisionAction[] = ['BLOCKED', 'CONFIRM_REQUIRED', 'REPAIR', 'UPGRADE', 'INSTALL', 'REUSE'];

function priority(action: DecisionAction): number {
  return ACTION_PRIORITY.indexOf(action);
}

function overallOf(components: ComponentDecision[]): DecisionAction {
  return components.reduce<DecisionAction>(
    (worst, c) => (priority(c.action) < priority(worst) ? c.action : worst),
    'REUSE',
  );
}

function baseDecision(
  component: ComponentCheck,
  action: DecisionAction,
  reason: string,
  extra: Partial<ComponentDecision> = {},
): ComponentDecision {
  return {
    component: component.id,
    label: component.label,
    action,
    state: component.state,
    current: component.version || component.path ? { version: component.version, path: component.path } : undefined,
    reason,
    evidence: component.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.signal} = ${e.raw}`),
    impacts: [],
    requiresAdmin: false,
    requiresNetwork: false,
    requiresConfirmation: true,
    recovery: '重新检测环境后可重试；本操作不会修改本软件之外的任何配置。',
    ...extra,
  };
}

const MANAGED_IMPACT = '仅本软件数据目录内的私有运行时；不修改系统 Node、PATH、系统环境变量或用户已有的 Harness 配置。';

function usableNodes(report: EnvironmentReport, min: string) {
  return componentById(report, 'node-system').candidates.filter(
    (c) => c.runnable && c.stable && c.version && c.hasNpm !== false && satisfiesMin(c.version, min),
  );
}

function allRunnableNodes(report: EnvironmentReport) {
  return componentById(report, 'node-system').candidates.filter((c) => c.runnable && c.version);
}

function nodeDecision(
  report: EnvironmentReport,
  options: DecideOptions,
  preferences: DecisionPreferences,
): { decision: ComponentDecision; selection: RuntimeSelection['node'] | null; options: DecisionOption[] } {
  const check = componentById(report, 'node-system');
  const managed = componentById(report, 'node-managed');
  const pref = preferences.node ?? 'auto';
  const usable = usableNodes(report, options.nodeMinVersion);
  const chosen =
    usable.find((c) => c.path === preferences.nodePath) ?? (usable.length === 1 ? usable[0] : undefined);

  const managedSelection: RuntimeSelection['node'] = {
    mode: 'managed',
    exe: options.targets.managedNodeExe,
    version: options.baseline.node,
    dir: options.targets.managedNodeDir,
  };

  // 用户显式选择私有运行时：不碰系统 Node。
  if (pref === 'private') {
    if (managed.state === 'installed') {
      return {
        decision: baseDecision(managed, 'REUSE', `继续使用本软件已安装的 Node ${managed.version ?? ''}`),
        selection: { ...managedSelection, version: managed.version },
        options: [],
      };
    }
    if (managed.state === 'missing') {
      return {
        decision: baseDecision(managed, 'INSTALL', `安装私有 Node ${options.baseline.node}（隔离模式）`, {
          requiresNetwork: true,
          impacts: [MANAGED_IMPACT],
          recovery: '下载/解压失败不会触碰系统 Node；重新检测后可重试。',
        }),
        selection: managedSelection,
        options: [],
      };
    }
    return {
      decision: baseDecision(
        managed,
        managed.state === 'probe-failed' ? 'REPAIR' : 'UPGRADE',
        `本软件自己的 Node ${managed.version ?? ''} 需要${managed.state === 'probe-failed' ? '修复' : '升级'}到 ${options.baseline.node}`,
        {
          requiresNetwork: true,
          impacts: [MANAGED_IMPACT],
          recovery: '只替换本软件私有目录；系统 Node 不受影响。',
        },
      ),
      selection: { ...managedSelection, version: options.baseline.node },
      options: [],
    };
  }

  // 用户显式选择系统运行时。
  if (pref === 'system') {
    if (chosen?.version) {
      return {
        decision: baseDecision(check, 'REUSE', `复用系统 Node ${chosen.version}（只读，不修改）`, {
          target: { version: chosen.version, path: chosen.path },
        }),
        selection: { mode: 'system', exe: chosen.path, version: chosen.version, dir: dirname(chosen.path) },
        options: [],
      };
    }
    if (usable.length > 1) {
      return {
        decision: baseDecision(
          check,
          'CONFIRM_REQUIRED',
          `检测到 ${usable.length} 个可用的系统 Node，需要确认使用哪一个`,
        ),
        selection: null,
        options: usable.map((c, index) => ({
          id: `node-${index}`,
          label: `使用系统 Node ${c.version}`,
          description: c.path,
          preferences: { ...preferences, node: 'system' as const, nodePath: c.path },
        })),
      };
    }
    return {
      decision: baseDecision(check, 'CONFIRM_REQUIRED', '所选系统 Node 不满足复用条件，需要重新选择'),
      selection: null,
      options: [
        {
          id: 'node-private',
          label: `改用本软件自带的 Node ${options.baseline.node}`,
          description: '不会修改系统 Node',
          preferences: { ...preferences, node: 'private' as const, nodePath: undefined },
        },
      ],
    };
  }

  // auto：已有可用的私有运行时优先（无需再装）。
  if (managed.state === 'installed') {
    return {
      decision: baseDecision(managed, 'REUSE', `继续使用本软件已安装的 Node ${managed.version ?? ''}`),
      selection: { ...managedSelection, version: managed.version },
      options: [],
    };
  }
  if (managed.state === 'upgrade-required' || managed.state === 'version-mismatch' || managed.state === 'probe-failed') {
    const action: DecisionAction = managed.state === 'upgrade-required' ? 'UPGRADE' : 'REPAIR';
    return {
      decision: baseDecision(
        managed,
        action,
        `本软件自己的 Node ${managed.version ?? ''} 需要${action === 'UPGRADE' ? '升级' : '修复'}到 ${options.baseline.node}`,
        {
          requiresNetwork: true,
          impacts: [MANAGED_IMPACT],
          recovery: '只替换本软件私有目录；系统 Node 不受影响。',
        },
      ),
      selection: { ...managedSelection, version: options.baseline.node },
      options: [],
    };
  }

  // 私有运行时不存在：优先复用系统 Node（D-1/D-6）。
  if (usable.length > 1) {
    return {
      decision: baseDecision(
        check,
        'CONFIRM_REQUIRED',
        `检测到 ${usable.length} 个可用系统 Node；默认不复用多版本环境，请确认使用哪一个（或改用私有运行时）`,
      ),
      selection: null,
      options: [
        ...usable.map((c, index) => ({
          id: `node-${index}`,
          label: `使用系统 Node ${c.version}`,
          description: c.path,
          preferences: { ...preferences, node: 'system' as const, nodePath: c.path },
        })),
        {
          id: 'node-private',
          label: `安装本软件自带的 Node ${options.baseline.node}`,
          description: '不动你已有的 Node，隔离运行',
          preferences: { ...preferences, node: 'private' as const, nodePath: undefined },
        },
      ],
    };
  }
  if (chosen?.version) {
    return {
      decision: baseDecision(check, 'REUSE', `复用系统 Node ${chosen.version}（版本、可执行性、路径稳定性均满足 D-6）`, {
        target: { version: chosen.version, path: chosen.path },
      }),
      selection: { mode: 'system', exe: chosen.path, version: chosen.version, dir: dirname(chosen.path) },
      options: [],
    };
  }

  const runnable = allRunnableNodes(report);
  const missingNpm = runnable.length > 0 && runnable.every((c) => c.hasNpm === false);
  const reason =
    check.state === 'version-mismatch'
      ? `系统 Node ${check.version ?? ''} 低于 ${options.nodeMinVersion}，将安装私有运行时（不会动你已有的 Node）`
      : check.state === 'probe-failed'
        ? '无法确认系统 Node 状态，将安装私有运行时（不会动你已有的 Node）'
        : missingNpm
          ? '系统 Node 缺少 npm，无法用它安装私有 pnpm；将安装私有运行时（不会动你已有的 Node）'
          : runnable.length > 0
            ? '系统 Node 来自版本管理器/临时路径，默认不复用，将安装私有运行时'
            : '未检测到系统 Node，将安装私有运行时';

  return {
    decision: baseDecision(check, 'INSTALL', reason, {
      requiresNetwork: true,
      impacts: [MANAGED_IMPACT],
      recovery: '下载/解压失败不会触碰系统 Node；重新检测后可重试。',
    }),
    selection: managedSelection,
    options: [],
  };
}

function harnessDecision(
  report: EnvironmentReport,
  options: DecideOptions,
  preferences: DecisionPreferences,
): { decision: ComponentDecision; selection: RuntimeSelection['harness'] | null; options: DecisionOption[] } {
  const managed = componentById(report, 'harness-managed');
  const system = componentById(report, 'harness-system');
  const pref = preferences.harness ?? 'auto';
  const expected = options.baseline.dsh;
  const reusable = system.candidates.filter((c) => c.runnable && c.stable && c.version === expected);
  const chosen = reusable.find((c) => c.path === preferences.harnessPath) ?? (reusable.length === 1 ? reusable[0] : undefined);

  const managedSelection: RuntimeSelection['harness'] = {
    mode: 'managed',
    bin: options.targets.managedHarnessBin,
    version: expected,
  };

  const systemSelection = (candidate = chosen): RuntimeSelection['harness'] | null =>
    candidate?.path && candidate.version
      ? { mode: 'system', bin: candidate.path, version: candidate.version }
      : null;

  if (pref === 'system') {
    if (chosen?.version) {
      const selection = systemSelection();
      if (!selection) {
        return {
          decision: baseDecision(system, 'CONFIRM_REQUIRED', '系统 Harness 入口无法解析为可执行文件，需要重新选择'),
          selection: null,
          options: [
            {
              id: 'harness-private',
              label: `安装本软件自带的 Harness ${expected}`,
              description: '不会覆盖或修改已有的 Harness',
              preferences: { ...preferences, harness: 'private', harnessPath: undefined },
            },
          ],
        };
      }
      return {
        decision: baseDecision(system, 'REUSE', `复用系统已安装的 Harness ${chosen.version}（只读，不修改其配置）`, {
          target: { version: chosen.version, path: chosen.path },
        }),
        selection,
        options: [],
      };
    }
    if (reusable.length > 1) {
      return {
        decision: baseDecision(system, 'CONFIRM_REQUIRED', `检测到 ${reusable.length} 个可复用的 Harness，需要确认使用哪一个`),
        selection: null,
        options: reusable.map((c, index) => ({
          id: `harness-${index}`,
          label: `使用 ${c.version}`,
          description: c.path,
          preferences: { ...preferences, harness: 'system', harnessPath: c.path },
        })),
      };
    }
    return {
      decision: baseDecision(system, 'CONFIRM_REQUIRED', '所选 Harness 不满足复用条件，需要重新选择'),
      selection: null,
      options: [
        {
          id: 'harness-private',
          label: `安装本软件自带的 Harness ${expected}`,
          description: '不会覆盖或修改已有的 Harness',
          preferences: { ...preferences, harness: 'private', harnessPath: undefined },
        },
      ],
    };
  }

  if (pref === 'private') {
    if (managed.state === 'installed') {
      return {
        decision: baseDecision(managed, 'REUSE', `继续使用本软件已安装的 Harness ${managed.version ?? ''}`),
        selection: { ...managedSelection, version: managed.version },
        options: [],
      };
    }
    if (managed.state === 'missing') {
      return {
        decision: baseDecision(managed, 'INSTALL', `安装 Harness ${expected} 到本软件私有目录`, {
          requiresNetwork: true,
          impacts: [MANAGED_IMPACT, '本软件自己的 web profile（不会修改 desktop profile）'],
          recovery: '失败时可按步骤重试；取消清理只删除本次创建的内容。',
        }),
        selection: managedSelection,
        options: [],
      };
    }
    return {
      decision: baseDecision(
        managed,
        managed.state === 'probe-failed' ? 'REPAIR' : 'UPGRADE',
        `本软件自己的 Harness ${managed.version ?? ''} 需要${managed.state === 'probe-failed' ? '修复' : '升级'}到 ${expected}`,
        {
          requiresNetwork: true,
          impacts: [MANAGED_IMPACT],
          recovery: '只替换本软件私有目录；用户已有的 Harness 不受影响。',
        },
      ),
      selection: { ...managedSelection, version: options.baseline.dsh },
      options: [],
    };
  }

  // auto
  if (managed.state === 'installed') {
    return {
      decision: baseDecision(managed, 'REUSE', `继续使用本软件已安装的 Harness ${managed.version ?? ''}`),
      selection: { ...managedSelection, version: managed.version },
      options: [],
    };
  }
  if (managed.state === 'upgrade-required') {
    return {
      decision: baseDecision(managed, 'UPGRADE', `将本软件自己的 Harness 升级到 ${expected}`, {
        requiresNetwork: true,
        impacts: [MANAGED_IMPACT],
        recovery: '只替换本软件私有目录；失败可重试。',
      }),
      selection: { ...managedSelection, version: options.baseline.dsh },
      options: [],
    };
  }
  if (managed.state === 'version-mismatch') {
    // 本软件目录里存在不同（通常更新）的版本：降级必须由用户确认（B-5）。
    return {
      decision: baseDecision(managed, 'CONFIRM_REQUIRED', `本软件目录中已有 Harness ${managed.version ?? ''}，与锁定版本 ${expected} 不同，需要确认是否替换`),
      selection: null,
      options: [
        {
          id: 'harness-private',
          label: `替换为本软件锁定的 Harness ${expected}`,
          description: '仅替换本软件私有目录，不影响你另外安装的 Harness',
          preferences: { ...preferences, harness: 'private', harnessPath: undefined },
        },
        ...(reusable[0]
          ? [
              {
                id: 'harness-system',
                label: `改用系统 Harness ${reusable[0].version}`,
                description: reusable[0].path,
                preferences: { ...preferences, harness: 'system' as const, harnessPath: reusable[0].path },
              },
            ]
          : []),
      ],
    };
  }
  if (managed.state === 'probe-failed') {
    return {
      decision: baseDecision(managed, 'REPAIR', '本软件自己的 Harness 文件存在但无法执行，需要修复', {
        requiresNetwork: true,
        impacts: [MANAGED_IMPACT],
        recovery: '只替换本软件私有目录；失败可重试。',
      }),
      selection: { ...managedSelection, version: options.baseline.dsh },
      options: [],
    };
  }

  // 本软件未安装：优先复用系统 CLI（D-1）。
  if (reusable.length > 1) {
    return {
      decision: baseDecision(system, 'CONFIRM_REQUIRED', `检测到 ${reusable.length} 个可复用的系统 Harness，需要确认使用哪一个`),
      selection: null,
      options: [
        ...reusable.map((c, index) => ({
          id: `harness-${index}`,
          label: `复用系统 Harness ${c.version}`,
          description: c.path,
          preferences: { ...preferences, harness: 'system' as const, harnessPath: c.path },
        })),
        {
          id: 'harness-private',
          label: `安装本软件自带的 Harness ${expected}`,
          description: '不动你已有的 Harness',
          preferences: { ...preferences, harness: 'private', harnessPath: undefined },
        },
      ],
    };
  }
  if (chosen?.version) {
    const selection = systemSelection();
    if (selection) {
      return {
        decision: baseDecision(system, 'REUSE', `复用系统已安装的 Harness ${chosen.version}（版本与锁定版本一致）`, {
          target: { version: chosen.version, path: chosen.path },
        }),
        selection,
        options: [],
      };
    }
  }

  const reason =
    system.state === 'version-mismatch'
      ? `系统已有 Harness ${system.version ?? ''}，与锁定版本 ${expected} 不同；将安装隔离副本，不覆盖它`
      : system.state === 'probe-failed'
        ? '无法确认系统 Harness 状态；将安装隔离副本，不覆盖任何已有安装'
        : `未检测到可复用的 Harness，将安装 ${expected}`;
  return {
    decision: baseDecision(managed, 'INSTALL', reason, {
      requiresNetwork: true,
      impacts: [MANAGED_IMPACT, '本软件自己的 web profile（不会修改 desktop profile）'],
      recovery: '失败时可按步骤重试；取消清理只删除本次创建的内容。',
    }),
    selection: managedSelection,
    options: [],
  };
}

function pnpmDecision(report: EnvironmentReport, options: DecideOptions): ComponentDecision {
  const check = componentById(report, 'pnpm-managed');
  const target = options.baseline.pnpm;
  if (check.state === 'installed') {
    return baseDecision(check, 'REUSE', `继续使用本软件已有的 pnpm ${check.version ?? ''}`);
  }
  if (check.state === 'missing') {
    return baseDecision(check, 'INSTALL', `安装 pnpm ${target} 到本软件私有目录`, {
      requiresNetwork: true,
      impacts: [MANAGED_IMPACT],
      recovery: '只写入本软件私有目录；失败可重试。',
    });
  }
  return baseDecision(
    check,
    check.state === 'upgrade-required' ? 'UPGRADE' : 'REPAIR',
    `本软件自己的 pnpm ${check.version ?? ''} 需要${check.state === 'upgrade-required' ? '升级' : '修复'}到 ${target}`,
    {
      requiresNetwork: true,
      impacts: [MANAGED_IMPACT],
      recovery: '只替换本软件私有目录；失败可重试。',
    },
  );
}

function desktopDecision(report: EnvironmentReport): ComponentDecision {
  const check = componentById(report, 'harness-desktop');
  if (check.state === 'installed') {
    return baseDecision(
      check,
      'REUSE',
      `检测到官方桌面端${check.version ? ` ${check.version}` : ''}；不会被启动或修改，也不写入 desktop profile`,
      { impacts: [] },
    );
  }
  if (check.state === 'probe-failed') {
    return baseDecision(check, 'REUSE', '桌面端状态无法确认；本软件不会安装或修改它，只使用自己的 web profile', {
      impacts: [],
    });
  }
  return baseDecision(check, 'REUSE', '未检测到官方桌面端；本软件不安装、不修改它');
}

function routeDecision(
  report: EnvironmentReport,
  preferences: DecisionPreferences,
): { decision: ComponentDecision; options: DecisionOption[] } {
  const kind = report.route.kind;
  if (kind === 'unknown') {
    return {
      decision: {
        component: 'route',
        label: 'Harness 安装路线',
        action: 'BLOCKED',
        state: 'probe-failed',
        reason: '已有安装的信号互相矛盾（例如注册表有记录但目录缺失），无法确认当前状态',
        evidence: report.route.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.signal} = ${e.raw}`),
        impacts: [],
        requiresAdmin: false,
        requiresNetwork: false,
        requiresConfirmation: false,
        recovery: '请先在系统里确认/修复已有 Harness，或手动移除残留的卸载注册表项后重新检测。',
      },
      options: [],
    };
  }
  if (kind === 'multiple' && !preferences.routeAcknowledged) {
    return {
      decision: {
        component: 'route',
        label: 'Harness 安装路线',
        action: 'CONFIRM_REQUIRED',
        state: 'installed',
        reason: '检测到 CLI 与 Desktop 同时存在；本工具只使用/创建 web profile，不会修改 desktop profile',
        evidence: report.route.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.signal} = ${e.raw}`),
        impacts: [],
        requiresAdmin: false,
        requiresNetwork: false,
        requiresConfirmation: true,
        recovery: '如需在 Desktop 中操作，请直接使用官方桌面端。',
      },
      options: [
        {
          id: 'route-ack',
          label: '我已知晓，继续（不修改 Desktop）',
          description: '继续使用 web profile；Desktop 与 desktop profile 保持不变',
          preferences: { ...preferences, routeAcknowledged: true },
        },
      ],
    };
  }
  const label =
    kind === 'none'
      ? '尚未安装 Harness'
      : kind === 'desktop'
        ? '仅检测到 Desktop'
        : kind === 'multiple'
          ? 'CLI 与 Desktop 并存（已确认）'
          : '已安装 CLI';
  return {
    decision: {
      component: 'route',
      label: 'Harness 安装路线',
      action: 'REUSE',
      state: 'installed',
      reason: label,
      evidence: report.route.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.signal} = ${e.raw}`),
      impacts: [],
      requiresAdmin: false,
      requiresNetwork: false,
      requiresConfirmation: true,
      recovery: '重新检测可刷新路线判断。',
    },
    options: [],
  };
}

function prerequisiteDecision(check: PrerequisiteCheck): ComponentDecision {
  return {
    component: `prerequisite:${check.id}`,
    label: check.label,
    action: check.ok ? 'REUSE' : 'BLOCKED',
    state: check.ok ? 'installed' : 'probe-failed',
    reason: check.detail,
    evidence: check.evidence.map((e) => `${e.ok ? '✓' : '✗'} ${e.signal} = ${e.raw}`),
    impacts: [],
    requiresAdmin: false,
    requiresNetwork: check.id === 'network',
    requiresConfirmation: !check.ok,
    recovery: check.ok ? '无需处理。' : '按界面提示处理后重新检测。',
  };
}

export function decideInstallation(report: EnvironmentReport, options: DecideOptions): InstallationDecision {
  const preferences = options.preferences ?? {};
  const generatedAt = (options.now?.() ?? new Date()).toISOString();

  const route = routeDecision(report, preferences);
  const node = nodeDecision(report, options, preferences);
  const harness = harnessDecision(report, options, preferences);
  const pnpm = pnpmDecision(report, options);
  const desktop = desktopDecision(report);

  const coreDecisions: ComponentDecision[] = [route.decision, node.decision, pnpm, harness.decision, desktop];

  // 网络是安装/修复的必要条件；纯复用不需要联网。
  const requiresNetwork = coreDecisions.some(
    (c) => c.requiresNetwork && ['INSTALL', 'UPGRADE', 'REPAIR'].includes(c.action),
  );
  const prereqs = report.prerequisites.map((p): ComponentDecision => {
    if (p.id === 'network' && !p.ok && !requiresNetwork) {
      return {
        ...prerequisiteDecision(p),
        action: 'REUSE',
        reason: '当前离线，但本次全部复用已有环境，不需要联网（不影响部署）',
      };
    }
    return prerequisiteDecision(p);
  });

  const componentDecisions: ComponentDecision[] = [...coreDecisions, ...prereqs];

  const optionsList: DecisionOption[] = [...route.options, ...node.options, ...harness.options];
  const blockers = componentDecisions.filter((c) => c.action === 'BLOCKED');

  const network = report.prerequisites.find((p) => p.id === 'network');
  const warnings: string[] = [];
  if (network && network.state === 'mirror-only') {
    warnings.push('主下载源不可用，部署将使用备用镜像（速度可能较慢）。');
  }
  if (report.probeErrors.length > 0) {
    warnings.push(`有 ${report.probeErrors.length} 项检测未能完成；未完成的项目不会被当作「未安装」。`);
  }
  if (report.os.admin) {
    warnings.push('当前以管理员身份运行；本软件不需要管理员权限，也不会修改系统级配置。');
  }

  const blocked = blockers.length > 0;
  const needsChoice = !blocked && optionsList.length > 0;
  const overall = blocked ? 'BLOCKED' : needsChoice ? 'CONFIRM_REQUIRED' : overallOf(componentDecisions);
  const deployable = !blocked && !needsChoice;
  const runtime: RuntimeSelection | null =
    deployable && node.selection && harness.selection
      ? { node: node.selection, harness: harness.selection }
      : null;

  const mainComponents = componentDecisions.filter(
    (c) => c.component !== 'route' && !c.component.startsWith('prerequisite:'),
  );
  const install = mainComponents.filter((c) => c.action === 'INSTALL').map((c) => c.label);
  // Desktop 只被识别，不会被本软件"使用"；它的安全承诺放在 untouched[]。
  const reuse = mainComponents
    .filter((c) => c.action === 'REUSE' && c.component !== 'harness-desktop')
    .map((c) => c.label);
  const modify = mainComponents
    .filter((c) => c.action === 'UPGRADE' || c.action === 'REPAIR')
    .map((c) => `${c.label}（${c.action === 'UPGRADE' ? '升级' : '修复'}）`);

  const untouched = [
    '系统已安装的 Node.js（不升级、不卸载、不修改）',
    'PATH 与系统环境变量（不修改）',
    'Harness Desktop（不会被启动或修改），以及它独占的 desktop profile（不写入）',
    '用户已有的 Harness CLI 与配置目录（不覆盖；仅在复用模式下只读调用）',
    '本软件数据目录之外的任何文件',
  ];

  const planId = createHash('sha256')
    .update(
      JSON.stringify({
        scanId: report.scanId,
        checkedAt: report.checkedAt,
        preferences,
        actions: componentDecisions.map((c) => [c.component, c.action]),
      }),
    )
    .digest('hex')
    .slice(0, 32);

  return {
    planId,
    generatedAt,
    environmentCheckedAt: report.checkedAt,
    overall,
    deployable,
    blocked,
    needsChoice,
    requiresConfirmation: true,
    requiresAdmin: false,
    requiresNetwork,
    components: componentDecisions,
    install,
    reuse,
    modify,
    untouched,
    blockers: blockers.map((b) => `${b.label}：${b.reason}`),
    warnings,
    recovery: deployable
      ? '任一步骤失败都可从失败步骤重试；取消/回滚只删除本次任务创建的内容，不影响你原有的 Node、Harness 与配置。'
      : '先处理阻塞项或完成选择，然后重新检测环境。',
    options: optionsList,
    preferences,
    runtime,
  };
}

/** 供测试与 UI 校验：未知/矛盾状态永远不能得到「可执行」。 */
export function assertDeployable(decision: InstallationDecision): void {
  if (!decision.deployable || decision.blocked || decision.needsChoice || !decision.runtime) {
    throw new Error('当前安装决策不可执行');
  }
}
