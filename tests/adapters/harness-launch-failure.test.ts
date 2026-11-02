import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths, createDshCli } from '@dda/adapters';

/**
 * Regression for the "启动 Harness 报错" defect: with no deployed runtime, `spawn(node.exe)`
 * emits ENOENT. Before the fix that event had no listener, so Node rethrew it as an uncaught
 * exception in the main process (Electron shows a raw JS error dialog) and `ready` never settled
 * with anything actionable. Both must be gone.
 */
async function cliOnFreshRoot() {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-launch-'));
  const paths = appPaths(localAppData);
  return {
    paths,
    cli: createDshCli({ paths, pnpmBinDir: join(paths.root, 'bin'), registry: 'https://registry.npmmirror.com' }),
  };
}

describe('dsh launchWeb failure reporting', () => {
  it('未部署时以可行动的中文错误结束，而不是抛出未捕获异常', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const { cli, paths } = await cliOnFreshRoot();
      const { handle, ready } = await cli.launchWeb('web', 0, 5_000);
      await expect(ready).rejects.toThrow(/找不到 Harness 运行时/);
      await expect(ready).rejects.toThrow(/一键部署/);
      // The message must name the runtime that is actually missing so support can act on it.
      await expect(ready).rejects.toThrow(/runtimes[\\/]node/);
      await handle.stop();
      await new Promise((r) => setTimeout(r, 200));
      expect(uncaught).toEqual([]);
      expect(paths.nodeDir).toContain('runtimes');
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('spawnCommand 暴露 spawned 承诺，失败时只 reject 不抛出', async () => {
    const { paths } = await cliOnFreshRoot();
    const { spawnCommand } = await import('@dda/adapters');
    const handle = spawnCommand({ exePath: join(paths.nodeDir, 'node.exe'), args: ['--version'] });
    await expect(handle.spawned).rejects.toMatchObject({ code: 'ENOENT' });
    await handle.stop();
  });
});
