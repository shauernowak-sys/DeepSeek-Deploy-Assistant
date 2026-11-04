import { decideInstallation, isWritableProfile, type DecideOptions } from '@dda/core';
import { dshBinJs, nodeExe, probeEnvironment, type ProbeEnvironmentOptions } from '@dda/adapters';
import {
  BASELINE,
  DdaError,
  ERROR_CODES,
  type DecisionPreferences,
  type DeploymentDecisionAuthorization,
  type EnvReport,
  type EnvironmentInspection,
  type EnvironmentReport,
  type InstallationDecision,
} from '@dda/spec';

import type { Container } from './container';

export interface EnvServiceOptions {
  /** 注入真实探测（测试用）；默认读取 Windows 实际状态。 */
  probe?: (options: ProbeEnvironmentOptions) => Promise<EnvironmentReport>;
  now?: () => number;
  /** 安装决策的有效期。 */
  planTtlMs?: number;
  /** 复用的环境快照有效期，超过则重新检测。 */
  reportTtlMs?: number;
}

interface Artifact {
  seq: number;
  at: number;
  environment: EnvironmentReport;
  decision: InstallationDecision;
}

export class EnvService {
  private scanSeq = 0;
  private latestSeq = 0;
  private latest?: { seq: number; at: number; environment: EnvironmentReport };
  private readonly artifacts = new Map<string, Artifact>();
  private readonly now: () => number;
  private readonly planTtlMs: number;
  private readonly reportTtlMs: number;

  constructor(
    private readonly container: Container,
    private readonly options: EnvServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.planTtlMs = options.planTtlMs ?? 10 * 60_000;
    this.reportTtlMs = options.reportTtlMs ?? 5 * 60_000;
  }

  /** 只读检测（诊断包使用），不参与门禁状态。 */
  async scan(): Promise<EnvReport> {
    return this.detect();
  }

  async detect(): Promise<EnvironmentReport> {
    const probe = this.options.probe ?? probeEnvironment;
    return probe({
      paths: this.container.paths,
      manifest: this.container.nodeManifest,
      nodeMinVersion: this.container.nodeManifest.detect.minVersion,
      registry: this.container.registry,
    });
  }

  /** 检测 + 决策，一次 IPC 返回，UI 不需要自己拼装。 */
  async inspect(preferences: DecisionPreferences = {}): Promise<EnvironmentInspection> {
    const seq = ++this.scanSeq;
    const environment = await this.detect();

    // 并发检测不得互相覆盖：较晚发起的检测是唯一事实源；较早的结果直接复用较新的快照。
    if (seq < this.latestSeq && this.latest) {
      return this.fromLatest(preferences);
    }
    this.latestSeq = seq;
    this.latest = { seq, at: this.now(), environment };
    return this.remember(seq, environment, preferences);
  }

  async decide(preferences: DecisionPreferences = {}): Promise<InstallationDecision> {
    if (this.latest && this.now() - this.latest.at <= this.reportTtlMs) {
      return this.remember(this.latest.seq, this.latest.environment, preferences).decision;
    }
    return (await this.inspect(preferences)).decision;
  }

  /**
   * 门禁：只有「本次检测生成、未过期、未被更新检测取代、且已确认」的决策才能进入执行器。
   * 返回的 runtime 是执行器唯一允许使用的运行时。
   */
  async authorize(
    planId: string,
    confirmed: boolean,
  ): Promise<DeploymentDecisionAuthorization> {
    if (!confirmed) {
      throw new DdaError(
        ERROR_CODES.E_DECISION_UNCONFIRMED,
        '安装方案尚未确认，已拒绝执行部署',
        '请在确认页点「确认并开始部署」；取消不会执行任何操作',
      );
    }
    const artifact = this.artifacts.get(planId);
    if (!artifact) {
      throw new DdaError(
        ERROR_CODES.E_DECISION_REQUIRED,
        '没有找到对应的安装决策，已拒绝执行部署',
        '请先完成「环境检测」，再按推荐方案确认',
      );
    }
    if (this.now() - artifact.at > this.planTtlMs || artifact.seq < this.latestSeq) {
      this.artifacts.delete(planId);
      throw new DdaError(
        ERROR_CODES.E_DECISION_STALE,
        '安装决策已过期或已被新的检测结果取代',
        '请重新检测环境并再次确认',
      );
    }
    if (artifact.decision.blocked || artifact.decision.needsChoice || !artifact.decision.runtime) {
      throw new DdaError(
        ERROR_CODES.E_DECISION_BLOCKED,
        `当前环境不允许部署：${artifact.decision.blockers.join('；') || '仍需用户选择'}`,
        artifact.decision.recovery,
      );
    }
    // desktop profile 由官方桌面端独占；门禁层再校验一次，避免任何调用方绕过 CLI 的检查。
    if (!isWritableProfile(BASELINE.dsh.profile, artifact.environment.resolution.desktopProfileExists)) {
      throw new DdaError(
        ERROR_CODES.E_PROFILE_OWNED_BY_DESKTOP,
        `${BASELINE.dsh.profile} profile 不可写，已拒绝部署`,
        '本工具只使用 web profile，不会修改 desktop profile',
      );
    }
    return {
      decision: artifact.decision,
      environment: artifact.environment,
      runtime: artifact.decision.runtime,
    };
  }

  baseline(): typeof BASELINE {
    return BASELINE;
  }

  private fromLatest(preferences: DecisionPreferences): EnvironmentInspection {
    return this.remember(this.latest!.seq, this.latest!.environment, preferences);
  }

  private remember(
    seq: number,
    environment: EnvironmentReport,
    preferences: DecisionPreferences,
  ): EnvironmentInspection {
    const decision = decideInstallation(environment, this.decideOptions(preferences));
    this.artifacts.set(decision.planId, { seq, at: this.now(), environment, decision });
    // 只保留最近少量决策，避免长时间运行的进程无限增长。
    if (this.artifacts.size > 20) {
      const oldest = [...this.artifacts.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.artifacts.delete(oldest[0]);
    }
    void this.container.logger.info(
      'env',
      `scan=${environment.scanId} plan=${decision.planId} overall=${decision.overall} deployable=${decision.deployable} probeErrors=${environment.probeErrors.length}`,
    );
    return { environment, decision };
  }

  private decideOptions(preferences: DecisionPreferences): DecideOptions {
    const { paths, nodeManifest } = this.container;
    return {
      baseline: { node: BASELINE.node.version, pnpm: BASELINE.pnpm.version, dsh: BASELINE.dsh.version },
      nodeMinVersion: nodeManifest.detect.minVersion,
      targets: {
        managedNodeExe: nodeExe(paths),
        managedNodeDir: paths.nodeDir,
        managedHarnessBin: dshBinJs(paths),
      },
      preferences,
      now: () => new Date(this.now()),
    };
  }
}
