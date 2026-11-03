import type { QqPhase, QqStatus, QqEvidence, QqCredentialSource } from '@dda/spec';

/**
 * 连接状态只能来自运行时可核对的证据（PRD §8 / 任务书 M3.2-03）：
 *  - 组合配置里出现 im-qqbot        → 插件被 Harness 加载
 *  - stdout 出现官方扫码链接         → 正在走官方授权
 *  - stdout 出现 `[im-qqbot] Bot ready! appId=…` → 真的连上了（QQ Bot API v2 WS 网关已就绪）
 *  - 进程在跑但迟迟没有 ready        → 连接中；超时后才判定失败
 * 配置文件存在、凭据存在都**不能**单独作为"已连接"的依据。
 */
export type QqOutputEvent =
  | { kind: 'bind-qr' }
  | { kind: 'bind-link'; url: string }
  | { kind: 'bind-expired' }
  | { kind: 'no-credential' }
  | { kind: 'ready'; appId?: string }
  | { kind: 'reconnect'; detail: string }
  | { kind: 'give-up'; detail: string }
  | { kind: 'config-reload' };

// ANSI CSI + OSC 8 hyperlinks (both BEL and ST terminators appear in real plugin output).
const ANSI = /\u001b\[[0-9;]*m|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI, '');
}

/**
 * 已知的输出行 → 事件。全部来自实际安装的插件源码：
 *  - setup/presenters.js: 终端呈现器打印二维码与官方链接
 *  - gateway/bootstrap.js: `console.log('[im-qqbot] Bot ready! appId=…')`；断开/放弃走 logger
 */
export function parseQqLine(rawLine: string): QqOutputEvent | undefined {
  const line = stripAnsi(rawLine).trim();
  if (!line) return undefined;

  if (/请使用手机 ?QQ ?扫描上方二维码/.test(line)) return { kind: 'bind-qr' };
  const link = /(https:\/\/q\.qq\.com\/qqbot\/[^\s"']+)/.exec(line);
  if (link) return { kind: 'bind-link', url: link[1]! };
  if (/二维码已过期/.test(line)) return { kind: 'bind-expired' };
  if (/凭据未配置/.test(line)) return { kind: 'no-credential' };
  if (/配置已保存，等待热更新重新加载/.test(line)) return { kind: 'config-reload' };

  const ready = /Bot ready! appId=(\d+)/.exec(line);
  if (ready) return { kind: 'ready', appId: ready[1] };
  if (/\[im-qqbot\]/.test(line) && /Bot ready/i.test(line)) return { kind: 'ready' };

  if (/permanently|giving up/i.test(line)) return { kind: 'give-up', detail: line };
  if (/disconnected|reconnect/i.test(line)) return { kind: 'reconnect', detail: line };
  if (/Bot start failed/i.test(line)) return { kind: 'give-up', detail: line };
  return undefined;
}

export interface QqStatusInput {
  harnessInstalled: boolean;
  harnessRunning: boolean;
  pluginInstalled: boolean;
  pluginVersion?: string;
  expectedVersion: string;
  credentialSource: QqCredentialSource;
  appId?: string;
  /** 本次 Harness 启动以来捕获到的插件事件（时间序）。 */
  events: { at: string; event: QqOutputEvent }[];
  /** Harness 启动时刻（用于"连接中超时"判定）。 */
  startedAt?: string;
  now?: Date;
  /** 有凭据但迟迟没有 ready，超过该时长判"失败"。 */
  readyTimeoutMs?: number;
  /** 用户最近一次点击扫码的时间；用于"官方二维码一直没有出现"的超时判定。 */
  bindingStartedAt?: string;
  bindingAttempts?: number;
  bindingTimeoutMs?: number;
  /** 插件终端呈现的 ASCII 二维码。 */
  bindQr?: string[];
}

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_BINDING_TIMEOUT_MS = 25_000;

function lastEvent<K extends QqOutputEvent['kind']>(
  events: { at: string; event: QqOutputEvent }[],
  kind: K,
): { at: string; event: Extract<QqOutputEvent, { kind: K }> } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const item = events[i]!;
    if (item.event.kind === kind) return item as { at: string; event: Extract<QqOutputEvent, { kind: K }> };
  }
  return undefined;
}

function lastIndex(events: { event: QqOutputEvent }[], kind: QqOutputEvent['kind']): number {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i]!.event.kind === kind) return i;
  return -1;
}

/** 事件 → 证据行（给用户看的"为什么是这个状态"）。 */
export function toEvidence(events: { at: string; event: QqOutputEvent }[]): QqEvidence[] {
  return events.slice(-8).map(({ at, event }) => ({
    at,
    source: 'stdout' as const,
    line: describeEvent(event),
  }));
}

export function describeEvent(event: QqOutputEvent): string {
  switch (event.kind) {
    case 'bind-qr':
      return '插件已生成绑定二维码';
    case 'bind-link':
      return `官方扫码链接：${event.url.replace(/task_id=[^&]+/, 'task_id=<redacted>')}`;
    case 'bind-expired':
      return '二维码已过期，插件正在刷新';
    case 'no-credential':
      return '插件未读到凭据，进入官方扫码绑定';
    case 'ready':
      return `网关已就绪（Bot ready${event.appId ? `，appId=${event.appId}` : ''}）`;
    case 'reconnect':
      return '连接断开，SDK 正在自动重连';
    case 'give-up':
      return '连接失败且不再重试';
    case 'config-reload':
      return '配置已写入，Harness 正在热重载插件';
  }
}

/** 二维码没出现时，给出可行动的原因（只依据已捕获的真实输出）。 */
export function bindingFailureReason(events: { event: QqOutputEvent }[]): string {
  const kinds = new Set(events.map((item) => item.event.kind));
  if (kinds.has('no-credential')) {
    return '插件已进入扫码流程但没有生成二维码（可能无法访问 q.qq.com，或凭据仍在环境里）';
  }
  if (kinds.has('bind-expired')) {
    return '二维码已过期且插件没有自动刷新';
  }
  if (kinds.size === 0) {
    return '插件没有任何绑定相关输出（插件可能没有加载，或 Harness 启动失败）';
  }
  return '插件输出里没有出现官方二维码链接';
}

/** 终端二维码用半块字符（▀▄█）绘制；只认这种行，避免把普通日志当二维码。 */
const QR_ART_LINE = /^[\u2580-\u259F \u2500-\u257F]{12,}$/;

export function isQrArtLine(line: string): boolean {
  const trimmed = line.replace(/\s+$/, '');
  return trimmed.length > 0 && QR_ART_LINE.test(trimmed);
}

/** 从输出行里抽出最后一段连续的二维码图形（最多 80 行）。 */
export function collectQrArt(lines: string[]): string[] {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isQrArtLine(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end === -1) return [];
  let start = end;
  while (start > 0 && isQrArtLine(lines[start - 1]!)) start -= 1;
  return lines.slice(Math.max(start, end - 79), end + 1);
}

export function deriveQqStatus(input: QqStatusInput): QqStatus {  const now = input.now ?? new Date();
  const checkedAt = now.toISOString();
  const evidence: QqEvidence[] = [];

  const base = {
    harnessInstalled: input.harnessInstalled,
    harnessRunning: input.harnessRunning,
    pluginInstalled: input.pluginInstalled,
    pluginVersion: input.pluginVersion,
    expectedVersion: input.expectedVersion,
    credentialSource: input.credentialSource,
    appId: input.appId,
    bindQr: input.bindQr,
    bindingStartedAt: input.bindingStartedAt,
    bindingTimeoutMs: input.bindingTimeoutMs ?? DEFAULT_BINDING_TIMEOUT_MS,
    bindingAttempts: input.bindingAttempts,
    evidence,
    checkedAt,
  };

  const phase = (value: QqPhase, message: string, nextStep: string): QqStatus => ({
    ...base,
    phase: value,
    message,
    nextStep,
  });

  if (!input.harnessInstalled) {
    return phase('not-deployed', 'Harness 尚未安装，QQ 插件无从加载', '先在第 3 节完成一键部署（含 QQ 插件安装）。');
  }
  if (!input.pluginInstalled) {
    return phase('not-installed', 'QQ 官方插件未安装', '点"安装 / 修复 QQ 插件"，等待完成后再启动 Harness。');
  }
  if (input.pluginVersion && input.pluginVersion !== input.expectedVersion) {
    return phase(
      'version-mismatch',
      `QQ 插件版本 ${input.pluginVersion} 与本版本验证过的 ${input.expectedVersion} 不一致`,
      '点"安装 / 修复 QQ 插件"把它装回验证过的版本，避免行为不可预期。',
    );
  }

  evidence.push({ at: checkedAt, source: 'plugin-list', line: `插件 ${input.pluginVersion ?? input.expectedVersion} 已安装` });

  if (!input.harnessRunning) {
    return phase('installed', '插件已安装，Harness 未运行', '点第 2 节"启动 Harness"后这里会显示 QQ 连接状态。');
  }

  const readyAt = lastEvent(input.events, 'ready');
  const giveUpAt = lastEvent(input.events, 'give-up');
  const reconnectAt = lastEvent(input.events, 'reconnect');
  const bindLinkAt = lastEvent(input.events, 'bind-link');
  const expiredAt = lastEvent(input.events, 'bind-expired');
  evidence.push(...toEvidence(input.events));

  if (
    readyAt &&
    lastIndex(input.events, 'ready') > lastIndex(input.events, 'give-up') &&
    lastIndex(input.events, 'ready') > lastIndex(input.events, 'reconnect')
  ) {
    return {
      ...base,
      phase: 'connected',
      message: `已连接 QQ（Bot ready${readyAt.event.appId ? `，appId=${readyAt.event.appId}` : ''}）`,
      nextStep: '在 QQ 里 @ 机器人或私聊试试。真实收发仍需按 QQ-GATE-01 另行验收。',
      appId: readyAt.event.appId ?? input.appId,
    };
  }
  if (giveUpAt) {
    return {
      ...base,
      phase: 'failed',
      message: 'QQ 连接失败，插件已停止重试',
      nextStep: '检查网络与凭据（AppID/AppSecret 是否属于同一个机器人），必要时重新授权后"一键重启 Harness"。',
    };
  }
  if (reconnectAt && lastIndex(input.events, 'reconnect') > lastIndex(input.events, 'ready')) {
    return {
      ...base,
      phase: 'reconnecting',
      message: '连接断开，SDK 正在自动重连（无需重新扫码）',
      nextStep: '等待十几秒；若长时间不恢复，检查网络后点"一键重启 Harness"。',
    };
  }
  if (input.credentialSource === 'none') {
    const hasLink =
      bindLinkAt && (!expiredAt || lastIndex(input.events, 'bind-link') > lastIndex(input.events, 'bind-expired'));
    if (hasLink) {
      return {
        ...base,
        phase: 'binding',
        message: '等待你在手机 QQ 上完成官方扫码授权',
        nextStep: '用手机 QQ 扫描二维码，或点"用浏览器打开官方授权页"后完成扫码。',
        bindUrl: bindLinkAt.event.url,
      };
    }
    // 用户点了扫码但插件还没给出官方链接：先"进行中"，超时后才判失败并说明原因。
    if (input.bindingStartedAt) {
      const begin = Date.parse(input.bindingStartedAt);
      const waited = Number.isFinite(begin) ? now.getTime() - begin : 0;
      const timeout = input.bindingTimeoutMs ?? DEFAULT_BINDING_TIMEOUT_MS;
      if (waited > timeout) {
        return {
          ...base,
          phase: 'failed',
          message: `点了"官方扫码绑定"后 ${Math.round(waited / 1000)} 秒内没有拿到二维码`,
          nextStep: `原因：${bindingFailureReason(input.events)}。点"重新生成二维码"重试；若一直失败，请确认网络能访问 q.qq.com，或改用 AppID/AppSecret。`,
        };
      }
      return {
        ...base,
        phase: 'binding',
        message: '正在向 QQ 官方申请二维码…（通常几秒内出现）',
        nextStep: '若超过 20 秒仍没有二维码，界面会给出失败原因和"重新生成"按钮。',
      };
    }
    return phase(
      'unbound',
      '插件已加载，但还没有 QQ 机器人凭据',
      '填写 AppID/AppSecret 并保存，或点"用官方扫码绑定"完成授权。',
    );
  }

  // 有凭据但还没 ready：连接中；超时才判失败（不靠配置文件猜成功）。
  const startedAt = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  const elapsed = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  const timeout = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  if (elapsed > timeout) {
    return {
      ...base,
      phase: 'failed',
      message: `已启用凭据，但 ${Math.round(elapsed / 1000)} 秒内没有收到网关就绪信号`,
      nextStep: '确认 AppID/AppSecret 属于同一个机器人且未被重置；改正后点"一键重启 Harness"。',
    };
  }
  return phase('connecting', '凭据已注入，正在连接 QQ 网关…', '通常几秒内完成；若一直停在这里，查看下方输出尾部。');
}
