/**
 * §21.10「回到上一可用」弹窗的双分辨率视觉验收（1920×1080 / 1366×768）。
 *
 * 前提：应用已带 `--remote-debugging-port=<port>` 启动（建议用隔离的 LOCALAPPDATA + 预置一份
 * profile 备份，这样弹窗里能看到真实的备份列表，而不是空态）。
 *
 *   node scripts/m4-recovery-ui-smoke.mjs [port]
 *
 * 检查项（任何一条不满足即失败，避免"截图看着还行"就当通过）：
 *  1) 部署页上存在「回到上一可用…」按钮；
 *  2) 点击后弹出确认弹窗，且包含影响面（备份时间/重建命令/警告）；
 *  3) 两种分辨率下：文档无横向溢出、弹窗完整落在视口宽度内、按钮可点；
 *  4) 截图落盘到 docs/evidence/。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const port = process.argv[2] ?? '9362';
const outDir = resolve(process.cwd(), 'docs', 'evidence');
const VIEWPORTS = [
  { width: 1920, height: 1080, file: 'm4-recovery-modal-1920x1080.png' },
  { width: 1366, height: 768, file: 'm4-recovery-modal-1366x768.png' },
];

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
    setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
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

async function clickByText(selector, text) {
  return evaluate(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((el) => (el.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!node) return 'not-found';
    if (node.disabled) return 'disabled';
    node.click();
    return 'clicked';
  })()`);
}

// 1) 进入部署页：导航 → 环境检查 → 下一步
const nav = await clickByText('.navigation button', '部署向导');
if (nav !== 'clicked') throw new Error(`没有进入部署向导：${nav}`);
await wait(1200);
let nextStep = 'not-found';
for (let i = 0; i < 90; i += 1) {
  nextStep = await clickByText('section button', '下一步：部署环境');
  if (nextStep === 'clicked') break;
  // 隔离数据目录下首次环境检测较慢（要探测 Node/pnpm/Harness 与网络）；超时前再催一次。
  if (i === 20) await clickByText('section button', '重新检测');
  await wait(1000);
}
if (nextStep !== 'clicked') throw new Error(`没能进入部署页（下一步按钮：${nextStep}）`);
await wait(900);

// 2) 打开「回到上一可用」弹窗
const opened = await clickByText('section button', '回到上一可用');
if (opened !== 'clicked') throw new Error(`部署页没有「回到上一可用…」按钮：${opened}`);

let modalText = '';
for (let i = 0; i < 20; i += 1) {
  modalText = await evaluate(`document.querySelector('.modal')?.innerText ?? ''`);
  if (modalText.includes('回到上一可用状态')) break;
  await wait(400);
}
if (!modalText.includes('回到上一可用状态')) throw new Error(`弹窗没有出现：${modalText.slice(0, 200)}`);

const required = ['profile 声明文件', '恢复前会先自动备份当前状态', '确认恢复', '取消'];
for (const phrase of required) {
  if (!modalText.includes(phrase)) throw new Error(`弹窗缺少「${phrase}」：${modalText.slice(0, 400)}`);
}
// 有备份时应展示备份时间与重建命令；空态时必须明确说明"没有备份"
const hasBackupList = /最近/.test(modalText);
const hasEmptyState = /还没有可用的 profile 备份/.test(modalText);
if (!hasBackupList && !hasEmptyState) throw new Error('弹窗既没列出备份，也没说明没有备份');
if (hasBackupList) {
  const withRebuild = /pnpm install/u.test(modalText);
  const withoutPnpm = /没有可用的 pnpm/u.test(modalText);
  // 两种都合法，但必须二选一地说清楚（不能既不提重建、也不提缺 pnpm）
  if (!withRebuild && !withoutPnpm) throw new Error('有备份时既没展示重建命令，也没说明缺 pnpm');
  console.log(`rebuild_hint=${withRebuild ? 'pnpm-install' : 'no-pnpm'}`);
}
console.log(`modal_state=${hasBackupList ? 'with-backups' : 'empty'}`);

// 3) 两种分辨率：无横向溢出 + 弹窗落在视口内 + 截图
for (const viewport of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await wait(600);

  const layout = await evaluate(`(() => {
    const modal = document.querySelector('.modal');
    const rect = modal.getBoundingClientRect();
    const doc = document.documentElement;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: doc.scrollWidth,
      scrollHeight: doc.scrollHeight,
      modal: { left: rect.left, right: rect.right, top: rect.top, height: rect.height, width: rect.width },
      buttons: [...modal.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })),
    };
  })()`);

  if (layout.innerWidth !== viewport.width || layout.innerHeight !== viewport.height) {
    throw new Error(`视口未生效：${layout.innerWidth}×${layout.innerHeight} ≠ ${viewport.width}×${viewport.height}`);
  }
  if (layout.scrollWidth > layout.innerWidth + 1) {
    throw new Error(`${viewport.width}×${viewport.height} 出现横向溢出：scrollWidth=${layout.scrollWidth}`);
  }
  if (layout.modal.left < -1 || layout.modal.right > layout.innerWidth + 1) {
    throw new Error(`${viewport.width}×${viewport.height} 弹窗超出视口宽度：${JSON.stringify(layout.modal)}`);
  }
  const confirm = layout.buttons.find((b) => b.text.includes('确认恢复'));
  if (!confirm) throw new Error('弹窗里没有「确认恢复」按钮');
  if (hasBackupList && confirm.disabled) throw new Error('有备份时「确认恢复」不可点');

  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const shotPath = resolve(outDir, viewport.file);
  await mkdir(dirname(shotPath), { recursive: true });
  await writeFile(shotPath, Buffer.from(screenshot.data, 'base64'));
  console.log(
    `viewport=${viewport.width}x${viewport.height} overflow=none modal_w=${Math.round(layout.modal.width)} ` +
      `modal_h=${Math.round(layout.modal.height)} screenshot=${viewport.file}`,
  );
}

// 4) 收尾：取消，不得留下副作用
await send('Emulation.clearDeviceMetricsOverride');
const cancelled = await clickByText('.modal button', '取消');
if (cancelled !== 'clicked') throw new Error(`弹窗取消按钮不可用：${cancelled}`);
await wait(600);
const modalGone = await evaluate(`document.querySelector('.modal') === null`);
if (!modalGone) throw new Error('点击取消后弹窗仍在');
console.log('cancel_closes_modal=ok');

// 5) §21.10「重试这一步」：若预置了失败任务，失败步骤上必须出现该按钮，且两种分辨率下可见可点。
//    只检查存在性与可用性，**不点击**（点了会真的重跑部署）。
const retryButtons = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('section button')].filter((b) => b.textContent.trim() === '重试这一步');
  return { count: buttons.length, disabled: buttons.map((b) => b.disabled) };
})()`);
if (retryButtons.count === 0) {
  console.log('retry_step_button=skipped（本次没有预置失败任务）');
} else {
  if (retryButtons.disabled.some(Boolean)) throw new Error('「重试这一步」按钮存在但不可点');
  console.log(`retry_step_button=ok（${retryButtons.count} 个）`);
  for (const viewport of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await wait(500);
    const layout = await evaluate(`({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      retryVisible: [...document.querySelectorAll('section button')]
        .filter((b) => b.textContent.trim() === '重试这一步')
        .every((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }),
    })`);
    if (layout.scrollWidth > layout.innerWidth + 1) {
      throw new Error(`${viewport.width}×${viewport.height} 部署页出现横向溢出：${layout.scrollWidth}`);
    }
    if (!layout.retryVisible) throw new Error(`${viewport.width}×${viewport.height} 下「重试这一步」不可见`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const shotPath = resolve(outDir, viewport.file.replace('m4-recovery-modal', 'm4-retry-step'));
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`retry_step_viewport=${viewport.width}x${viewport.height} overflow=none`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
}

ws.close();
console.log('RESULT=PASS');
