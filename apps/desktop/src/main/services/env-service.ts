import { join } from 'node:path';

import { detectEnv, type RuntimeProbe } from '@dda/core';
import { createDshCli, detectHarnessRoute, detectManagedNode, fileExists, nodeExe } from '@dda/adapters';
import { BASELINE, type EnvReport, type RuntimeInfo, type RuntimeId } from '@dda/spec';

import type { Container } from './container';

export class EnvService {
  constructor(private readonly container: Container) {}

  async scan(): Promise<EnvReport> {
    const paths = this.container.paths;
    const dsh = createDshCli({ paths, pnpmBinDir: join(paths.root, 'bin'), registry: this.container.registry });

    const probe: RuntimeProbe = {
      detect: async (id: RuntimeId): Promise<RuntimeInfo> => {
        if (id === 'node') return detectManagedNode(paths);
        if (id === 'pnpm') {
          const cli = join(paths.pnpmPrefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
          if (!(await fileExists(cli))) return { id: 'pnpm', installed: false };
          try {
            const { runCommand } = await import('@dda/adapters');
            const { stdout } = await runCommand({ exePath: nodeExe(paths), args: [cli, '--version'], timeoutMs: 20_000 });
            return { id: 'pnpm', installed: true, version: stdout.trim(), path: cli };
          } catch {
            return { id: 'pnpm', installed: false, path: cli };
          }
        }
        try {
          return await dsh.version();
        } catch {
          return { id: 'dsh', installed: false };
        }
      },
    };

    return detectEnv({
      probe,
      route: async () => {
        let managedVersion: string | undefined;
        try {
          managedVersion = (await dsh.version()).version;
        } catch {
          managedVersion = undefined;
        }
        return detectHarnessRoute({
          dshHome: paths.dshHome,
          managedDshVersion: managedVersion,
          pathDshVersion: process.env.DDA_ASSUME_PATH_DSH,
        });
      },
      driveRoot: 'C:\\',
    });
  }

  baseline(): typeof BASELINE {
    return BASELINE;
  }
}
