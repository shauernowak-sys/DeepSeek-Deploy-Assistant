import { z } from 'zod';

/**
 * 验收门禁的唯一事实源。
 *
 * 之所以从 IPC 层搬到这里：`apps/desktop/src/main/ipc/register.ts` 里那份常量曾长期写着
 * "扫码未验证、收发未验证"，与 docs/M3.2-QQ-GATE-01证据.md 的 2/6 实际进度不一致（审计发现 A-06）。
 * 门禁状态必须有单一来源，改动只允许跟随证据文件。
 */
export type QqGateStatus = 'not-passed' | 'partial' | 'passed';

export interface QqGate {
  id: string;
  title: string;
  status: QqGateStatus;
  /** 已有真实环境证据的项。 */
  verified: string[];
  /** 尚无证据、或证据不足的项。 */
  notVerified: string[];
  note: string;
}

/**
 * 官方 QQ Bot 门禁。状态由 docs/M3.2-QQ-GATE-01证据.md 决定，不得由代码随手改写。
 * 当前 2/6：方式 A 授权 + 私聊对话已由用户实机验证通过。
 */
export const QQ_GATE_01: QqGate = {
  id: 'QQ-GATE-01',
  title: '官方 QQ 真实链路验收',
  status: 'partial',
  verified: ['真实授权（方式 A：AppID/AppSecret）', '私聊消息回复'],
  notVerified: ['群内 @ 机器人回复', '图片消息', '断网后自动恢复', '重启后免扫码', '官方扫码（方式 B）'],
  note: '2/6。未通过前不得对外宣称"群聊/图片/断线恢复已支持"；Mock 与单测不替代真实验收。',
};

export type PersonalQqGateItemStatus = 'pending' | 'passed' | 'not-supported' | 'license-blocked';

export interface PersonalQqGateItem {
  id: number;
  title: string;
  status: PersonalQqGateItemStatus;
  /** 通过时的证据文件（相对 docs/），未通过为 undefined。 */
  evidence?: string;
  note?: string;
}

export type PersonalQqGate = QqGate & {
  items: PersonalQqGateItem[];
  /** 判定"个人 QQ 可对话"必须同时通过的项。 */
  blockingItemIds: number[];
};

/**
 * 个人 QQ（SnowLuma 路线）门禁。规则：只有 #5/#6/#7 同时通过，才允许对外宣称"个人 QQ 可对话"。
 * 未验证前一律 `pending`；上游不支持的能力写 `not-supported`，受许可证限制的写 `license-blocked`。
 */
export const QQ_GATE_02: PersonalQqGate = {
  id: 'QQ-GATE-02',
  title: '个人 QQ（SnowLuma）真实链路验收',
  status: 'not-passed',
  blockingItemIds: [5, 6, 7],
  verified: [],
  notVerified: [
    '组件就位（版本与哈希）',
    'hook 注入成功',
    'OneBot 可用（get_login_info）',
    '适配层联通（bridge state）',
    '私聊消息到达 Harness',
    'Harness 调用 DeepSeek API',
    'AI 回复返回 QQ',
    '群聊 @ 回复',
    '图片消息',
    '断线恢复',
    '重启恢复',
    '与官方路线的隔离与卸载',
  ],
  note: '12 项仍全部为 pending。M3.3 已把自动化部署流水线完整实现并有单测与官方真包实测覆盖，但 SnowLuma EULA §5.4 要求"通过自动化脚本部署"须事先取得书面授权：未登记授权文号时 release/download/install/configure/start 在 UI 中显示为 blocked，不会下载/写入/启动；真实双向收发必须由用户本人用真实 QQ 扫码并确认（代码不得代判）。见 docs/M3.3-实施报告.md。',
  items: [
    { id: 1, title: '组件就位（版本与哈希一致）', status: 'pending' },
    { id: 2, title: 'hook 注入成功（QQ 已登录且被 SnowLuma 识别）', status: 'pending' },
    { id: 3, title: 'OneBot 可用（get_login_info 返回真实 QQ 号）', status: 'pending' },
    { id: 4, title: '适配层联通（dsh-qq-bridge/state ok）', status: 'pending', note: '2026-11-03 实测：dsh-qq-link@1.5.1 已安装并加载、状态接口可读（真实证据）；因 SnowLuma 未安装导致 OneBot 后端不可用，故不通过。', evidence: 'evidence/QQ-GATE-02/s5-adapter-real-2026-11-03.md' },
    { id: 5, title: '私聊消息到达 Harness', status: 'pending' },
    { id: 6, title: 'Harness 调用 DeepSeek API', status: 'pending' },
    { id: 7, title: 'AI 回复返回 QQ', status: 'pending' },
    { id: 8, title: '群聊 @ 回复', status: 'pending' },
    { id: 9, title: '图片消息', status: 'pending' },
    { id: 10, title: '断线恢复', status: 'pending' },
    { id: 11, title: '重启恢复', status: 'pending' },
    { id: 12, title: '双路线隔离与卸载', status: 'pending' },
  ],
};

/** 门禁状态是否允许对外宣称"个人 QQ 可对话"。 */
export function personalQqClaimable(gate: PersonalQqGate = QQ_GATE_02): boolean {
  return gate.blockingItemIds.every((id) => gate.items.find((item) => item.id === id)?.status === 'passed');
}

/** 渲染层/主进程共用的最小结构校验（只校验会被 UI 直接读取的字段）。 */
export const QqGateSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(['not-passed', 'partial', 'passed']),
    verified: z.array(z.string()),
    notVerified: z.array(z.string()),
    note: z.string(),
  })
  .strict();
