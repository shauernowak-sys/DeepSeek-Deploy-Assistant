/**
 * 个人 QQ 自动绑定用的纯选择。
 * 不访问网络、不读令牌：调用方把已经取到的会话时间和好友历史传进来。
 */

export function chooseSession(
  ids: readonly string[],
  mtimeMs: Readonly<Record<string, number>> = {},
): string | undefined {
  if (ids.length === 0) return undefined;
  let best = ids[0]!;
  let bestTime = mtimeMs[best] ?? 0;
  for (const id of ids.slice(1)) {
    const time = mtimeMs[id] ?? 0;
    if (time > bestTime) {
      best = id;
      bestTime = time;
    }
  }
  return best;
}

export function readLoginUin(body: unknown): string | undefined {
  const data = recordData(body);
  const raw = data?.user_id ?? data?.uin;
  return asUin(raw);
}

export function readFriendUins(body: unknown): string[] {
  const data = (body != null && typeof body === 'object' ? (body as { data?: unknown }).data : undefined) ?? body;
  if (!Array.isArray(data)) return [];
  const uins: string[] = [];
  for (const item of data) {
    if (item == null || typeof item !== 'object') continue;
    const row = item as { user_id?: unknown; uin?: unknown };
    const uin = asUin(row.user_id ?? row.uin);
    if (uin) uins.push(uin);
  }
  return uins;
}

/** 一段好友历史里最新一条的 Unix 秒。没有消息则是 0。 */
export function latestMessageSec(body: unknown): number {
  const data = (body != null && typeof body === 'object' ? (body as { data?: unknown }).data : undefined) ?? body;
  const messages = Array.isArray(data)
    ? data
    : data != null && typeof data === 'object' && Array.isArray((data as { messages?: unknown }).messages)
      ? (data as { messages: unknown[] }).messages
      : [];
  let max = 0;
  for (const item of messages) {
    if (item == null || typeof item !== 'object') continue;
    const time = (item as { time?: unknown }).time;
    const sec = typeof time === 'number' ? time : typeof time === 'string' ? Number(time) : Number.NaN;
    if (Number.isFinite(sec) && sec > max) max = sec;
  }
  return max;
}

/** 选最近说过话的那个 QQ。时间相同则保留先出现的一个。 */
export function chooseLatestPeer(peers: readonly { uin: string; latestSec: number }[]): string | undefined {
  let best: { uin: string; latestSec: number } | undefined;
  for (const peer of peers) {
    if (!peer.uin || peer.latestSec <= 0) continue;
    if (!best || peer.latestSec > best.latestSec) best = peer;
  }
  return best?.uin;
}

function recordData(body: unknown): Record<string, unknown> | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const data = (body as { data?: unknown }).data;
  if (data != null && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return body as Record<string, unknown>;
}

function asUin(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : typeof value === 'string' ? value.trim() : '';
  return /^\d{5,15}$/.test(text) ? text : undefined;
}
