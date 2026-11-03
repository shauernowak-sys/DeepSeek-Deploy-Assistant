/**
 * M3.3.1 个人 QQ「官方下载 + 引导安装」向导的 UI 冒烟脚本（开发用）。
 *
 * 前提：应用已带 `--remote-debugging-port=<port>` 启动。
 * 用法：node scripts/m331-ui-smoke.mjs [port]
 *
 * 只做只读/无副作用操作：切页、读取文案、点一次「我已完成安装（重新检测）」，
 * 并把第一步与第二步截图存到 docs/evidence/。
 *
 * 断言的都是"真实渲染结果"：没有找到安装目录就必须显示"没有找到"，不能显示成功。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const port = process.argv[2] ?? '9338';
const outDir = resolve(process.cwd(), 'docs', 'evidence');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // CDP 还没就绪。
    }
    await wait(500);
  }
  throw new Error('没有找到可调试页面');
}

const page = await findPage();
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
const send = (method, params = {}) =>
  new Promise((resolvePromise, reject) => {
    const messageId = ++id;
    pending.set(messageId, (message) =>
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolvePromise(message.result),
    );
    ws.send(JSON.stringify({ id: messageId, method, params }));
    setTimeout(() => reject(new Error(`${method} timeout`)), 20000);
  });

await new Promise((resolvePromise) => ws.addEventListener('open', resolvePromise, { once: true }));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await wait(3000);

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};

const screenshot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const path = resolve(outDir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  return path;
};

await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('个人 QQ'));
  if (!button) throw new Error('没有找到"个人 QQ"标签按钮');
  button.click();
  return true;
})()`);
await wait(3500);

const step1Text = await evaluate('document.body.innerText');
const step1Checks = {
  wizard: ['1. 环境检查', '2. 下载与安装 SnowLuma', '3. QQ 登录', '4. 连接 Harness', '5. 消息测试'].every((label) =>
    step1Text.includes(label),
  ),
  envCard: step1Text.includes('第一步：环境检查'),
  qqRow: step1Text.includes('QQ 客户端'),
  snowlumaRow: step1Text.includes('SnowLuma'),
  officialButton: step1Text.includes('前往 SnowLuma 官方下载'),
  noFakeSuccess: !step1Text.includes('双向消息链路已验证'),
};
const step1Shot = await screenshot('m331-ui-step1-env.png');

// 切到第二步
await evaluate(`(() => {
  const chip = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('2. 下载与安装 SnowLuma'),
  );
  if (!chip) throw new Error('没有找到第二步标签');
  chip.click();
  return true;
})()`);
await wait(1500);

const step2Text = await evaluate('document.body.innerText');
const step2Checks = {
  title: step2Text.includes('第二步：下载与安装 SnowLuma'),
  version: step2Text.includes('v2.4.0'),
  fileName: step2Text.includes('SnowLuma-v2.4.0-win-x64.zip'),
  sha256: step2Text.includes('93096cb6d4cf576999094e9f7d1c9fb08e22f6b41c879182f015e639dc437613'),
  verifyHint: step2Text.includes('certutil'),
  tutorial: step2Text.includes('图文安装步骤') && step2Text.includes('launcher.bat'),
  faq: step2Text.includes('常见问题'),
  doneButton: step2Text.includes('我已完成安装（重新检测）'),
  autoFolded: step2Text.includes('自动下载与安装（需著作权人书面授权'),
};
const step2Shot = await screenshot('m331-ui-step2-guide.png');

// 点「我已完成安装（重新检测）」，等它跑完（按钮恢复可用）
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('我已完成安装'),
  );
  if (!button) throw new Error('没有找到"我已完成安装"按钮');
  button.click();
  return true;
})()`);

const recheck = await evaluate(`(async () => {
  const started = Date.now();
  for (;;) {
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('我已完成安装'),
    );
    const text = document.body.innerText;
    const finished = button && !button.disabled && !text.includes('正在检测…');
    if (finished) return { text, waited: Date.now() - started };
    if (Date.now() - started > 90000) return { text, waited: Date.now() - started, timeout: true };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
  }
})()`);

const afterText = recheck.text;
const honesty = {
  found: /已找到并校验通过|已找到 .*但校验未通过/.test(afterText),
  notFound: afterText.includes('没有在常见位置找到 SnowLuma'),
  // 只要没装就必须明确说没找到；装了就必须给出校验结论。两者必居其一。
  truthful: /已找到并校验通过|已找到 .*但校验未通过|没有在常见位置找到 SnowLuma/.test(afterText),
  noFakeSuccess: !afterText.includes('校验通过，可以继续') || afterText.includes('综合结论'),
};
const step2bShot = await screenshot('m331-ui-step2-recheck.png');

const result = {
  step1Checks,
  step2Checks,
  recheck: { waitedMs: recheck.waited, timeout: Boolean(recheck.timeout), honesty },
  screenshots: [step1Shot, step2Shot, step2bShot],
};
console.log(JSON.stringify(result, null, 2));

const failed = [
  ...Object.entries(step1Checks).filter(([, ok]) => !ok).map(([key]) => `step1.${key}`),
  ...Object.entries(step2Checks).filter(([, ok]) => !ok).map(([key]) => `step2.${key}`),
];
if (!honesty.truthful) failed.push('recheck.truthful');
if (recheck.timeout) failed.push('recheck.timeout');

if (failed.length > 0) {
  console.error('UI 冒烟失败：', failed.join(', '));
  process.exit(1);
}
ws.close();
process.exit(0);
