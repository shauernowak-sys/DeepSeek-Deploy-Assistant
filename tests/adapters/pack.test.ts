import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { packDirectoryToTgz } from '@dda/adapters';
import type { RunOptions } from '@dda/adapters';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dda-pack-src-'));
  const outDir = await mkdtemp(join(tmpdir(), 'dda-pack-out-'));
  const tgz = join(outDir, 'dda-fixture-plugin-1.2.3.tgz');
  await writeFile(tgz, 'fake', 'utf8');
  return { directory, outDir, tgz };
}

describe('D04 目录打包（pnpm pack）', () => {
  it('用 pnpm pack 且禁用生命周期脚本，返回绝对路径', async () => {
    const { directory, outDir, tgz } = await fixture();
    let seen: RunOptions | undefined;

    const result = await packDirectoryToTgz({
      directory,
      outDir,
      nodeExePath: 'C:\\node\\node.exe',
      pnpmCliPath: 'C:\\pnpm\\bin\\pnpm.cjs',
      run: async (options) => {
        seen = options;
        return { code: 0, stdout: `...\n${tgz}\n`, stderr: '' };
      },
    });

    expect(result).toBe(resolve(tgz));
    expect(seen?.cwd).toBe(directory);
    expect(seen?.args).toEqual([
      'C:\\pnpm\\bin\\pnpm.cjs',
      'pack',
      '--pack-destination',
      resolve(outDir),
      '--config.ignore-scripts=true',
    ]);
  });

  it('pnpm 退出码非 0 → 抛出可读错误（保留 stderr 尾部）', async () => {
    const { directory, outDir } = await fixture();
    await expect(
      packDirectoryToTgz({
        directory,
        outDir,
        nodeExePath: 'node.exe',
        pnpmCliPath: 'pnpm.cjs',
        run: async () => ({ code: 1, stdout: '', stderr: 'ERR_PNPM_INVALID_PACKAGE_JSON' }),
      }),
    ).rejects.toThrowError(/ERR_PNPM_INVALID_PACKAGE_JSON/);
  });

  it('命令没有报告产物路径 → 报错（不猜文件名）', async () => {
    const { directory, outDir } = await fixture();
    await expect(
      packDirectoryToTgz({
        directory,
        outDir,
        nodeExePath: 'node.exe',
        pnpmCliPath: 'pnpm.cjs',
        run: async () => ({ code: 0, stdout: 'no path here', stderr: '' }),
      }),
    ).rejects.toThrowError(/没有报告产物路径/);
  });

  it('报告了路径但文件不存在 → 报错', async () => {
    const { directory, outDir } = await fixture();
    await expect(
      packDirectoryToTgz({
        directory,
        outDir,
        nodeExePath: 'node.exe',
        pnpmCliPath: 'pnpm.cjs',
        run: async () => ({ code: 0, stdout: join(outDir, 'missing.tgz'), stderr: '' }),
      }),
    ).rejects.toThrowError(/打包产物不存在/);
  });
});
