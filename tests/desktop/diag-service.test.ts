import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { appPaths, type AppPaths } from '@dda/adapters';
import { Logger, type NetworkSummary } from '@dda/core';
import type { EnvReport } from '@dda/spec';

const appVersion = '0.2.0';
vi.mock('electron', () => ({ app: { getVersion: () => appVersion } }));

const { DiagnosticsService } = await import('../../apps/desktop/src/main/services/diag-service');

describe('诊断导出与预览的一致性', () => {
  async function build() {
    const localAppData = await mkdtemp(join(tmpdir(), 'dda-diag-svc-'));
    const paths: AppPaths = appPaths(localAppData);
    await mkdir(paths.logs, { recursive: true });
    await mkdir(join(paths.dshHome, 'profiles', 'web'), { recursive: true });
    await writeFile(join(paths.dshHome, 'profiles', 'web', 'config.json'), '{"apiKey":"sk-profileOnlySecret999"}');
    await writeFile(join(paths.logs, 'app.log'), 'started\nQQBOT_SECRET=zzzzzzzzzzzzzzzz\n', 'utf8');
    const logger = await Logger.create(paths.logs, 'test.log');

    const report: EnvReport = {
      os: { caption: 'Windows 10', build: '19045', arch: 'x64', admin: false },
      diskFreeBytes: 0,
      runtimes: [
        { id: 'node', installed: true, version: '22.23.4' },
        { id: 'pnpm', installed: true, version: '11.28.5' },
        { id: 'dsh', installed: true, version: '0.2.0-rc.2' },
      ],
      route: { kind: 'cli', evidence: [] },
      checkedAt: new Date().toISOString(),
    };

    // Each call returns a different timestamp: if export re-collected, the ZIP could no longer
    // match what the preview advertised.
    let calls = 0;
    const networkProbe = async (): Promise<NetworkSummary> => {
      calls += 1;
      return {
        generatedAt: `probe-${calls}`,
        items: [
          { target: 'npm', url: 'https://r/-/ping?token=abcdef1234567890', ok: true, status: 200, millis: 5 },
        ],
      };
    };

    const service = new DiagnosticsService(
      { paths, logger, registry: 'https://registry.npmmirror.com' } as never,
      { scan: async () => report } as never,
      {
        listPlugins: async () => [{ name: '@tencent-connect/dsh-qqbot', version: '0.5.5', installed: true }],
      } as never,
      async () => undefined,
      networkProbe,
    );
    return { paths, service };
  }

  it('导出内容与预览完全相同（不会二次采集）', async () => {
    const { service } = await build();
    const preview = await service.preview();
    const exported = await service.export();
    const zipText = (await readFile(exported.zipPath)).toString('utf8');

    expect(exported.entries).toBe(7);
    expect(preview.entries).toHaveLength(7);
    expect(zipText).toContain('probe-1');
    expect(zipText).not.toContain('probe-2');
  });

  it('导出的 ZIP 不含凭据、不含 profile 文件内容', async () => {
    const { service } = await build();
    await service.preview();
    const exported = await service.export();
    const zipText = (await readFile(exported.zipPath)).toString('utf8');

    expect(zipText).not.toContain('sk-profileOnlySecret999');
    expect(zipText).not.toContain('zzzzzzzzzzzzzzzz');
    expect(zipText).not.toContain('abcdef1234567890');
    // Directory listing is allowed, file content is not.
    expect(zipText).toContain('config.json');
  });

  it('未预览直接导出时自行采集一次，条目数仍为 7', async () => {
    const { service } = await build();
    const exported = await service.export();
    expect(exported.entries).toBe(7);
    expect(exported.bytes).toBeGreaterThan(0);
  });
});
