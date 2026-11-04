import { describe, expect, it, vi } from 'vitest';

import {
  REGISTRY_NPMMIRROR,
  REGISTRY_OFFICIAL,
  installWithRegistryFallback,
  isRegistryRetryable,
  registryPlan,
  type RegistryLayer,
} from '@dda/core';
import { DdaError, ERROR_CODES } from '@dda/spec';

describe('P-8 registry 计划（L2 镜像优先、L3 官方兜底）', () => {
  it('默认顺序是镜像 → 官方，反向计划也支持', () => {
    expect(registryPlan().map((layer) => layer.id)).toEqual(['l2-npmmirror', 'l3-official']);
    expect(registryPlan().map((layer) => layer.url)).toEqual([REGISTRY_NPMMIRROR, REGISTRY_OFFICIAL]);
    expect(registryPlan('official-first').map((layer) => layer.id)).toEqual(['l3-official', 'l2-npmmirror']);
  });

  it('只在"换源可能有用"的失败上回退', () => {
    expect(isRegistryRetryable('ERR_PNPM_FETCH_503 …')).toBe(true);
    expect(isRegistryRetryable('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
    expect(isRegistryRetryable('ERR_PNPM_FETCH_404')).toBe(true);
    expect(isRegistryRetryable('ERR_PNPM_NO_MATCHING_VERSION No matching version found')).toBe(true);
    expect(isRegistryRetryable('ERR_PNPM_FETCH_401 Unauthorized')).toBe(false);
    expect(isRegistryRetryable('401 authentication required')).toBe(false);
  });
});

describe('P-8 逐层安装', () => {
  it('镜像可用时只装一次，不额外请求官方源', async () => {
    const install = vi.fn(async () => undefined);
    const logs: string[] = [];
    const result = await installWithRegistryFallback({
      spec: 'pkg@1.0.0',
      install,
      log: (line) => logs.push(line),
    });

    expect(result.registry.id).toBe('l2-npmmirror');
    expect(result.attempts).toBe(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('国内镜像 npmmirror');
  });

  it('镜像不可达时回退官方源，并记录两段尝试', async () => {
    const install = vi.fn<(layer: RegistryLayer) => Promise<void>>();
    install.mockRejectedValueOnce(new Error('ERR_PNPM_FETCH_503 Service Unavailable'));
    install.mockResolvedValueOnce(undefined);
    const logs: string[] = [];

    const result = await installWithRegistryFallback({
      spec: 'pkg@1.0.0',
      install,
      log: (line) => logs.push(line),
    });

    expect(result.registry.id).toBe('l3-official');
    expect(result.attempts).toBe(2);
    expect(logs.join('\n')).toContain('切换到下一层');
  });

  it('认证/版本类失败不回退（换源解决不了）', async () => {
    const install = vi.fn(async () => {
      throw new DdaError(ERROR_CODES.E_PROCESS_FAILED, 'ERR_PNPM_FETCH_401 Unauthorized');
    });

    await expect(
      installWithRegistryFallback({ spec: 'pkg@1.0.0', install }),
    ).rejects.toMatchObject({ code: 'E_PROCESS_FAILED' });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('两层都不可达时，错误消息列出两层与各自原因', async () => {
    const install = vi.fn(async () => {
      throw new Error('ERR_PNPM_FETCH_503 down');
    });

    try {
      await installWithRegistryFallback({ spec: 'pkg@1.0.0', install });
      throw new Error('应当抛错');
    } catch (error) {
      const message = (error as DdaError).message;
      expect((error as DdaError).code).toBe('E_PROCESS_FAILED');
      expect(message).toContain('国内镜像 npmmirror');
      expect(message).toContain('官方源 npmjs');
      expect(install).toHaveBeenCalledTimes(2);
    }
  });
});
