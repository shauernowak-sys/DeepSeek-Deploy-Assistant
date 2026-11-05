/**
 * D02/D03 插件资源中心 UI 走查（隔离数据目录 + CDP 真实渲染）。
 *
 *   node scripts/m4-market-ui-smoke.mjs
 *   node scripts/m4-market-ui-smoke.mjs --broken-market
 *
 * 说明：
 * - 截图来自 Electron 的真实渲染视口（CDP `Page.captureScreenshot`），**不是**操作系统窗口截图；
 *   1366×768 那组使用 `Emulation.setDeviceMetricsOverride`，报告里必须标注“模拟视口”。
 * - `--broken-market` 会临时移走 overlay，检查“清单读取失败”时不会用空列表冒充正常，
 *   结束后无论成功失败都会恢复原文件。
 * - 不引入 Playwright；交互全部通过 CDP `Runtime.evaluate` 与真实点击完成。
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = join(repoRoot, 'docs', 'evidence');
const marketDir = join(repoRoot, 'apps', 'desktop', 'resources', 'market');
const overlayPath = join(marketDir, 'catalog.overlay.json');
const overlayBackup = join(marketDir, 'catalog.overlay.json.smoke-bak');
const brokenMarket = process.argv.includes('--broken-market');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function seedDataRoot() {
  const localAppData = await mkdtemp(join(tmpdir(), brokenMarket ? 'dda-market-broken-' : 'dda-market-'));
  const root = join(localAppData, 'DeepSeekDeployAssistant');
  await mkdir(join(root, 'state', 'tasks'), { recursive: true });
  return { localAppData, root };
}

async function findPage(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* CDP 未就绪 */
    }
    await wait(500);
  }
  throw new Error(`port ${port} 没有可调试页面`);
}

async function connect(port) {
  const page = await findPage(port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const messageId = ++id;
      pending.set(messageId, (message) =>
        message.error ? rej(new Error(`${method}: ${JSON.stringify(message.error)}`)) : res(message.result),
      );
      ws.send(JSON.stringify({ id: messageId, method, params }));
      setTimeout(() => rej(new Error(`${method} timeout`)), 30000);
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
  await send('Page.bringToFront').catch(() => undefined);
  await wait(1200);
  return { ws, send, evaluate };
}

const clickText = (evaluate, selector, text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => (node.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);

const setSearch = (evaluate, value) =>
  evaluate(`(() => {
    const input = document.querySelector('input[type="search"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

const shot = async (send, name) => {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFilePhp(resolve(outDir, name), Buffer.from(result.data, 'base64'));
};

// `writeFile` 从 fs/promises 导入会在部分 Windows Node 版本上因编码参数歧义出问题；这里显式用 Buffer。
async function writeFilePhp(path, buffer) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, buffer);
}

async function waitFor(evaluate, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await wait(400);
  }
  throw new Error(`等待超时：${label}`);
}

async function run() {
  const { localAppData } = await seedDataRoot();
  const port = 9430;
  const electronPath = (await import('electron')).default;
  const child = execFile(
    electronPath,
    ['.', `--remote-debugging-port=${port}`, '--force-device-scale-factor=1'],
    { cwd: repoRoot, env: { ...process.env, LOCALAPPDATA: localAppData } },
  );

  let ws;
  try {
    const connection = await connect(port);
    ws = connection.ws;
    const { send, evaluate } = connection;

    // 模拟视口 1366×768（不是操作系统窗口截图）
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await wait(800);

    await waitFor(
      evaluate,
      `Boolean([...document.querySelectorAll('.navigation button')].find((b) => b.textContent.includes('插件资源')))`,
      '主导航出现',
    );
    assert(await clickText(evaluate, '.navigation button', '插件资源'), '无法点击「插件资源」');
    await waitFor(evaluate, `Boolean(document.querySelector('.market-page'))`, '插件资源页面');

    if (brokenMarket) {
      await waitFor(
        evaluate,
        `Boolean(document.querySelector('.market-panel[role="alert"]'))`,
        '清单失败提示',
      );
      const errorState = await evaluate(`(() => {
        const panel = document.querySelector('.market-panel[role="alert"]');
        return {
          text: panel?.textContent ?? '',
          hasReload: Boolean([...panel.querySelectorAll('button')].find((b) => b.textContent.includes('重新加载'))),
          hasDiagnostics: Boolean([...panel.querySelectorAll('button')].find((b) => b.textContent.includes('打开故障诊断'))),
          listShown: Boolean(document.querySelector('.market-group')),
        };
      })()`);
      assert(errorState.hasReload, '失败态缺少「重新加载」');
      assert(errorState.hasDiagnostics, '失败态缺少「打开故障诊断」');
      assert(!errorState.listShown, '失败态仍渲染了插件列表（空列表冒充正常）');
      await shot(send, 'm4-d03-market-error-1366.png');
      console.log(`broken_market=yes error="${errorState.text.slice(0, 80)}" screenshot=m4-d03-market-error-1366.png`);
      return;
    }

    await waitFor(evaluate, `document.querySelectorAll('.market-item').length > 0`, '插件卡片');
    const listState = await evaluate(`(() => ({
      groups: [...document.querySelectorAll('.market-group h3')].map((h) => h.textContent.trim()),
      categories: [...document.querySelectorAll('.market-categories button')].map((b) => b.textContent.trim()),
      recommend: document.querySelector('.market-recommend')?.textContent ?? '',
      cards: [...document.querySelectorAll('.market-item h4')].map((h) => h.textContent.trim()),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }))()`);
    assert(listState.categories.includes('QQ 接入'), '缺少「QQ 接入」分类');
    assert(listState.categories.includes('人设与陪伴'), '缺少「人设与陪伴」分类');
    assert(listState.categories.includes('记忆'), '缺少「记忆」分类');
    assert(listState.categories.includes('语音'), '缺少「语音」分类');
    assert(listState.categories.includes('图片与表情包'), '缺少「图片与表情包」分类');
    assert(listState.categories.includes('主动消息与 QQ 空间'), '缺少「主动消息与 QQ 空间」分类');
    assert(listState.recommend.includes('推荐搭配'), '缺少「推荐搭配」');
    assert(listState.recommend.includes('最终选择权在你'), '推荐搭配未说明最终选择权在用户');
    assert(!listState.overflow, '列表页出现横向溢出');
    await shot(send, 'm4-d03-market-list-1366.png');

    // 搜索
    assert(await setSearch(evaluate, '表情'), '无法输入搜索词');
    await wait(500);
    const searched = await evaluate(`(() => ({
      cards: [...document.querySelectorAll('.market-item h4')].map((h) => h.textContent.trim()),
      empty: [...document.querySelectorAll('.market-empty')].length,
    }))()`);
    assert(searched.cards.some((name) => name.includes('表情包')), `搜索“表情”没有找到表情包插件：${JSON.stringify(searched)}`);
    await shot(send, 'm4-d03-market-search-1366.png');

    // 清空搜索，按分类筛选
    assert(await setSearch(evaluate, ''), '无法清空搜索词');
    await wait(300);
    assert(await clickText(evaluate, '.market-categories button', '图片与表情包'), '无法点击分类');
    await wait(500);
    const categorized = await evaluate(`(() => ([...document.querySelectorAll('.market-group .market-item h4')].map((h) => h.textContent.trim())))()`);
    assert(categorized.length > 0, '分类筛选后没有结果');
    assert(categorized.every((name) => name.includes('表情包')), `分类筛选出现不属于该分类的条目：${categorized.join(' / ')}`);
    await shot(send, 'm4-d03-market-category-1366.png');

    // 个人 QQ 推荐搭配
    assert(await clickText(evaluate, '.market-route-toggle button', '个人 QQ'), '无法切换个人 QQ 路线');
    await wait(500);
    const personal = await evaluate(`(() => document.querySelector('.market-recommend')?.textContent ?? '')()`);
    assert(personal.includes('SnowLuma（外部组件）'), '个人 QQ 推荐缺少 SnowLuma 前置说明');
    assert(personal.includes('Aurabot（大肥鱼 QQ 陪伴）'), '个人 QQ 推荐缺少 Aurabot');
    assert(personal.includes('只选一个'), '个人 QQ 推荐未说明通道互斥');
    await shot(send, 'm4-d03-market-recommend-personal-1366.png');

    // Aurabot 详情（不可安装）
    assert(await clickText(evaluate, '.market-recommend-item button', '查看'), '无法从推荐打开 Aurabot');
    await waitFor(evaluate, `Boolean(document.querySelector('.market-detail-heading'))`, 'Aurabot 详情');
    const aurabotDetail = await evaluate(`(() => ({
      heading: document.querySelector('.market-detail-heading')?.textContent ?? '',
      banner: document.querySelector('.banner.warn')?.textContent ?? '',
      installButton: Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.includes('查看安装方案'))),
      guideButton: Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.includes('查看使用引导'))),
    }))()`);
    assert(aurabotDetail.heading.includes('Aurabot'), '详情页不是 Aurabot');
    assert(aurabotDetail.banner.includes('暂不可安装'), 'Aurabot 详情没有「暂不可安装」');
    assert(!aurabotDetail.installButton, 'Aurabot 候选不应渲染安装按钮');
    assert(aurabotDetail.guideButton, 'Aurabot 详情缺少使用引导入口');
    await shot(send, 'm4-d03-market-detail-candidate-1366.png');
    await evaluate(`document.querySelector('.market-detail-grid')?.scrollIntoView({ block: 'center' })`);
    await wait(400);
    await shot(send, 'm4-d03-market-detail-candidate-support-1366.png');

    // Aurabot 使用引导（设计示意）
    assert(await clickText(evaluate, 'button', '查看使用引导'), '无法打开 Aurabot 使用引导');
    await waitFor(evaluate, `Boolean(document.querySelector('.market-guide'))`, '使用引导');
    const guideState = await evaluate(`(() => ({
      text: document.querySelector('.market-guide')?.textContent ?? '',
      badge: document.querySelector('.market-guide .badge')?.textContent ?? '',
      mock: Boolean(document.querySelector('.market-mock')),
    }))()`);
    assert(guideState.badge.includes('设计示意'), 'Aurabot 引导没有标注“设计示意”');
    assert(guideState.badge.includes('非实机截图'), 'Aurabot 引导没有标注“非实机截图”');
    assert(guideState.text.includes('第 1 / 6 步'), 'Aurabot 引导不是 6 步');
    assert(guideState.mock, 'Aurabot 引导缺少设计示意图');
    await shot(send, 'm4-d03-market-guide-1366.png');

    // 返回列表，打开官方条目详情
    assert(await clickText(evaluate, 'button', '返回详情'), '无法从引导返回详情');
    await wait(300);
    assert(await clickText(evaluate, 'button', '返回列表'), '无法从详情返回列表');
    await wait(500);
    assert(await clickText(evaluate, '.market-categories button', '全部'), '无法重置分类筛选');
    await wait(400);
    // 从列表卡片直接打开引导，再返回详情：确保 selected 状态没有丢。
    assert(await clickText(evaluate, '.market-item button', '使用引导'), '无法从卡片打开使用引导');
    await waitFor(evaluate, `Boolean(document.querySelector('.market-guide'))`, '卡片引导');
    assert(await clickText(evaluate, 'button', '返回详情'), '无法从卡片引导返回详情');
    await waitFor(evaluate, `Boolean(document.querySelector('.market-detail-heading'))`, '卡片引导返回后的详情');
    const backFromCardGuide = await evaluate(`document.querySelector('.market-detail-heading')?.textContent ?? ''`);
    assert(backFromCardGuide.includes('官方 QQ 机器人'), `卡片引导返回详情丢失选中项：${backFromCardGuide}`);
    assert(await clickText(evaluate, 'button', '返回列表'), '无法从详情返回列表');
    await wait(400);
    assert(await clickText(evaluate, '.market-item button', '查看详情'), '无法打开已验证条目详情');
    await waitFor(evaluate, `Boolean(document.querySelector('.market-detail-heading'))`, '官方插件详情');
    const officialDetail = await evaluate(`(() => ({
      heading: document.querySelector('.market-detail-heading')?.textContent ?? '',
      installButton: Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.includes('查看安装方案'))),
      evidence: document.querySelector('.market-evidence')?.textContent ?? '',
    }))()`);
    assert(officialDetail.heading.includes('官方 QQ 机器人'), '详情页不是官方 QQ 机器人');
    assert(officialDetail.installButton, '已验证条目缺少安装入口');
    assert(officialDetail.evidence.includes('加载：未验证'), '证据区没有把加载标为未验证');
    assert(officialDetail.evidence.includes('连接：未验证'), '证据区没有把连接标为未验证');
    await shot(send, 'm4-d03-market-detail-official-1366.png');

    // 确认安装页：来源与进度说明
    assert(await clickText(evaluate, 'button', '查看安装方案'), '无法进入安装确认');
    await waitFor(evaluate, `Boolean(document.querySelector('.market-confirm-grid'))`, '安装确认');
    const confirmState = await evaluate(`(() => ({
      text: document.querySelector('.market-panel')?.textContent ?? '',
      progressIdle: Boolean(document.querySelector('.market-progress-idle')),
    }))()`);
    assert(confirmState.text.includes('国内镜像 npmmirror'), '确认页没有说明首个下载来源');
    assert(confirmState.text.includes('官方 npmjs'), '确认页没有说明回退来源');
    assert(confirmState.text.includes('registry.npmmirror.com'), '确认页没有给出首个来源地址');
    assert(confirmState.text.includes('registry.npmjs.org'), '确认页没有给出回退来源地址');
    assert(confirmState.text.includes('没有自建国内资源库'), '确认页错误暗示存在自建资源库');
    assert(confirmState.progressIdle, '确认页缺少进度占位说明');
    await shot(send, 'm4-d03-market-confirm-1366.png');

    // 原生视口截图（不模拟尺寸）
    await send('Emulation.clearDeviceMetricsOverride');
    await wait(500);
    await shot(send, 'm4-d03-market-native.png');

    console.log(
      `list_cards=${listState.cards.length} categories=${listState.categories.length} ` +
        `search="${searched.cards.join('/')}" category="${categorized.join('/')}" ` +
        `guide=6_steps_design confirm_sources=mirror+official screenshots=7`,
    );
  } finally {
    ws?.close();
    await new Promise((r) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => r()));
    await rm(localAppData, { recursive: true, force: true });
  }
}

await mkdir(outDir, { recursive: true });
if (brokenMarket) {
  await copyFile(overlayPath, overlayBackup);
  await rename(overlayPath, `${overlayPath}.hidden`);
}
try {
  await run();
  console.log('RESULT=PASS');
} finally {
  if (brokenMarket) {
    await rename(`${overlayPath}.hidden`, overlayPath).catch(() => undefined);
    await rm(overlayBackup, { force: true }).catch(() => undefined);
  }
}
