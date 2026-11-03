import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeStartupError, recordStartupFailure } from '../../apps/desktop/src/main/startup-guard';

describe('启动失败处理', () => {
  it('错误摘要会脱敏，不会把密钥写进对话框或日志', () => {
    const error = new Error('fetch failed: apiKey=sk-live-abcdef1234567890 Bearer abcdefghijklmnop');
    const summary = describeStartupError(error);

    expect(summary).toContain('fetch failed');
    expect(summary).not.toContain('sk-live-abcdef1234567890');
    expect(summary).not.toContain('abcdefghijklmnop');
  });

  it('多行错误被压成一行，过长时截断', () => {
    const long = new Error(`line1\nline2\n${'x'.repeat(2000)}`);
    const summary = describeStartupError(long);
    expect(summary).not.toContain('\n');
    expect(summary.length).toBeLessThanOrEqual(601);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('非 Error 值也有可读摘要', () => {
    expect(describeStartupError('plain string')).toContain('plain string');
    expect(describeStartupError({ code: 'EACCES' })).toContain('EACCES');
    expect(describeStartupError(undefined)).toBe('undefined');
  });

  it('失败记录写入独立日志文件（脱敏 + 带堆栈）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-startup-'));
    const error = new Error('container 初始化失败 appSecret=super-secret-value');
    const record = await recordStartupFailure(dir, error, 'whenReady');

    expect(record.logPath).toBe(join(dir, 'startup-error.log'));
    expect(record.summary).toContain('container 初始化失败');
    expect(record.summary).not.toContain('super-secret-value');

    const written = await readFile(record.logPath!, 'utf8');
    expect(written).toContain('[whenReady]');
    expect(written).toContain('container 初始化失败');
    expect(written).not.toContain('super-secret-value');
  });

  it('日志目录不可写时依然返回可用摘要，不抛出二次异常', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-startup-blocked-'));
    const blocker = join(dir, 'blocked');
    // A file where the directory should be makes mkdir fail with EEXIST/ENOTDIR.
    await writeFile(blocker, 'x');

    const record = await recordStartupFailure(blocker, new Error('boom'));
    expect(record.summary).toContain('boom');
    expect(record.logPath).toBeUndefined();
    expect(await readdir(dir)).toEqual(['blocked']);
  });
});
