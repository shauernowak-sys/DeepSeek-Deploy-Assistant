import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths } from '@dda/adapters';
import { DdaError, ERROR_CODES } from '@dda/spec';

const { HarnessService } = await import('../../apps/desktop/src/main/services/harness-service');

function serviceOn(localAppData: string) {
  const paths = appPaths(localAppData);
  const container = {
    paths,
    registry: 'https://registry.npmmirror.com',
    logger: { info: async () => undefined, warn: async () => undefined, error: async () => undefined },
  };
  return { paths, service: new HarnessService(container as never) };
}

describe('HarnessService 前置检查', () => {
  it('未部署时启动给出可行动的错误码与中文提示（不再走到 spawn ENOENT）', async () => {
    const localAppData = await mkdtemp(join(tmpdir(), 'dda-preflight-'));
    const { service } = serviceOn(localAppData);

    const error = await service.launch(0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DdaError);
    expect((error as DdaError).code).toBe(ERROR_CODES.E_HARNESS_NOT_DEPLOYED);
    expect((error as DdaError).message).toContain('Harness 尚未安装');
    expect((error as DdaError).message).toMatch(/runtimes[\\/]node/);
    expect((error as DdaError).hint).toContain('部署');
  });

  it('只装了 Node 缺 Harness 本体时，仍然拦截并指出缺哪一项', async () => {
    const localAppData = await mkdtemp(join(tmpdir(), 'dda-preflight-'));
    const { paths, service } = serviceOn(localAppData);
    await mkdir(paths.nodeDir, { recursive: true });
    await writeFile(join(paths.nodeDir, 'node.exe'), '');

    const error = (await service.launch(0).catch((e: unknown) => e)) as DdaError;
    expect(error.code).toBe(ERROR_CODES.E_HARNESS_NOT_DEPLOYED);
    expect(error.message).toContain('Harness 本体');
    expect(error.message).not.toContain('Node（');
  });
});
