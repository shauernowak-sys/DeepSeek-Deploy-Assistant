import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ApiSaveSchema,
  DiagExportSchema,
  TaskCancelSchema,
  TaskIdSchema,
  TaskRollbackSchema,
  TaskStartSchema,
} from '@dda/spec';

/**
 * Guards the three-way contract (main handler ↔ preload allowlist ↔ renderer call sites).
 * It parses the real sources instead of a hand-maintained list, so drift fails the build
 * instead of showing up as `No handler registered for 'api:refs'` at runtime.
 */
const repoRoot = join(__dirname, '../..');

function read(relative: string): string {
  return readFileSync(join(repoRoot, relative), 'utf8');
}

const mainSources = ['apps/desktop/src/main/ipc/register.ts', 'apps/desktop/src/main/index.ts'].map(read);
const registerSource = mainSources[0]!;
const preloadSource = read('apps/desktop/src/preload/index.ts');
const rendererSources = [
  'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/components/PersonalQqPanel.tsx',
  'apps/desktop/src/renderer/src/main.tsx',
].map(read);

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((m) => m[1]!);
}

/** Channels the main process actually handles. */
const handled = matches(registerSource, /ipcMain\.handle\(\s*'([^']+)'/g);
/** Channels preload can call. */
const invoked = matches(preloadSource, /ipcRenderer\.invoke\(\s*'([^']+)'/g);
/** One-way channels preload listens on. */
const subscribed = matches(preloadSource, /ipcRenderer\.on\(\s*'([^']+)'/g);
/** Methods on the object exposed as `window.dda`. */
const exposedMethods = matches(preloadSource, /^ {2}([A-Za-z0-9_]+):/gm);
/** Methods the renderer actually calls. */
const calledMethods = [...new Set(rendererSources.flatMap((source) => matches(source, /\bapi\.([A-Za-z0-9_]+)/g)))];

describe('IPC 契约：主进程 / preload / 渲染层一致', () => {
  it('preload 的每个 invoke channel 都有主进程 handler', () => {
    expect(invoked.filter((channel) => !handled.includes(channel))).toEqual([]);
  });

  it('主进程没有渲染层无法调用的死通道', () => {
    expect(handled.filter((channel) => !invoked.includes(channel))).toEqual([]);
  });

  it('不存在重复注册或重复暴露的 channel', () => {
    expect(handled).toHaveLength(new Set(handled).size);
    expect(invoked).toHaveLength(new Set(invoked).size);
    expect(exposedMethods).toHaveLength(new Set(exposedMethods).size);
  });

  it('preload 订阅的事件 channel 都由主进程发送', () => {
    const sent = mainSources.flatMap((source) => matches(source, /webContents\.send\(\s*'([^']+)'/g));
    expect(subscribed.filter((channel) => !sent.includes(channel))).toEqual([]);
  });

  it('渲染层只调用 preload 中真实存在的方法', () => {
    expect(calledMethods.filter((method) => !exposedMethods.includes(method))).toEqual([]);
  });

  it('preload 不暴露零调用的方法（无效接口）', () => {
    // `onTaskEvent` / `onDeployEvent` are subscribed via `api.<name>`, so they are covered too.
    expect(exposedMethods.filter((method) => !calledMethods.includes(method))).toEqual([]);
  });

  it('危险通道要求显式确认参数', () => {
    const rollbackHandler = registerSource.slice(registerSource.indexOf("'task:rollback'"));
    expect(rollbackHandler).toContain('TaskRollbackSchema.parse');
    expect(registerSource).toContain("'task:rollback-preview'");
  });
});

describe('IPC 参数校验', () => {
  it('task:start 只接受 full-deploy 场景，且必须携带已确认的 planId', () => {
    expect(
      TaskStartSchema.parse({ scenario: 'full-deploy', planId: 'plan-12345678', confirmed: true }),
    ).toEqual({ scenario: 'full-deploy', fresh: false, planId: 'plan-12345678', confirmed: true, qqMode: 'official' });
    expect(TaskStartSchema.parse({ scenario: 'full-deploy', planId: 'plan-12345678', confirmed: true, qqMode: 'personal' }).qqMode).toBe('personal');
    expect(() => TaskStartSchema.parse({ scenario: 'full-deploy', planId: 'plan-12345678', confirmed: true, qqMode: 'invalid' })).toThrow();
    expect(() => TaskStartSchema.parse({ scenario: 'other' })).toThrow();
    expect(() => TaskStartSchema.parse({ scenario: 'full-deploy', planId: 'plan-12345678', confirmed: true, extra: 1 })).toThrow();
    // 没有决策 planId / 没有显式确认，一律拒绝：UI 不得绕过门禁。
    expect(() => TaskStartSchema.parse({ scenario: 'full-deploy' })).toThrow();
    expect(() => TaskStartSchema.parse({ scenario: 'full-deploy', planId: 'plan-12345678' })).toThrow();
    expect(() => TaskStartSchema.parse({ scenario: 'full-deploy', confirmed: true })).toThrow();
    expect(() =>
      TaskStartSchema.parse({ scenario: 'full-deploy', planId: 'short', confirmed: true }),
    ).toThrow();
  });

  it('taskId 不能为空，且拒绝多余字段', () => {
    expect(TaskIdSchema.parse({ taskId: 'abc' })).toEqual({ taskId: 'abc' });
    expect(() => TaskIdSchema.parse({ taskId: '' })).toThrow();
    expect(() => TaskIdSchema.parse({})).toThrow();
    expect(() => TaskIdSchema.parse({ taskId: 'abc', force: true })).toThrow();
  });

  it('task:cancel 必须明确 cleanup 布尔值', () => {
    expect(TaskCancelSchema.parse({ taskId: 'abc', cleanup: false })).toEqual({ taskId: 'abc', cleanup: false });
    expect(() => TaskCancelSchema.parse({ taskId: 'abc' })).toThrow();
    expect(() => TaskCancelSchema.parse({ taskId: 'abc', cleanup: 'yes' })).toThrow();
  });

  it('task:rollback 必须带 confirmed 布尔值（二次确认不可省略）', () => {
    expect(TaskRollbackSchema.parse({ taskId: 'abc', confirmed: true })).toEqual({ taskId: 'abc', confirmed: true });
    expect(() => TaskRollbackSchema.parse({ taskId: 'abc' })).toThrow();
    expect(() => TaskRollbackSchema.parse({ taskId: 'abc', confirmed: 'true' })).toThrow();
  });

  it('diag:export 只有 confirmed=true 才继续', () => {
    expect(DiagExportSchema.parse({ confirmed: false })).toEqual({ confirmed: false });
    expect(() => DiagExportSchema.parse({ confirmed: 1 })).toThrow();
  });

  it('api:save 拒绝未知字段（防止渲染层顺手塞进明文密钥字段）', () => {
    const config = {
      template: 'deepseek',
      label: 'DeepSeek',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      credentialRef: 'DEEPSEEK_API_KEY',
    };
    expect(ApiSaveSchema.parse({ config }).config).toEqual(config);
    expect(() => ApiSaveSchema.parse({ config, apiKeyPlain: 'sk-x' })).toThrow();
    expect(() => ApiSaveSchema.parse({ config: { ...config, credentialRef: 'bad ref' } })).toThrow();
  });
});
