import { describe, expect, it } from 'vitest';

import { assertSafeEntryPath } from '@dda/core';

describe('assertSafeEntryPath (zip-slip 防护)', () => {
  it('接受普通相对路径', () => {
    expect(assertSafeEntryPath('node-v22.23.4-win-x64/node.exe')).toBe('node-v22.23.4-win-x64\\node.exe');
    expect(assertSafeEntryPath('a/b/c.txt')).toBe('a\\b\\c.txt');
  });

  it('拒绝父目录穿越', () => {
    expect(() => assertSafeEntryPath('../evil.exe')).toThrowError(/path traversal/);
    expect(() => assertSafeEntryPath('a/../../evil.exe')).toThrowError(/path traversal/);
  });

  it('拒绝绝对路径与盘符', () => {
    expect(() => assertSafeEntryPath('/etc/passwd')).toThrowError(/absolute path/);
    expect(() => assertSafeEntryPath('C:\\Windows\\System32\\evil.dll')).toThrowError(/absolute path/);
    expect(() => assertSafeEntryPath('//server/share/x')).toThrowError(/absolute path/);
  });

  it('拒绝空名与 NUL', () => {
    expect(() => assertSafeEntryPath('')).toThrowError(/empty or NUL/);
    expect(() => assertSafeEntryPath('a\0b')).toThrowError(/empty or NUL/);
  });

  it('忽略空段与当前目录段', () => {
    expect(assertSafeEntryPath('./a/./b.txt')).toBe('a\\b.txt');
    expect(assertSafeEntryPath('a//b.txt')).toBe('a\\b.txt');
  });
});
