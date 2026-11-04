/**
 * V0.1 第二轮 UI 冒烟：环境检测 + 安装决策门禁（只读，不执行部署）。
 *
 * 前提：应用已带 `--remote-debugging-port=<port>` 启动。
 * 用法：node scripts/v01-env-gate-smoke.mjs [port]
 *
 * 验证：
 *  1) 环境卡展示五态之一，且不是「只有已就绪/未安装」两态；
 *  2) 点击「开始部署」只打开确认页/方案选择，不创建任务记录；
 *  3) 取消后不执行任何安装；
 *  4) 截图保存到 docs/evidence/。
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const port = process.argv[2] ?? '9340';
const outDir = resolve(process.cwd(), 'docs', 'evidence');
const journalPath = join(
  process.env.LOCALAPPDATA ?? '',
  'DeepSeekDeployAssistant',
  'state',
  'tasks',
  'full-deploy-0_2_0-rc_2.json',
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* CDP 未就绪 */
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
await wait(1500);

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};

async function journalStamp() {
  try {
    const s = await stat(journalPath);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

// 等待首屏真实检测完成（网络探测最慢，给它足够时间）。
let envText = '';
for (let i = 0; i < 30; i += 1) {
  envText = await evaluate(`(() => {
    const card = [...document.querySelectorAll('section.card')].find((s) => s.textContent.includes('环境检测'));
    return card?.innerText ?? '';
  })()`);
  if (/已安装|未安装|版本不符|需升级|检测失败/.test(envText) && /结论：/.test(envText)) break;
  await wait(1000);
}

const states = ['已安装', '未安装', '版本不符', '需升级', '检测失败'].filter((s) => envText.includes(s));
if (states.length === 0) throw new Error(`环境卡没有出现五态文案：${envText.slice(0, 300)}`);
if (/已就绪/.test(envText)) throw new Error('环境卡仍在用旧的「已就绪」两态文案');
if (!/这一步只读/.test(envText)) throw new Error('缺少「检测只读」说明');
console.log(`env_states=${states.join(',')}`);
console.log(`env_conclusion=${/结论：[^\n]+/.exec(envText)?.[0] ?? '(none)'}`);

const before = await journalStamp();
const clicked = await evaluate(`(() => {
  const section = [...document.querySelectorAll('section.card')].find((s) => s.textContent.includes('3. 部署'));
  const btn = section?.querySelector('.row button.primary');
  if (!btn) return 'button-not-found';
  btn.click();
  return 'clicked';
})()`);
if (clicked !== 'clicked') throw new Error(`没有找到开始部署按钮: ${clicked}`);
await wait(2500);

let modalText = await evaluate(`document.querySelector('.modal')?.innerText ?? ''`);
const afterOpen = await journalStamp();
if (!/确认本次部署|请选择使用哪一套运行环境/.test(modalText)) {
  throw new Error(`没有出现确认页：${modalText.slice(0, 400)}`);
}
if (afterOpen !== before) {
  throw new Error(`仅打开确认页就创建/修改了任务记录（门禁被绕过）：${before} -> ${afterOpen}`);
}

if (/请选择使用哪一套运行环境/.test(modalText)) {
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('使用此方案'));
    btn?.click();
  })()`);
  await wait(1500);
  modalText = await evaluate(`document.querySelector('.modal')?.innerText ?? ''`);
  if (!/确认本次部署/.test(modalText)) throw new Error('选择方案后没有进入确认页');
}

for (const required of ['本次会安装', '本次会复用', '本次会修改', '本次不会修改', '管理员权限', '失败后如何恢复']) {
  if (!modalText.includes(required)) throw new Error(`确认页缺少「${required}」`);
}
console.log('gate_confirm_page=ok');

const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const shotPath = resolve(outDir, 'v01-env-gate-confirm.png');
await mkdir(dirname(shotPath), { recursive: true });
await writeFile(shotPath, Buffer.from(screenshot.data, 'base64'));
console.log(`screenshot=${shotPath}`);

const cancelled = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('取消'));
  if (!btn) return 'no-cancel';
  btn.click();
  return 'cancelled';
})()`);
if (cancelled !== 'cancelled') throw new Error('确认页没有可用的取消按钮');
await wait(1200);
const afterCancel = await journalStamp();
if (afterCancel !== before) throw new Error(`取消后仍创建/修改了任务记录：${before} -> ${afterCancel}`);
const notice = await evaluate(`document.querySelector('.banner.ok')?.innerText ?? ''`);
if (!notice.includes('已取消')) throw new Error(`取消后没有明确提示：${notice}`);
console.log('cancel_without_deploy=ok');

ws.close();
console.log('RESULT=PASS');
