import type {
  PersonalQqAdapterState,
  PersonalQqBridgeState,
  PersonalQqEvidence,
  PersonalQqEvidenceSource,
  PersonalQqPhase,
  PersonalQqStatus,
  SnowLumaManifest,
} from '@dda/spec';

import type { AutomationDecision } from '../license';
import { sanitizeSecrets } from './onebot';
import type { OneBotProbe } from './onebot';
import type { QqntDetection } from './qqnt';
import type { SnowLumaDetection } from './snowluma';

/**
 * 把各探测器的结果合成**一个**相位 + 证据链。
 *
 * 相位顺序 = 用户旅程顺序：缺 QQ → 缺组件 → QQ 没跑 → 组件没跑 → 服务没响应
 * → 已登录 → 已联通 Harness → 消息已验证。任一未达成即停在该步，并给出该步可执行的动作。
 * 纯函数：所有 IO 都在 detect/* 里完成，这里只做判定，便于穷举测试。
 */

export interface ComposePersonalQqInput {
  manifest: SnowLumaManifest;
  automation: AutomationDecision;
  qq: QqntDetection;
  snowluma: SnowLumaDetection;
  webui: { reachable: boolean; line: string };
  onebot: OneBotProbe;
  onebotEvidence: string[];
  adapter: PersonalQqAdapterState;
  bridge?: PersonalQqBridgeState;
  /** 用户确认过"已经真实往返过一次"（只由人工验收升级）。 */
  messageVerified?: boolean;
  errors?: string[];
  /** 额外说明（例如 bridge 读取失败的具体原因），只进证据，不改变相位。 */
  notes?: string[];
  /** 额外的脱敏函数（调用方知道本次用到的令牌）；未提供时至少会抹掉 `access_token=` 形态。 */
  redact?: (line: string) => string;
  now?: Date;
}

function classifyLine(line: string): PersonalQqEvidenceSource {
  if (line.startsWith('清单')) return 'manifest';
  if (line.startsWith('进程检测')) return 'process';
  if (line.startsWith('端口检测')) return 'port';
  if (line.startsWith('OneBot') || line.startsWith('接口探测')) return 'http';
  return 'fs';
}

function toEvidence(lines: string[], at: string): PersonalQqEvidence[] {
  return lines.map((line) => ({ at, source: classifyLine(line), line }));
}

interface PhaseCopy {
  message: string;
  nextStep: string;
}

function copyFor(phase: PersonalQqPhase, input: ComposePersonalQqInput): PhaseCopy {
  const { manifest, automation, qq, snowluma, onebot } = input;
  const webuiUrl = `http://127.0.0.1:${manifest.ports.webui}`;
  switch (phase) {
    case 'qq-missing':
      return {
        message: '没有检测到桌面版 QQ（NTQQ）。SnowLuma 需要注入正在运行的 QQ 进程。',
        nextStep: '先从腾讯官网安装桌面版 QQ；装好后打开并登录，再回来点「重新检测」。',
      };
    case 'qq-not-running':
      return {
        message: `QQ 已安装（${qq.path ?? '已找到'}）但当前没有运行。`,
        nextStep: '打开 QQ 并完成登录（登录只能用手机扫码），然后回到这里点「重新检测」。',
      };
    case 'snowluma-not-installed':
      return {
        message: `没有检测到 ${manifest.displayName} ${manifest.version}。`,
        nextStep: automation.allowed
          ? `点「安装 ${manifest.displayName}」（版本与哈希已锁定）。`
          : `点「打开官方下载页」按引导手动安装（受许可证限制，本软件不代为下载/安装）。`,
      };
    case 'snowluma-installed':
      return {
        message: `已安装 ${manifest.displayName} ${snowluma.version ?? manifest.version}，但它还没有运行。`,
        nextStep: automation.allowed
          ? `点「启动 ${manifest.displayName}」；启动后等 5–10 秒再检测。`
          : `双击安装目录里的 ${manifest.layout.launcher} 启动；启动后等 5–10 秒再检测。`,
      };
    case 'snowluma-running':
      return {
        message: `${manifest.displayName} 进程在运行，但服务还没有响应（WebUI ${input.webui.reachable ? '可连' : '不可连'}）。`,
        nextStep: `打开 WebUI（${webuiUrl}）完成登录：先用启动日志里的一次性初始密码登录，用手机 QQ 扫码。${
          onebot.error ? ` OneBot 返回：${onebot.error}` : ''
        }`,
      };
    case 'snowluma-logged-in':
      return {
        message: `OneBot 已返回账号 ${onebot.uin ?? '（未知）'}，但还没有和 Harness 联通。`,
        nextStep: input.adapter.installed
          ? '点「打通 Harness」完成配置并重启 Harness，让插件开始工作。'
          : `先点「安装 / 修复适配插件」（锁定 dsh-qq-link ${input.adapter.expectedVersion}），再打通 Harness。`,
      };
    case 'harness-linked':
      return {
        message: 'OneBot 与 Harness 适配插件都正常。',
        nextStep: '用另一个 QQ 给这个号发一条私聊，确认能在 QQ 里收到 AI 回复（收到后请标记"已验证"）。',
      };
    case 'message-verified':
      return { message: '个人 QQ 消息链路已验证。', nextStep: '无需操作。' };
    case 'failed':
      return { message: '检测过程出错，状态不可信。', nextStep: '查看下方证据；必要时导出诊断报告。' };
  }
}

export function composePersonalQqStatus(input: ComposePersonalQqInput): PersonalQqStatus {
  const at = (input.now ?? new Date()).toISOString();
  const { manifest, qq, snowluma, onebot, bridge } = input;

  const phase = decidePhase(input);
  const copy = copyFor(phase, input);

  const evidence: PersonalQqEvidence[] = [
    ...toEvidence([`清单：${manifest.displayName} 要求版本 ${manifest.version}，端口 ${manifest.ports.onebotHttp}`], at),
    ...toEvidence(qq.evidence, at),
    ...toEvidence(snowluma.evidence, at),
    ...toEvidence([input.webui.line], at),
    ...toEvidence(input.onebotEvidence, at),
  ];
  if (onebot.error) evidence.push({ at, source: 'http', line: `OneBot：${onebot.error}` });
  evidence.push({
    at,
    source: 'fs',
    line: input.adapter.installed
      ? `适配插件：dsh-qq-link ${input.adapter.version ?? '（版本未知）'}（要求 ${input.adapter.expectedVersion}）`
      : '适配插件：未安装 dsh-qq-link',
  });
  if (bridge) {
    evidence.push({
      at,
      source: 'bridge',
      line: bridge.ok
        ? `适配插件：已联通${bridge.adapterVersion ? `（v${bridge.adapterVersion}）` : ''}${
            bridge.backendOk ? '，后端正常' : `，后端异常：${bridge.backendError ?? '未知'}`
          }`
        : '适配插件：尚未联通（未安装、未启动或配置不一致）',
    });
  }
  evidence.push({ at, source: 'license', line: input.automation.reason });
  for (const error of input.errors ?? []) evidence.push({ at, source: 'user', line: `错误：${error}` });
  for (const note of input.notes ?? []) evidence.push({ at, source: 'bridge', line: note });

  // 兜底脱敏：任何来源的文本（含异常消息）在离开本次检测前都要过一遍。
  // 调用方可用 `redact` 传入本次已知的令牌；未提供时至少抹掉 `access_token=` 形态。
  const scrub = (line: string): string => (input.redact ? input.redact(line) : sanitizeSecrets(line, []));
  const safeEvidence = evidence.map((item) => ({ ...item, line: scrub(item.line) }));

  return {
    phase,
    message: copy.message,
    nextStep: copy.nextStep,
    component: {
      id: manifest.id,
      displayName: manifest.displayName,
      expectedVersion: manifest.version,
      installedVersion: snowluma.version,
      installed: snowluma.installed,
      installDir: snowluma.installDir,
      versionProblem: snowluma.versionProblem,
    },
    client: { installed: qq.installed, path: qq.path, running: qq.running, pids: qq.pids },
    service: {
      webuiReachable: input.webui.reachable,
      onebotReachable: onebot.reachable,
      onebotResponsive: onebot.responsive,
      loginUin: onebot.uin,
      nickname: onebot.nickname,
      error: onebot.error,
    },
    adapter: input.adapter,
    bridge,
    automation: input.automation,
    evidence: safeEvidence.slice(-14),
    checkedAt: at,
  };
}

function decidePhase(input: ComposePersonalQqInput): PersonalQqPhase {
  if ((input.errors?.length ?? 0) > 0) return 'failed';
  if (!input.qq.installed) return 'qq-missing';
  if (!input.snowluma.installed) return 'snowluma-not-installed';
  if (!input.qq.running) return 'qq-not-running';
  if (!input.snowluma.running) return 'snowluma-installed';
  if (!input.onebot.responsive) return 'snowluma-running';
  if (!input.bridge?.ok) return 'snowluma-logged-in';
  if (input.messageVerified) return 'message-verified';
  return 'harness-linked';
}
