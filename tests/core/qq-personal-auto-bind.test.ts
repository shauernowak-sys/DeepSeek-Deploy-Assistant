import { describe, expect, it } from 'vitest';

import {
  chooseLatestPeer,
  chooseSession,
  latestMessageSec,
  readFriendUins,
  readLoginUin,
} from '@dda/core';

describe('个人 QQ 自动绑定的选择', () => {
  it('会话优先用最近改过的一间，时间相同则保留清单里的第一间', () => {
    expect(chooseSession(['ses_old', 'ses_new'], { ses_old: 10, ses_new: 20 })).toBe('ses_new');
    expect(chooseSession(['ses_a', 'ses_b'], {})).toBe('ses_a');
    expect(chooseSession([])).toBeUndefined();
  });

  it('从 OneBot 响应里读出登录号、好友号和最新消息时间', () => {
    expect(readLoginUin({ status: 'ok', data: { user_id: 10001, nickname: '小号' } })).toBe('10001');
    expect(readFriendUins({ data: [{ user_id: 20002 }, { uin: '不是号' }, { user_id: 30003 }] })).toEqual([
      '20002',
      '30003',
    ]);
    expect(latestMessageSec({ data: [{ time: 10 }, { time: 40 }, { time: '5' }] })).toBe(40);
    expect(latestMessageSec({ data: { messages: [{ time: 7 }] } })).toBe(7);
    expect(latestMessageSec({ data: [] })).toBe(0);
  });

  it('只接最近说过话的那个 QQ，没说过话的不选', () => {
    expect(
      chooseLatestPeer([
        { uin: '20002', latestSec: 10 },
        { uin: '30003', latestSec: 50 },
        { uin: '40004', latestSec: 0 },
      ]),
    ).toBe('30003');
    expect(chooseLatestPeer([{ uin: '20002', latestSec: 0 }])).toBeUndefined();
  });
});
