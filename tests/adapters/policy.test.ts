import { describe, expect, it } from 'vitest';

import { assertArgsSafe, assertExecutableAllowed } from '@dda/adapters';
import { redact } from '@dda/core';

describe('命令策略', () => {
  it('只允许白名单可执行文件', () => {
    expect(assertExecutableAllowed('C:\\x\\node.exe')).toBe('node.exe');
    expect(assertExecutableAllowed('C:\\Windows\\System32\\reg.exe')).toBe('reg.exe');
    expect(() => assertExecutableAllowed('C:\\Windows\\System32\\cmd.exe')).toThrowError(/allowlist/);
    expect(() => assertExecutableAllowed('/bin/sh')).toThrowError(/allowlist/);
  });

  it('拒绝含 shell 元字符的参数', () => {
    expect(() => assertArgsSafe(['--version'])).not.toThrow();
    expect(() => assertArgsSafe(['a&b'])).toThrowError(/metacharacters/);
    expect(() => assertArgsSafe(['x|y'])).toThrowError(/metacharacters/);
    expect(() => assertArgsSafe(['$(rm -rf)'])).toThrowError(/metacharacters/);
  });
});

describe('日志脱敏', () => {
  it('抹掉 sk- 密钥与 appSecret', () => {
    const line = 'key=sk-abcdef1234567890 appSecret: abcdef1234567890 QQBOT_SECRET=zzzzzzzzzz';
    const out = redact(line);
    expect(out).not.toContain('sk-abcdef1234567890');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).not.toContain('zzzzzzzzzz');
    expect(out).toContain('[redacted]');
  });

  it('普通文本保持原样', () => {
    expect(redact('downloaded node-v22.23.4-win-x64.zip')).toBe('downloaded node-v22.23.4-win-x64.zip');
  });
});
