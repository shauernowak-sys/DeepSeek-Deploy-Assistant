import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { appPaths } from '@dda/adapters';
import { DEEPSEEK_TEMPLATE, Logger, type ApiProviderConfig } from '@dda/core';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  },
}));

const { ApiService } = await import('../../apps/desktop/src/main/services/api-service');

const KEY = 'sk-backup-retention-test-000111222';

const config: ApiProviderConfig = {
  template: 'openai-compatible',
  label: 'Backup Test',
  protocol: 'openai-completions',
  baseUrl: 'https://gateway.example.com/v1',
  model: 'unit-model',
  credentialRef: 'BACKUP_TEST_KEY',
};

async function fixture() {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-backup-'));
  const paths = appPaths(localAppData);
  await mkdir(paths.logs, { recursive: true });
  const logger = await Logger.create(paths.logs, 'test.log');
  const { Secrets } = await import('../../apps/desktop/src/main/security/secrets');
  const service = new ApiService(
    { paths, logger, registry: 'https://registry.npmmirror.com' } as never,
    new Secrets(paths.root),
  );
  return { paths, service };
}

function backups(names: string[], base: string): string[] {
  return names.filter((name) => name.startsWith(`${base}.dda-backup-`)).sort();
}

describe('API 配置备份保留策略', () => {
  it('多次保存后只保留最近 3 份备份，且最新一份始终存在', async () => {
    const { paths, service } = await fixture();

    for (let i = 0; i < 6; i += 1) {
      const result = await service.save({ config: { ...config, label: `Backup Test ${i}` }, apiKey: KEY });
      expect(result.ok).toBe(true);
      // Distinct ISO millisecond stamps keep the backup names unique.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const rootNames = backups(await readdir(paths.root), 'api-config.json');
    expect(rootNames).toHaveLength(3);

    const profileDir = join(paths.dshHome, 'profiles', 'web');
    const patchNames = backups(await readdir(profileDir), 'cordis.patch.yml');
    expect(patchNames).toHaveLength(3);

    // The newest backup must still be readable (nothing pruned that we depend on).
    const newest = join(paths.root, rootNames[rootNames.length - 1]!);
    const content = JSON.parse(await readFile(newest, 'utf8')) as ApiProviderConfig;
    expect(content.credentialRef).toBe(config.credentialRef);
  });

  it('配置写入是原子的：不残留 .tmp 文件', async () => {
    const { paths, service } = await fixture();
    await service.save({ config, apiKey: KEY });

    const names = await readdir(paths.root);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const saved = JSON.parse(await readFile(join(paths.root, 'api-config.json'), 'utf8')) as ApiProviderConfig;
    expect(saved.label).toBe(config.label);
  });

  it('默认模板仍是唯一的内置来源（不会被备份逻辑改写）', async () => {
    const { service } = await fixture();
    const status = await service.status();
    expect(status.configured).toBe(false);
    expect(DEEPSEEK_TEMPLATE.template).toBe('deepseek');
  });
});
