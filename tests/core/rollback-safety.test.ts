import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyRollbackTargets, isPathInside, rollbackPlan } from '@dda/core';
import type { JournalData } from '@dda/core';

async function makeRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'dda-safety-'));
  const root = join(base, 'DeepSeekDeployAssistant');
  await mkdir(root, { recursive: true });
  return root;
}

function journalWith(created: string[]): JournalData {
  return {
    taskId: 'safety',
    scenario: 'full-deploy',
    status: 'succeeded',
    startedAt: new Date().toISOString(),
    steps: [],
    created,
  };
}

describe('回滚安全：允许删除的范围', () => {
  it('isPathInside 是分隔符感知的，前缀相似的兄弟目录不算内部', () => {
    const root = join('C:', 'Users', 'x', 'AppData', 'Local', 'DeepSeekDeployAssistant');
    expect(isPathInside(join(root, 'runtimes', 'node'), root)).toBe(true);
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(`${root}-evil`, root)).toBe(false);
    expect(isPathInside(join(root, '..', 'other'), root)).toBe(false);
  });

  it('受管目录内的产物才允许删除，且真的被删掉', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'runtimes', 'node', '22.23.4');
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, 'node.exe'), 'x');

    const targets = await classifyRollbackTargets([artifact], { roots: [root] });
    expect(targets).toEqual([{ path: artifact, exists: true, deletable: true }]);

    const data = journalWith([artifact]);
    const outcome = await rollbackPlan(data, [], () => undefined, { allowedRoots: [root], pruneAbove: root });
    expect(outcome.deleted).toEqual([artifact]);
    expect(outcome.refused).toEqual([]);
    expect(data.status).toBe('rolled-back');
    // Empty parents below the managed root are pruned, the root itself survives.
    expect(await readdir(root)).toEqual([]);
  });

  it('受管目录之外的用户文件即使写进 journal 也拒绝删除', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'dda-user-docs-'));
    const userFile = join(outside, 'important.txt');
    await writeFile(userFile, 'keep me');

    const targets = await classifyRollbackTargets([userFile], { roots: [root] });
    expect(targets[0]?.deletable).toBe(false);
    expect(targets[0]?.reason).toContain('不在本软件管理目录内');

    const data = journalWith([userFile]);
    const outcome = await rollbackPlan(data, [], () => undefined, { allowedRoots: [root] });
    expect(outcome.deleted).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(await readFile(userFile, 'utf8')).toBe('keep me');
  });

  it('前缀相似的兄弟目录不会被递归删除', async () => {
    const root = await makeRoot();
    const sibling = `${root}-backup`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'user.txt'), 'keep');

    const targets = await classifyRollbackTargets([sibling], { roots: [root] });
    expect(targets[0]?.deletable).toBe(false);

    const data = journalWith([sibling]);
    const outcome = await rollbackPlan(data, [], () => undefined, { allowedRoots: [root] });
    expect(outcome.deleted).toEqual([]);
    expect(await readFile(join(sibling, 'user.txt'), 'utf8')).toBe('keep');
  });

  it('受管根目录本身永远不允许删除', async () => {
    const root = await makeRoot();
    const targets = await classifyRollbackTargets([root, join(root, '.')], { roots: [root] });
    for (const target of targets) {
      expect(target.deletable).toBe(false);
      expect(target.reason).toContain('根目录');
    }
  });

  it('相对路径与路径穿越都被拒绝', async () => {
    const root = await makeRoot();
    const targets = await classifyRollbackTargets(['runtimes/node', join(root, '..', 'escape')], { roots: [root] });
    expect(targets.every((t) => !t.deletable)).toBe(true);
    expect(targets[0]?.reason).toContain('绝对路径');
    expect(targets[1]?.reason).toContain('不在本软件管理目录内');
  });

  it('软链接/联接点指向受管目录之外时拒绝删除', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'dda-symlink-target-'));
    await writeFile(join(outside, 'sentinel.txt'), 'keep');
    const link = join(root, 'runtimes-link');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Creating links needs privileges on some Windows setups; the rule is still covered above.
      return;
    }

    const targets = await classifyRollbackTargets([link], { roots: [root] });
    expect(targets[0]?.deletable).toBe(false);
    expect(targets[0]?.reason).toMatch(/软链接|穿越/);

    const data = journalWith([link]);
    const outcome = await rollbackPlan(data, [], () => undefined, { allowedRoots: [root] });
    expect(outcome.deleted).toEqual([]);
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('父目录是软链接时，路径穿越同样被拒绝', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'dda-symlink-parent-'));
    const linkDir = join(root, 'linked');
    try {
      await symlink(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const escaped = join(linkDir, 'created-by-us');
    await mkdir(escaped, { recursive: true });
    await writeFile(join(escaped, 'keep.txt'), 'keep');

    const targets = await classifyRollbackTargets([escaped], { roots: [root] });
    expect(targets[0]?.deletable).toBe(false);
    expect(targets[0]?.reason).toContain('路径穿越');
    expect(await readFile(join(outside, 'created-by-us', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('已不存在的记录路径不算删除失败', async () => {
    const root = await makeRoot();
    const missing = join(root, 'runtimes', 'pnpm');
    const targets = await classifyRollbackTargets([missing], { roots: [root] });
    expect(targets[0]).toMatchObject({ deletable: true, exists: false });

    const data = journalWith([missing]);
    const outcome = await rollbackPlan(data, [], () => undefined, { allowedRoots: [root] });
    expect(outcome.deleted).toEqual([]);
    expect(outcome.refused).toEqual([]);
  });

  it('未配置 allowedRoots 时保持旧行为（引擎单测与自定义根目录）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-no-roots-'));
    const created = join(dir, 'artifact');
    await mkdir(created, { recursive: true });

    const data = journalWith([created]);
    const outcome = await rollbackPlan(data, [], () => undefined);
    expect(outcome.deleted).toEqual([created]);
  });
});
