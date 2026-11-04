import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appPaths, loadDeploymentQqMode, runtimeSelectionPath, saveRuntimeSelection } from '@dda/adapters';

describe('部署路线持久化', () => {
  it('保存并重新读取个人 QQ 路线，旧任务保持官方路线', async () => {
    const paths = appPaths(await mkdtemp(join(tmpdir(), 'dda-qq-route-')));
    const runtime = { node: { mode: 'system' as const, exe: process.execPath, dir: tmpdir() }, harness: { mode: 'managed' as const } };
    await saveRuntimeSelection(paths, runtime, 'plan-12345678', 'personal');
    expect(await loadDeploymentQqMode(paths)).toBe('personal');
    const file = runtimeSelectionPath(paths);
    const legacy = JSON.parse(await readFile(file, 'utf8'));
    delete legacy.qqMode;
    await writeFile(file, JSON.stringify(legacy));
    expect(await loadDeploymentQqMode(paths)).toBe('official');
    legacy.qqMode = 'invalid';
    await writeFile(file, JSON.stringify(legacy));
    await expect(loadDeploymentQqMode(paths)).rejects.toThrow('部署路线记录无效');
  });
});
