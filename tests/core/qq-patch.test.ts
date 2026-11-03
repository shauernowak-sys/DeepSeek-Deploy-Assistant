import { describe, expect, it } from 'vitest';

import {
  applyManagedBlock,
  applyQqSection,
  buildQqEntry,
  hasManagedBlock,
  hasManagedSection,
  QQ_MANAGED_SECTION,
  readQqEntry,
  readQqSettings,
  readStoredCredentials,
  removeManagedBlock,
  removeQqSection,
} from '@dda/core';
import { DEFAULT_QQ_SETTINGS, type QqSettings } from '@dda/spec';

const apiConfig = {
  template: 'deepseek' as const,
  label: 'DeepSeek 官方',
  protocol: 'anthropic-messages' as const,
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
  credentialRef: 'DEEPSEEK_API_KEY',
  contextWindow: 1_000_000,
};

const custom: QqSettings = {
  requireMention: false,
  groupPrompt: '群里的额外提示',
  directPrompt: '私聊的额外提示',
  streaming: false,
  textChunkLimit: 3000,
  historyLimit: 5,
  access: { c2cMode: 'allowlist', c2cAllow: ['openid-a'], groupMode: 'allowlist', groupAllow: ['group-a'] },
  mediaEnabled: false,
  sendFileRestrictPaths: false,
};

describe('QQ 受管块：字段必须写全（覆盖是整体替换，不是合并）', () => {
  it('env 模式写入 __FROM_ENV__ 与所有设置字段', () => {
    const entry = buildQqEntry(custom, { mode: 'env' });
    expect(entry.id).toBe('im-qqbot');
    expect(entry.config.appId).toBe('__FROM_ENV__');
    expect(entry.config.appSecret).toBe('__FROM_ENV__');
    expect(entry.config.requireMention).toBe(false);
    expect(entry.config.streaming).toBe(false);
    expect(entry.config.textChunkLimit).toBe(3000);
    expect(entry.config.historyLimit).toBe(5);
    expect(entry.config.groupPrompt).toBe('群里的额外提示');
    expect(entry.config.directPrompt).toBe('私聊的额外提示');
    expect(entry.config.access).toEqual({
      c2cMode: 'allowlist',
      c2cAllow: ['openid-a'],
      groupMode: 'allowlist',
      groupAllow: ['group-a'],
    });
    expect(entry.config.media).toEqual({ enabled: false });
    expect(entry.config.sendFile).toEqual({ restrictPaths: false });
  });

  it('qr 模式不写 appId/appSecret（让插件走官方扫码），但保留插件已写入的值', () => {
    const empty = buildQqEntry(DEFAULT_QQ_SETTINGS, { mode: 'qr' });
    expect('appId' in empty.config).toBe(false);
    expect('appSecret' in empty.config).toBe(false);

    const preserved = buildQqEntry(DEFAULT_QQ_SETTINGS, {
      mode: 'qr',
      preserved: { appId: '102000000', appSecret: 'secret-value' },
    });
    expect(preserved.config.appId).toBe('102000000');
    expect(preserved.config.appSecret).toBe('secret-value');
  });
});

describe('QQ 受管块：与 M3.1 的 API 受管块共存', () => {
  it('两个块各自写入互不覆盖，删除 QQ 块后 API 块完好', () => {
    let text = applyManagedBlock('[]\n', apiConfig);
    expect(hasManagedBlock(text)).toBe(true);

    text = applyQqSection(text, custom, { mode: 'env' });
    expect(hasManagedBlock(text)).toBe(true);
    expect(hasManagedSection(text, QQ_MANAGED_SECTION)).toBe(true);
    // M3.1 的条目仍在
    expect(text).toContain('id: llm-deepseek');
    expect(text).toContain('apiKeyEnv: DEEPSEEK_API_KEY');
    // 重复写入 QQ 块是幂等的
    const again = applyQqSection(text, custom, { mode: 'env' });
    expect(again.match(/dda:managed:qq:begin/g)).toHaveLength(1);

    const removed = removeQqSection(again);
    expect(hasManagedSection(removed, QQ_MANAGED_SECTION)).toBe(false);
    expect(removed).toContain('id: llm-deepseek');
    expect(removed).not.toContain('im-qqbot');
  });

  it('用户自己写的条目与注释不会被 QQ 块覆盖', () => {
    const usersPatch = '# 我的注释\n- id: my-entry\n  config:\n    keep: true\n';
    const next = applyQqSection(usersPatch, DEFAULT_QQ_SETTINGS, { mode: 'env' });
    expect(next).toContain('# 我的注释');
    expect(next).toContain('id: my-entry');
    expect(next).toContain('im-qqbot');
    expect(removeQqSection(next)).toContain('id: my-entry');
  });
});

describe('QQ 受管块：回读', () => {
  const patch = applyQqSection(applyManagedBlock('[]\n', apiConfig), custom, { mode: 'env' });

  it('readQqEntry / readQqSettings 读到我们写的值', () => {
    const entry = readQqEntry(patch);
    expect(entry.present).toBe(true);
    expect(readQqSettings(patch)).toEqual({ ...custom, groupPrompt: '群里的额外提示', directPrompt: '私聊的额外提示' });
  });

  it('占位符不算明文凭据；插件写入的字面值才算', () => {
    expect(readStoredCredentials(patch).plaintext).toBe(false);

    const scanned = applyQqSection(patch, custom, {
      mode: 'qr',
      preserved: { appId: '102000000', appSecret: 'plugin-written-secret' },
    });
    const stored = readStoredCredentials(scanned);
    expect(stored.plaintext).toBe(true);
    expect(stored.appId).toBe('102000000');
    expect(stored.appSecret).toBe('plugin-written-secret');
  });

  it('缺失条目时回退到插件默认值，不抛异常', () => {
    expect(readQqEntry('[]\n')).toEqual({ present: false, config: {} });
    expect(readQqSettings('[]\n')).toEqual(DEFAULT_QQ_SETTINGS);
    expect(readStoredCredentials('not: [valid').plaintext).toBe(false);
  });
});
