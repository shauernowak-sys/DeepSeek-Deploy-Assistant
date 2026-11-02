import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { executePlan, Journal, loadMatrix } from '@dda/core';
import { appPaths, createDshCli, detectManagedNode } from '@dda/adapters';
import { BASELINE, RuntimeManifestSchema } from '@dda/spec';
import { buildDeploySteps } from '../../apps/desktop/src/main/services/deploy-plan';

const ENABLED = process.env.DDA_E2E === '1';

/**
 * Real end-to-end deployment: downloads Node from the mirror, installs pnpm, dsh and the QQ
 * plugin into a throwaway root. Requires network (~200 MB). Run with DDA_E2E=1.
 */
describe.skipIf(!ENABLED)('E2E 真实部署（DDA_E2E=1）', () => {
  it(
    '按生产 plan 完整部署并验证 dsh / profile / 插件',
    async () => {
      const started = Date.now();
      const localAppData = await mkdtemp(join(tmpdir(), 'dda-e2e-'));
      const paths = appPaths(localAppData);
      const manifest = RuntimeManifestSchema.parse(
        JSON.parse(
          await readFile(join(__dirname, '../../apps/desktop/resources/manifests/node.json'), 'utf8'),
        ),
      );
      const matrix = loadMatrix(
        JSON.parse(
          await readFile(join(__dirname, '../../apps/desktop/resources/manifests/compat.json'), 'utf8'),
        ),
      );

      const journal = new Journal(join(paths.stateTasks, 'e2e.json'));
      const steps = buildDeploySteps({
        paths,
        manifest,
        matrix,
        registry: 'https://registry.npmmirror.com',
        log: (m) => console.log(m),
      });

      const result = await executePlan({
        taskId: 'e2e',
        scenario: 'e2e',
        steps,
        journal,
        resume: false,
        log: (m) => console.log(m),
      });

      console.log(`E2E 用时 ${((Date.now() - started) / 1000).toFixed(1)}s，root=${paths.root}`);
      for (const step of result.summary.steps) {
        console.log(`  ${step.status.padEnd(10)} ${step.id}`);
      }

      expect(result.summary.status).toBe('succeeded');
      const node = await detectManagedNode(paths);
      expect(node.version).toBe(BASELINE.node.version);

      const cli = createDshCli({
        paths,
        pnpmBinDir: join(paths.root, 'bin'),
        registry: 'https://registry.npmmirror.com',
      });
      const dsh = await cli.version();
      expect(dsh.version).toBe(BASELINE.dsh.version);

      const plugins = await cli.listPlugins(BASELINE.dsh.profile);
      expect(plugins).toContainEqual(
        expect.objectContaining({ name: '@tencent-connect/dsh-qqbot', version: BASELINE.qqbot.version }),
      );
    },
    20 * 60_000,
  );
});
