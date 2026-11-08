/**
 * Aurabot 的设置向导只检查它自己配置里的 `snowluma.dir`。
 * 默认是 `C:\Aurabot\snowluma`。那里没有文件时，向导就要求用户再下载一次，
 * 即使本软件已经装好了一份。
 *
 * 只有当前目录不是一份可用安装时才改；用户另外指向一份能用的目录时不动。
 * Aurabot 拒绝非 ASCII 路径，那种目录不能写进去。
 */

export function shouldPointAurabotAtInstall(input: {
  currentDir: string;
  currentHasEntry: boolean;
  candidateDir: string;
  candidateHasEntry: boolean;
}): { update: boolean; reason: string } {
  const candidate = input.candidateDir.trim();
  if (!candidate || !input.candidateHasEntry) {
    return { update: false, reason: '没有可用的 SnowLuma 安装目录' };
  }
  if (/[^\x00-\x7f]/.test(candidate)) {
    return { update: false, reason: 'SnowLuma 目录含有非英文路径，Aurabot 不接受' };
  }
  const current = input.currentDir.trim();
  if (current === candidate && input.currentHasEntry) {
    return { update: false, reason: 'Aurabot 已经指向这份安装' };
  }
  if (input.currentHasEntry && current !== candidate) {
    return { update: false, reason: 'Aurabot 已经指向另一份可用安装' };
  }
  return { update: true, reason: '把 Aurabot 的 SnowLuma 目录改成已经安装的那一份' };
}
