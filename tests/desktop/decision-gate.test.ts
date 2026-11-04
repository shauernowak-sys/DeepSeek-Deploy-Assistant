import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { appPaths } from '@dda/adapters';
import { loadMatrix, Logger } from '@dda/core';
import { DdaError, ERROR_CODES, RuntimeManifestSchema } from '@dda/spec';

import { EnvService } from '../../apps/desktop/src/main/services/env-service';
import { DeployService } from '../../apps/desktop/src/main/services/deploy-service';
import type { Container } from '../../apps/desktop/src/main/services/container';
import { report } from '../helpers/environment-fixtures';

const manifests = join(__dirname, '../../apps/desktop/resources/manifests');

async function container(): Promise<Container> {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-gate-'));
  const paths = appPaths(localAppData);
  await mkdir(paths.logs, { recursive: true });
  const logger = await Logger.create(paths.logs, 'gate.log');
  const nodeManifest = RuntimeManifestSchema.parse(JSON.parse(await readFile(join(manifests, 'node.json'), 'utf8')));
  const matrix = loadMatrix(JSON.parse(await readFile(join(manifests, 'compat.json'), 'utf8')));
  return {
    paths,
    logger,
    nodeManifest,
    matrix,
    manifestsDir: manifests,
    registry: 'https://registry.npmmirror.com',
    childEnvExclusions: [],
  };
}

function gateOn(c: Container, probe: () => Promise<ReturnType<typeof report>>, now?: () => number) {
  return new EnvService(c, { probe, now });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DdaError);
  expect((error as DdaError).code).toBe(code);
}

describe('安装前决策门禁', () => {
  let c: Container;
  beforeEach(async () => {
    c = await container();
  });

  it('未确认（用户点取消）绝不执行：confirmed=false 直接拒绝', async () => {
    const service = gateOn(c, async () => report());
    const { decision } = await service.inspect();
    await expectCode(service.authorize(decision.planId, false), ERROR_CODES.E_DECISION_UNCONFIRMED);
  });

  it('没有 planId / 伪造 planId → 拒绝', async () => {
    const service = gateOn(c, async () => report());
    await expectCode(service.authorize('not-a-real-plan', true), ERROR_CODES.E_DECISION_REQUIRED);
  });

  it('确认后放行，并返回唯一允许使用的 runtime', async () => {
    const service = gateOn(c, async () => report({ systemNodes: [] }));
    const { decision } = await service.inspect();
    const authorization = await service.authorize(decision.planId, true);
    expect(authorization.runtime.node.mode).toBe(decision.runtime?.node.mode);
    expect(authorization.runtime.harness.mode).toBe('managed');
  });

  it('BLOCKED 决策即使被确认也不能执行', async () => {
    const service = gateOn(c, async () => report({ route: { kind: 'unknown', evidence: [] } }));
    const { decision } = await service.inspect();
    expect(decision.deployable).toBe(false);
    await expectCode(service.authorize(decision.planId, true), ERROR_CODES.E_DECISION_BLOCKED);
  });

  it('需要用户选择（多版本）时不能执行', async () => {
    const service = gateOn(c, async () =>
      report({
        systemNodes: [
          { path: 'C:\\a\\node.exe', version: '22.23.4', source: 'common', runnable: true, stable: true, hasNpm: true },
          { path: 'C:\\b\\node.exe', version: '20.11.0', source: 'common', runnable: true, stable: true, hasNpm: true },
        ],
      }),
    );
    const { decision } = await service.inspect();
    expect(decision.needsChoice).toBe(true);
    await expectCode(service.authorize(decision.planId, true), ERROR_CODES.E_DECISION_BLOCKED);
  });

  it('决策过期 → 拒绝（不允许拿旧方案执行）', async () => {
    let now = 1_000_000;
    const service = gateOn(c, async () => report(), () => now);
    const { decision } = await service.inspect();
    now += 11 * 60_000;
    await expectCode(service.authorize(decision.planId, true), ERROR_CODES.E_DECISION_STALE);
  });

  it('新的检测会作废旧方案（环境已变化，必须重新确认）', async () => {
    let version = '22.23.4';
    const service = gateOn(c, async () => report({ systemNodes: [{ path: 'C:\\node\\node.exe', version, source: 'common', runnable: true, stable: true, hasNpm: true }] }));
    const first = await service.inspect();
    version = '18.20.0';
    await service.inspect();
    await expectCode(service.authorize(first.decision.planId, true), ERROR_CODES.E_DECISION_STALE);
  });

  it('并发检测不互相覆盖：晚发起的检测是唯一事实源', async () => {
    const resolutions: Array<(value: ReturnType<typeof report>) => void> = [];
    const service = gateOn(
      c,
      () =>
        new Promise<ReturnType<typeof report>>((done) => {
          resolutions.push(done);
        }),
    );
    const a = service.inspect();
    while (resolutions.length < 1) await new Promise((r) => setTimeout(r, 0));
    const b = service.inspect();
    while (resolutions.length < 2) await new Promise((r) => setTimeout(r, 0));

    // b 是较晚发起的检测，先完成；a 后完成时必须复用 b 的结果，而不是把 b 覆盖掉。
    const reportB = report({ systemNodes: [] });
    resolutions[1]!(reportB);
    const resultB = await b;
    resolutions[0]!(
      report({ systemNodes: [{ path: 'C:\\old\\node.exe', version: '18.0.0', source: 'common', runnable: true, stable: true, hasNpm: true }] }),
    );
    const resultA = await a;

    expect(resultA.environment.scanId).toBe(resultB.environment.scanId);
    expect(resultA.decision.planId).toBe(resultB.decision.planId);
    const authorization = await service.authorize(resultB.decision.planId, true);
    expect(authorization.environment.scanId).toBe(reportB.scanId);
  });

  it('DeployService：门禁拒绝时不会创建任务记录，也不会开始执行', async () => {
    const service = gateOn(c, async () => report());
    const deploy = new DeployService({
      container: c,
      onEvent: () => undefined,
      authorize: (planId, confirmed) => service.authorize(planId, confirmed),
    });

    await expectCode(deploy.start({ planId: 'fake-plan-id', confirmed: true }), ERROR_CODES.E_DECISION_REQUIRED);
    await expect(stat(deploy.journalPath())).rejects.toThrow();

    const { decision } = await service.inspect();
    await expectCode(deploy.start({ planId: decision.planId, confirmed: false }), ERROR_CODES.E_DECISION_UNCONFIRMED);
    await expect(stat(deploy.journalPath())).rejects.toThrow();
    expect(deploy.isRunning).toBe(false);
  });

  it('继续任务必须存在真实任务记录，不能凭空启动部署', async () => {
    const service = gateOn(c, async () => report());
    const deploy = new DeployService({
      container: c,
      onEvent: () => undefined,
      authorize: (planId, confirmed) => service.authorize(planId, confirmed),
    });
    await expectCode(deploy.resume(deploy.taskId), ERROR_CODES.E_DECISION_REQUIRED);
  });
});
