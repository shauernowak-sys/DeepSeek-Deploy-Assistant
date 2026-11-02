import { link, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appPaths, type AppPaths } from '@dda/adapters';
import { DEEPSEEK_TEMPLATE, type ApiProviderConfig } from '@dda/core';

/**
 * `safeStorage` is the only Electron API this service touches. The fake keeps the "ciphertext only
 * on disk" property observable (plaintext must never appear in the file).
 */
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  },
}));

const { ApiService } = await import('../../apps/desktop/src/main/services/api-service');
const { Secrets } = await import('../../apps/desktop/src/main/security/secrets');
const { Logger } = await import('@dda/core');

const KEY = 'sk-m31-unit-test-key-000111222';

const custom: ApiProviderConfig = {
  template: 'openai-compatible',
  label: 'Unit Gateway',
  protocol: 'openai-completions',
  baseUrl: 'https://gateway.example.com/v1/',
  model: 'unit-model',
  credentialRef: 'UNIT_GATEWAY_KEY',
  contextWindow: 65536,
};

async function fixture(): Promise<{ paths: AppPaths; service: InstanceType<typeof ApiService>; logger: unknown }> {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-m31-svc-'));
  const paths = appPaths(localAppData);
  await mkdir(paths.logs, { recursive: true });
  const logger = await Logger.create(paths.logs, 'test.log');
  const secrets = new Secrets(paths.root);
  const service = new ApiService({ paths, logger, registry: 'https://registry.npmmirror.com' } as never, secrets);
  return { paths, service, logger: secrets };
}

async function readPatch(paths: AppPaths): Promise<string> {
  return readFile(join(paths.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').catch(() => '');
}

describe('ApiService：保存配置（Harness 未安装）', () => {
  it('写入 patch 与 api-config.json，密钥只以密文落盘', async () => {
    const { paths, service } = await fixture();
    const result = await service.save({ config: custom, apiKey: KEY });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.message).toMatch(/尚未部署/);

    const patch = await readPatch(paths);
    expect(patch).toContain('dda:managed:begin');
    expect(patch).toContain('UNIT_GATEWAY_KEY');
    expect(patch).toContain('provider: dda-custom');

    const configFile = await readFile(join(paths.root, 'api-config.json'), 'utf8');
    expect(JSON.parse(configFile).model).toBe('unit-model');
    expect(configFile).not.toContain(KEY);

    const secretsFile = await readFile(join(paths.root, 'secrets.bin'), 'utf8');
    expect(secretsFile).not.toContain(KEY);

    const status = await service.status();
    expect(status.configured).toBe(true);
    expect(status.keyMask).toBe('sk-****1222');
  });

  it('拒绝非法配置且不写任何文件', async () => {
    const { paths, service } = await fixture();
    const result = await service.save({ config: { ...custom, baseUrl: 'not-a-url' }, apiKey: KEY });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/接口地址/);
    expect(existsSync(join(paths.root, 'api-config.json'))).toBe(false);
    expect(await readPatch(paths)).toBe('');
  });

  it('没有密钥时拒绝保存', async () => {
    const { service } = await fixture();
    const result = await service.save({ config: custom });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('缺少 API Key');
  });
});

describe('ApiService：原配置保护与回滚', () => {
  it('用户已有 patch 内容被保留，删除后恢复为空数组', async () => {
    const { paths, service } = await fixture();
    const patchPath = join(paths.dshHome, 'profiles', 'web', 'cordis.patch.yml');
    await mkdir(join(paths.dshHome, 'profiles', 'web'), { recursive: true });
    await writeFile(patchPath, '- id: my-plugin\n  config:\n    foo: bar\n', 'utf8');

    expect((await service.save({ config: custom, apiKey: KEY })).ok).toBe(true);
    const written = await readFile(patchPath, 'utf8');
    expect(written).toContain('- id: my-plugin');
    expect(written).toContain('foo: bar');

    await service.remove();
    const after = await readFile(patchPath, 'utf8');
    expect(after).toContain('- id: my-plugin');
    expect(after).not.toContain('dda:managed');
    const status = await service.status();
    expect(status.configured).toBe(false);
  });

  it('Harness 回读失败时回滚到写入前状态', async () => {
    const { paths, service } = await fixture();
    const patchPath = join(paths.dshHome, 'profiles', 'web', 'cordis.patch.yml');
    const binPath = join(paths.harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    await mkdir(join(paths.harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    // A dump that still points at the default DeepSeek provider: the read-back must reject it.
    await writeFile(
      binPath,
      "process.stdout.write('- id: agent-default-model\\n  config:\\n    provider: deepseek-official\\n    model: deepseek-flash\\n');\n",
      'utf8',
    );
    await mkdir(paths.nodeDir, { recursive: true });
    try {
      await link(process.execPath, join(paths.nodeDir, 'node.exe'));
    } catch {
      return; // cross-volume temp dir: the rollback path is covered on CI/dev machines
    }

    await mkdir(join(paths.dshHome, 'profiles', 'web'), { recursive: true });
    const original = '- id: keep-me\n  config:\n    a: 1\n';
    await writeFile(patchPath, original, 'utf8');

    const result = await service.save({ config: custom, apiKey: KEY });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/回滚/);

    expect(await readFile(patchPath, 'utf8')).toBe(original);
    expect(existsSync(join(paths.root, 'api-config.json'))).toBe(false);
  });
});

describe('ApiService：密钥交付方式', () => {
  it('launchEnv 只在已配置时返回环境变量映射', async () => {
    const { service } = await fixture();
    expect(await service.launchEnv()).toEqual({});

    await service.save({ config: custom, apiKey: KEY });
    expect(await service.launchEnv()).toEqual({ UNIT_GATEWAY_KEY: KEY });
  });

  it('删除后不再向 Harness 注入任何密钥', async () => {
    const { service } = await fixture();
    await service.save({ config: DEEPSEEK_TEMPLATE, apiKey: KEY });
    await service.remove();
    expect(await service.launchEnv()).toEqual({});
    const leftover = await service.status();
    expect(leftover.configured).toBe(false);
  });

  it('数据目录里没有任何明文密钥文件', async () => {
    const { paths, service } = await fixture();
    await service.save({ config: custom, apiKey: KEY });
    const files = await readdir(paths.root, { recursive: true, withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const full = join(entry.parentPath ?? paths.root, entry.name);
      const content = await readFile(full, 'utf8').catch(() => '');
      expect(content).not.toContain(KEY);
    }
  });
});
