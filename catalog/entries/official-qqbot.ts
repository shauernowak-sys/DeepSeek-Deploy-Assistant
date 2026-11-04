import type { CatalogEntry } from '@dda/spec';

import { OFFICIAL_QQBOT_CLOSURE } from '../data/official-qqbot-closure';

/**
 * V0.1 唯一一个真插件条目（PRD §10.5 冻结结果，不得为「显得丰富」而扩充）。
 *
 * 事实来源：
 * - 版本/闭包/许可：docs/M4-前置验证报告.md §4.5、§5.2（真实安装 + pnpm 解析）；
 * - publishTimestamp/integrity：registry 元数据（构建期 `collectRegistryProblems()` 复核）；
 * - 兼容组合：apps/desktop/resources/manifests/compat.json 的 `C1-prime`（verified-local）。
 */
export const OFFICIAL_QQBOT_ENTRY: CatalogEntry = {
  id: 'plg-official-qqbot',
  name: '@tencent-connect/dsh-qqbot',
  version: '0.5.5',
  publishTimestamp: 1793375955,
  source: { type: 'npm' },
  // 只宣称本机验证过的宿主版本，不用宽范围把未验证的 dsh 也说成「兼容」。
  enginesDsh: '=0.2.0-rc.2',
  compat: 'C1-prime',
  license: {
    spdx: 'MIT',
    // 本体 MIT，但闭包含 @tencent-connect/qqbot-connector@1.2.0（UNLICENSED）→ 整包不可分发。
    redistributable: false,
  },
  integrity: 'sha512-E15Du9xWfWk7CffRba8/ADHV9l6t9kDQ+U3ImLmB5Ffpnbwsm5ovYtHlhiENlILaqx0r+46cSxBiqhmu9Lz+IA==',
  depsClosure: [...OFFICIAL_QQBOT_CLOSURE],
  acceptance: [
    '在 Harness 网页端打开 QQ 插件设置页，能看到绑定二维码或「生成二维码」按钮',
    '手机 QQ 扫码并在手机端确认授权后，绑定页显示已绑定（而不是仅提示「正在绑定」）',
    '在已授权的群里 @ 机器人发送一条文本，收到机器人的文字回复',
    '私聊机器人发送一张图片，收到基于图片内容的回复',
  ],
  en: {
    name: 'Official QQ bot',
    summary: "Tencent's official QQ Open Platform bot plugin that links QQ groups and direct messages to Harness.",
  },
  zh: {
    name: '官方 QQ 机器人',
    summary: '腾讯官方 QQ 开放平台机器人插件，用扫码方式把 QQ 群/私聊接到 Harness。',
    description:
      '由腾讯 connect 团队维护的 Harness 插件。安装后 Harness 网页端会出现 QQ 设置区，' +
      '用手机 QQ 扫码即可完成绑定，之后可在群聊或私聊里与 Harness 对话。',
    usage:
      '安装 → 重启 Harness → 打开 QQ 设置页 → 手机扫码授权 → 在群里 @ 机器人或私聊它。' +
      '未扫码前不会收发任何消息。',
    risk:
      '插件加载后会主动向腾讯 QQ 开放平台发起绑定/鉴权请求（q.qq.com），属于必要的联网行为；' +
      '机器人会对授权范围内的群消息做出响应，请只授权给你信任的群。',
  },
  category: 'qq-bot',
  labels: ['official'],
  keywords: ['qq', 'bot', 'tencent', 'chat'],
  safety: {
    network: [
      '插件加载即向腾讯 QQ 开放平台发起绑定/鉴权请求',
      '绑定后与 QQ 开放平台保持长连接以收发消息',
    ],
    permissions: ['需要手机 QQ 扫码授权，或提供 AppID/AppSecret', '会读取被授权群/私聊的消息内容'],
    requiresRestart: true,
  },
  installNotes: [
    '安装需要联网（默认走国内镜像加速）；本软件只代为调用官方安装命令，不分发插件字节',
    '安装完成后需要重启 Harness，插件才会被加载',
    '该插件的运行时依赖含 UNLICENSED 组件，因此只支持在线安装，不提供离线包',
  ],
  status: 'verified',
  author: 'Tencent Connect',
  homepage: 'https://github.com/tencent-connect/dsh-qqbot#readme',
  repository: { url: 'https://github.com/tencent-connect/dsh-qqbot' },
};
