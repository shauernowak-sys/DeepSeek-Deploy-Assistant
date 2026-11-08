import { describe, expect, it } from 'vitest';

import { shouldPointAurabotAtInstall } from '@dda/core';

describe('Aurabot 复用已安装的 SnowLuma', () => {
  it('默认目录不存在时，改成已经安装的那一份', () => {
    expect(
      shouldPointAurabotAtInstall({
        currentDir: 'C:\\Aurabot\\snowluma',
        currentHasEntry: false,
        candidateDir: 'D:\\SnowLuma\\SnowLuma-v2.4.2-win-x64',
        candidateHasEntry: true,
      }),
    ).toEqual({ update: true, reason: '把 Aurabot 的 SnowLuma 目录改成已经安装的那一份' });
  });

  it('已经指向一份可用安装时不覆盖', () => {
    const same = shouldPointAurabotAtInstall({
      currentDir: 'D:\\SnowLuma',
      currentHasEntry: true,
      candidateDir: 'D:\\SnowLuma',
      candidateHasEntry: true,
    });
    expect(same.update).toBe(false);

    const other = shouldPointAurabotAtInstall({
      currentDir: 'D:\\Other\\snowluma',
      currentHasEntry: true,
      candidateDir: 'D:\\SnowLuma',
      candidateHasEntry: true,
    });
    expect(other.update).toBe(false);
  });

  it('非英文路径不能写给 Aurabot', () => {
    expect(
      shouldPointAurabotAtInstall({
        currentDir: '',
        currentHasEntry: false,
        candidateDir: 'D:\\雪\\snowluma',
        candidateHasEntry: true,
      }).update,
    ).toBe(false);
  });
});
