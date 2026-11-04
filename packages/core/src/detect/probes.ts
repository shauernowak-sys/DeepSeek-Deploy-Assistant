import type { CandidateSource, RouteReport } from '@dda/spec';

/** 一组原始探测值：全部由真实读取系统状态得到，评估层不得再补默认值冒充事实。 */
export interface NodeProbe {
  path: string;
  version?: string;
  source: CandidateSource;
  runnable: boolean;
  stable: boolean;
  onPathOrder?: number;
  /** 该 Node 是否自带 npm（安装私有 pnpm 时需要）。 */
  hasNpm: boolean;
  error?: string;
}

export interface ManagedRuntimeProbe {
  path: string;
  version?: string;
  runnable: boolean;
  error?: string;
}

export interface SystemHarnessProbe {
  /** `dsh.cmd` / `dsh.exe` 等 shim 的真实位置（展示用）。 */
  path: string;
  /** 解析出的 JS 入口；只有它能被 `node.exe` 直接执行。 */
  binPath?: string;
  version?: string;
  runnable: boolean;
  stable: boolean;
  onPathOrder?: number;
  error?: string;
}

export interface DesktopProbe {
  /** 注册表是否成功读取（false 表示读不到，而不是「没装」）。 */
  registryRead: boolean;
  displayName?: string;
  version?: string;
  installDir?: string;
  exeExists: boolean;
  profileExists: boolean;
  error?: string;
}

export interface NetworkProbe {
  /** 主源（清单 url + registry）是否全部可达。 */
  primaryOk: boolean;
  /** 任一备用镜像是否可达。 */
  mirrorOk: boolean;
  detail: string;
  /** 每个目标的原始结果，用于排障。 */
  targets: { name: string; url: string; ok: boolean; detail: string }[];
}

export interface EnvironmentProbes {
  checkedAt: string;
  os: { caption: string; build: string; arch: string; platform: string; supported: boolean };
  admin: boolean;
  disk: { root: string; freeBytes: number };
  directories: { root: string; exists: boolean; writable: boolean; checkedPath: string };
  network: NetworkProbe;
  systemNodes: NodeProbe[];
  managedNode?: ManagedRuntimeProbe;
  managedPnpm?: ManagedRuntimeProbe;
  managedHarness?: ManagedRuntimeProbe;
  systemHarness: SystemHarnessProbe[];
  desktop?: DesktopProbe;
  route: RouteReport;
  profiles: { home: string; homeExists: boolean; webExists: boolean; desktopExists: boolean };
  probeErrors: { probe: string; message: string }[];
}
