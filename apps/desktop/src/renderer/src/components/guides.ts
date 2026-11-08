const officialSidebar = new URL('../assets/guides/official-qq-sidebar.png', import.meta.url).href;
const officialPanel = new URL('../assets/guides/official-qq-panel.png', import.meta.url).href;
const aurabotEntry = new URL('../assets/guides/aurabot-entry.png', import.meta.url).href;
const aurabotWizardQq = new URL('../assets/guides/aurabot-wizard-qq.png', import.meta.url).href;
const aurabotWizardGateway = new URL('../assets/guides/aurabot-wizard-gateway.png', import.meta.url).href;
const aurabotWizardConnect = new URL('../assets/guides/aurabot-wizard-connect.png', import.meta.url).href;
const aurabotPersona = new URL('../assets/guides/aurabot-persona.png', import.meta.url).href;

/**
 * 图文引导的唯一来源。
 *
 * 所有图片都是本软件隔离验证环境里的**真实运行截图**（Harness 0.2.1-rc.3 + web 配置环境，
 * 2026-11-05 拍摄）；没有截图的步骤（例如真实 QQ 收发）不配图，并在正文里写清楚原因。
 * 任何"示意图""猜测的按钮位置"都不得写进这里。
 */
export type GuideStep = {
  title: string;
  body: string;
  /** 一句话告诉用户点哪里。 */
  where?: string;
  /** 看到什么算完成。 */
  check: string;
  /** 真实运行截图（相对模块的 URL）。没有截图时省略。 */
  image?: string;
  imageAlt?: string;
};

export type Guide = {
  id: string;
  label: string;
  /** 截图来源与未验证范围，必须让用户看见。 */
  caveat: string;
  steps: GuideStep[];
};

export const GUIDES: Record<string, Guide> = {
  'guide-official-qqbot': {
    id: 'guide-official-qqbot',
    label: '官方 QQ 机器人使用引导',
    caveat:
      '以下截图来自本软件管理的同一套环境（Harness 0.2.1-rc.3 + web 配置环境）的隔离验证运行。你的界面可能随版本略有差异。最后一步的真实 QQ 收发必须由你用手机 QQ 完成，本软件无法代替验证。',
    steps: [
      {
        title: '打开左侧栏的「QQ 机器人」',
        body: '插件装好后，Harness 网页左侧栏会多出一个「QQ 机器人」。设置、二维码和回复规则都在这个插件自己的页面里。',
        where: 'Harness 网页 → 左侧栏「QQ 机器人」',
        check: '右侧出现「扫码绑定 QQ 机器人」和二维码，而不是空白页。',
        image: officialSidebar,
        imageAlt: '真实截图：Harness 左侧栏中的「QQ 机器人」入口',
      },
      {
        title: '用手机 QQ 扫码',
        body: '打开手机 QQ 扫二维码，在手机上确认授权。把机器人拉进你愿意让它回复的群。',
        where: '手机 QQ → 扫一扫',
        check: '页面上的二维码消失，改为显示机器人信息或「已绑定」。',
        image: officialPanel,
        imageAlt: '真实截图：QQ 插件页面中的绑定二维码与扫码提示',
      },
      {
        title: '在群里 @ 机器人发一条消息',
        body: '用手机 QQ 在群里 @ 机器人发一句普通文字；也可以私聊它。',
        where: '手机 QQ → 已授权的群或私聊',
        check: '群里或私聊里收到机器人的文字回复，才算真正接通。',
      },
    ],
  },
  'guide-aurabot-persona': {
    id: 'guide-aurabot-persona',
    label: 'Aurabot 人设管理引导',
    caveat:
      '以下截图来自本软件隔离验证环境（Aurabot 1.1.24 + Harness 0.2.1-rc.3），其中 QQ 网关用本地模拟服务代替真实 QQ，因此「真实收发」这一步仍未验证。人设由 Aurabot 插件自己管理，本软件只负责把你送到它的界面，不提供第二套人设编辑。',
    steps: [
      {
        title: '打开左侧栏的「Aurabot」',
        body: 'Aurabot 装好后，Harness 网页左侧栏「自动化任务」下面会出现「Aurabot」。第一次打开会看到 5 步设置向导。',
        where: 'Harness 网页 → 左侧栏「Aurabot」',
        check: '看到「大肥鱼」页面与「设置向导 第 1/5 步」。',
        image: aurabotEntry,
        imageAlt: '真实截图：Harness 左侧栏中的 Aurabot 入口',
      },
      {
        title: '第 1 步：填机器人号和你的 QQ 号',
        body: '机器人号建议用一个专门的小号；「你的 QQ 号」是主人号，管理类操作只认它。填完点「下一步」。',
        where: 'Aurabot → 设置向导 → 你们的 QQ 号',
        check: '点「下一步」后进度条前进到第 2 步。',
        image: aurabotWizardQq,
        imageAlt: '真实截图：Aurabot 设置向导第 1 步填写 QQ 号',
      },
      {
        title: '第 2 步：选择 QQ 网关',
        body: 'SnowLuma 在本软件里安装完成后，这里会直接显示「找到了 SnowLuma」。不用再下载。已经有自己的 OneBot v11 机器人时，改选「接我已有的 OneBot 机器人」并填 WebSocket 地址。',
        where: 'Aurabot → 设置向导 → 接 QQ 网关',
        check: '目录旁显示「找到了 SnowLuma」，「下一步」可以点。',
        image: aurabotWizardGateway,
        imageAlt: '真实截图：Aurabot 设置向导第 2 步选择 QQ 网关',
      },
      {
        title: '第 3、4 步：让机器人号上线并核对',
        body: '按向导提示启动网关、登录机器人号，然后点「连接」「测试连接」。插件会核对登录的是不是机器人号，不是就会断开。',
        where: 'Aurabot → 设置向导 → 连上机器人号',
        check: '出现「✓ 连上了：昵称（QQ 号）」，说明核对通过。',
        image: aurabotWizardConnect,
        imageAlt: '真实截图：Aurabot 设置向导显示「连上了」',
      },
      {
        title: '进入「人设 → 人格」新建、修改、保存',
        body: '向导走完后才会出现功能页：点顶部「人设」，再点「人格」。左列是已有的人设，点「＋ 新建人格」新建；右侧可以改名字、标签和每一节的内容；改完点页面下方的「保存人格」。',
        where: 'Aurabot → 人设 → 人格',
        check: '左列出现新的人设，页面提示「已保存」。想让某个人设生效，选中后点「设为当前」，下一轮回复起按新的人设说话。',
        image: aurabotPersona,
        imageAlt: '真实截图：Aurabot 人设页里的「人格」标签与编辑区',
      },
      {
        title: '用一条真实消息确认生效',
        body: '人设保存不等于已经能用。请用另一个 QQ 号私聊机器人发一句「你好」，看看回复风格是否按新的人设变化。',
        where: '手机 QQ → 与机器人的私聊',
        check: '收到真实回复，且语气符合你刚设置的人设。收不到消息时先回到「系统 → 日志」看连接状态。',
      },
    ],
  },
};

export function guideById(id: string | undefined): Guide | undefined {
  return id === undefined ? undefined : GUIDES[id];
}

export function guideList(): Guide[] {
  return Object.values(GUIDES);
}
