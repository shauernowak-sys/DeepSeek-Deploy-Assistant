import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { executePlan, Journal, loadMatrix, probeHarness } from '@dda/core';
import { appPaths, createDshCli } from '@dda/adapters';
import { BASELINE, RuntimeManifestSchema } from '@dda/spec';
import { buildDeploySteps } from '../../apps/desktop/src/main/services/deploy-plan';

const ROOT = process.env.DDA_E2E_ROOT;
const ENABLED = process.env.DDA_E2E === '1' && Boolean(ROOT);

/**
 * Reuses the root produced by real-deploy.test.ts:
 *  1) re-running the same plan must be a no-op (idempotency / duplicate-install detection)
 *  2) `dsh web` must boot and the probe must reach `usable` (token hand-off + app shell)
 */
describe.skipIf(!ENABLED)('E2E 幂等性与启动健康（DDA_E2E=1 + DDA_E2E_ROOT）', () => {
  it(
    '重复执行 plan 全部跳过，且能启动 web 并达到 usable',
    async () => {
      const paths = appPaths(ROOT!);
      const manifest = RuntimeManifestSchema.parse(
        JSON.parse(await readFile(join(__dirname, '../../apps/desktop/resources/manifests/node.json'), 'utf8')),
      );
      const matrix = loadMatrix(
        JSON.parse(await readFile(join(__dirname, '../../apps/desktop/resources/manifests/compat.json'), 'utf8')),
      );

      const journal = new Journal(join(paths.stateTasks, 'e2e-reuse.json'));
      const steps = buildDeploySteps({
        paths,
        manifest,
        matrix,
        registry: 'https://registry.npmmirror.com',
        log: () => undefined,
      });

      const started = Date.now();
      const result = await executePlan({
        taskId: 'e2e-reuse',
        scenario: 'e2e',
        steps,
        journal,
        resume: false,
        log: () => undefined,
      });
      const seconds = (Date.now() - started) / 1000;
      console.log(`幂等重跑用时 ${seconds.toFixed(1)}s`);
      console.log(result.summary.steps.map((s) => `${s.id}:${s.status}`).join(' '));

      expect(result.summary.status).toBe('succeeded');
      expect(seconds).toBeLessThan(120);
      const skipped = result.summary.steps.filter((s) => s.status === 'skipped').map((s) => s.id);
      expect(skipped).toEqual(expect.arrayContaining(['download-node', 'extract-node', 'install-dsh', 'install-qqbot']));

      const cli = createDshCli({
        paths,
        pnpmBinDir: join(paths.root, 'bin'),
        registry: 'https://registry.npmmirror.com',
      });
      const { handle, ready } = await cli.launchWeb(BASELINE.dsh.profile, 0);
      try {
        const { url, token } = await ready;
        const baseUrl = url.split('?')[0]!;
        let report = await probeHarness({ baseUrl, token });
        for (let i = 0; i < 20 && report.level !== 'usable'; i += 1) {
          await new Promise((r) => setTimeout(r, 500));
          report = await probeHarness({ baseUrl, token });
        }
        console.log(`health=${report.level} http=${report.httpStatus} detail=${report.detail}`);
        expect(report.level).toBe('usable');

        const anonymous = await probeHarness({ baseUrl });
        expect(anonymous.level).toBe('alive');
        expect(anonymous.httpStatus).toBe(401);
      } finally {
        await handle.stop();
      }
    },
    10 * 60_000,
  );
});
