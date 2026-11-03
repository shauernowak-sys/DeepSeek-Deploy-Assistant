import { describe, expect, it } from 'vitest';

import { checkQqVersion, collectQrArt, deriveQqStatus, isQrArtLine, parseQqLine, type QqOutputEvent } from '@dda/core';
import type { QqCredentialSource } from '@dda/spec';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 3, 0, 0, seconds)).toISOString();
const now = new Date(Date.UTC(2026, 10, 3, 0, 5, 0));

function base(overrides: Partial<Parameters<typeof deriveQqStatus>[0]> = {}) {
  return deriveQqStatus({
    harnessInstalled: true,
    harnessRunning: true,
    pluginInstalled: true,
    pluginVersion: '0.5.5',
    expectedVersion: '0.5.5',
    credentialSource: 'dpapi' as QqCredentialSource,
    events: [],
    startedAt: at(0),
    now,
    ...overrides,
  });
}

const events = (items: QqOutputEvent[]) => items.map((event, index) => ({ at: at(index), event }));

describe('QQ 输出行解析（行文本取自插件真实输出）', () => {
  it('识别官方扫码提示与 q.qq.com 链接', () => {
    expect(parseQqLine('请使用手机 QQ 扫描上方二维码，完成机器人绑定。')).toEqual({ kind: 'bind-qr' });
    const link = parseQqLine(
      '  https://q.qq.com/qqbot/openclaw/connect.html?task_id=1f00dbf5-b289&source=dsh-qqbot&_wv=2\u001b]8;;x\u0007',
    );
    expect(link?.kind).toBe('bind-link');
    expect((link as { url: string }).url).toContain('q.qq.com/qqbot/openclaw');
    expect(parseQqLine('二维码已过期，正在刷新…')).toEqual({ kind: 'bind-expired' });
  });

  it('识别网关就绪与断开/放弃（真实代码里的输出）', () => {
    expect(parseQqLine('[im-qqbot] Bot ready! appId=102000001')).toEqual({ kind: 'ready', appId: '102000001' });
    expect(parseQqLine('Bot disconnected (4009), reconnecting...')?.kind).toBe('reconnect');
    expect(parseQqLine('Bot disconnected permanently (4013), giving up')?.kind).toBe('give-up');
    expect(parseQqLine('Bot start failed: invalid appid')?.kind).toBe('give-up');
    expect(parseQqLine('dsh web: http://127.0.0.1:1234/?token=abc')).toBeUndefined();
  });

  it('去掉 OSC 8 超链接控制序列，链接只保留一次（真实输出里出现两种终止符）', () => {
    const osc = '\u001b]8;;https://q.qq.com/qqbot/openclaw/connect.html?task_id=abc&source=dsh-qqbot\u001b\\';
    const line = `  ${osc}https://q.qq.com/qqbot/openclaw/connect.html?task_id=abc&source=dsh-qqbot\u001b]8;;\u001b\\`;
    const parsed = parseQqLine(line);
    expect(parsed).toEqual({ kind: 'bind-link', url: 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=abc&source=dsh-qqbot' });
    const evidence = deriveQqStatus({
      harnessInstalled: true,
      harnessRunning: true,
      pluginInstalled: true,
      pluginVersion: '0.5.5',
      expectedVersion: '0.5.5',
      credentialSource: 'none',
      events: [{ at: at(1), event: parsed! }],
      startedAt: at(0),
      now,
    });
    expect(evidence.evidence.some((e) => e.line.includes('\u001b'))).toBe(false);
    expect(evidence.evidence.some((e) => e.line.includes('task_id=<redacted>'))).toBe(true);
  });
});

describe('QQ 状态机（只依据运行时证据）', () => {
  it('未部署 / 未安装 / 版本不匹配 优先于运行状态', () => {
    expect(base({ harnessInstalled: false }).phase).toBe('not-deployed');
    expect(base({ pluginInstalled: false }).phase).toBe('not-installed');
    const mismatch = base({ pluginVersion: '0.4.0' });
    expect(mismatch.phase).toBe('version-mismatch');
    expect(mismatch.nextStep).toContain('修复');
  });

  it('插件已装但 Harness 未运行 → installed（不谎称已连接）', () => {
    const status = base({ harnessRunning: false, credentialSource: 'dpapi' });
    expect(status.phase).toBe('installed');
  });

  it('无凭据：没有扫码链接是未授权，有链接是等待扫码', () => {
    expect(base({ credentialSource: 'none' }).phase).toBe('unbound');
    const binding = base({
      credentialSource: 'none',
      events: events([{ kind: 'bind-qr' }, { kind: 'bind-link', url: 'https://q.qq.com/qqbot/x?task_id=1' }]),
    });
    expect(binding.phase).toBe('binding');
    expect(binding.bindUrl).toContain('q.qq.com');
  });

  it('Bot ready → 已连接，并带上 appId 与运行时依据', () => {
    const status = base({ events: events([{ kind: 'ready', appId: '102000001' }]) });
    expect(status.phase).toBe('connected');
    expect(status.appId).toBe('102000001');
    expect(status.evidence.some((e) => e.line.includes('Bot ready'))).toBe(true);
  });

  it('断开后重连 / 永久失败 / 超时 分别判定', () => {
    const reconnecting = base({
      events: events([{ kind: 'ready' }, { kind: 'reconnect', detail: 'Bot disconnected' }]),
    });
    expect(reconnecting.phase).toBe('reconnecting');

    const failed = base({ events: events([{ kind: 'reconnect', detail: 'x' }, { kind: 'give-up', detail: 'y' }]) });
    expect(failed.phase).toBe('failed');

    // 有凭据、进程在跑，但很久没有 ready → 失败（不是"已连接"）
    const timeout = base({ startedAt: at(-600), now });
    expect(timeout.phase).toBe('failed');

    // 刚启动 → 连接中
    expect(base({ startedAt: at(290) }).phase).toBe('connecting');
  });

  it('重新 ready 覆盖之前的失败', () => {
    const status = base({
      events: events([{ kind: 'give-up', detail: 'x' }, { kind: 'ready', appId: '1' }]),
    });
    expect(status.phase).toBe('connected');
  });

  it('配置写盘无法影响判定：仅凭"有凭据"不会得到 connected', () => {
    const status = base({ credentialSource: 'profile', appId: '102000001', startedAt: at(290) });
    expect(status.phase).toBe('connecting');
  });
});

describe('扫码流程：超时、失败原因、二维码展示（回归）', () => {
  const bindingBase = (overrides: Partial<Parameters<typeof deriveQqStatus>[0]> = {}) =>
    deriveQqStatus({
      harnessInstalled: true,
      harnessRunning: true,
      pluginInstalled: true,
      pluginVersion: '0.5.5',
      expectedVersion: '0.5.5',
      credentialSource: 'none',
      events: [],
      startedAt: at(0),
      now,
      ...overrides,
    });

  it('点了扫码、还没拿到链接 → binding 且提示"正在申请"', () => {
    const status = bindingBase({ bindingStartedAt: at(299) }); // 1 秒前
    expect(status.phase).toBe('binding');
    expect(status.message).toContain('正在向 QQ 官方申请二维码');
  });

  it('超时且插件没有任何绑定输出 → failed 且指明"插件无输出"', () => {
    const status = bindingBase({ bindingStartedAt: at(0) });
    expect(status.phase).toBe('failed');
    expect(status.nextStep).toContain('插件没有任何绑定相关输出');
    expect(status.nextStep).toContain('重新生成二维码');
  });

  it('超时但插件进过扫码流程 → 原因指向 q.qq.com 不可达/凭据仍在环境', () => {
    const status = bindingBase({
      bindingStartedAt: at(0),
      events: events([{ kind: 'no-credential' }]),
    });
    expect(status.phase).toBe('failed');
    expect(status.nextStep).toContain('q.qq.com');
  });

  it('拿到链接就不是失败（即使已经开始计时）', () => {
    const status = bindingBase({
      bindingStartedAt: at(0),
      events: events([{ kind: 'bind-link', url: 'https://q.qq.com/qqbot/x?task_id=1' }]),
    });
    expect(status.phase).toBe('binding');
    expect(status.bindUrl).toContain('q.qq.com');
  });

  it('二维码图形随状态下发，界面可直接展示', () => {
    const qr = ['█▀▀▀█ ▄▀▄ █▀▀▀█', '█▄▄▄█ ▀▄▀ █▄▄▄█'];
    const status = bindingBase({
      bindingStartedAt: at(0),
      events: events([{ kind: 'bind-link', url: 'https://q.qq.com/qqbot/x?task_id=1' }]),
      bindQr: qr,
    });
    expect(status.bindQr).toEqual(qr);
  });
});

describe('二维码图形抽取（只认半块字符行）', () => {
  it('抽出最后一段连续二维码，忽略普通日志', () => {
    const lines = [
      'dsh web: http://127.0.0.1:1/?token=x',
      '█▀▀▀█ ▄▀▄ █▀▀▀█',
      '█▄▄▄█ ▀▄▀ █▄▄▄█',
      '请使用手机 QQ 扫描上方二维码，完成机器人绑定。',
    ];
    expect(collectQrArt(lines)).toEqual(['█▀▀▀█ ▄▀▄ █▀▀▀█', '█▄▄▄█ ▀▄▀ █▄▄▄█']);
    expect(collectQrArt(['no qr here'])).toEqual([]);
    expect(isQrArtLine('████ ▄▄▄▄ ████')).toBe(true);
    expect(isQrArtLine('Bot ready! appId=1')).toBe(false);
  });
});

describe('插件版本判定（固定版本，不用 latest）', () => {
  it('缺失 / 不一致 / 一致', () => {
    expect(checkQqVersion(undefined, '0.5.5').state).toBe('missing');
    expect(checkQqVersion('0.5.4', '0.5.5').state).toBe('mismatch');
    expect(checkQqVersion('0.5.5', '0.5.5').state).toBe('ok');
  });
});
