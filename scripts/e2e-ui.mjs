/**
 * Dev-only acceptance driver: clicks "开始部署" in the running packaged app and waits for the
 * journal to reach a terminal state. Proves the real UI -> IPC -> plan -> disk path works.
 * Usage: node scripts/e2e-ui.mjs [port]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const port = process.argv[2] ?? '9335';
const localAppData = process.env.LOCALAPPDATA;
const journalPath = join(
  localAppData,
  'DeepSeekDeployAssistant',
  'state',
  'tasks',
  'full-deploy-0_2_0-rc_2.json',
);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id: messageId, method, params }));
    setTimeout(() => reject(new Error(`${method} timeout`)), 8000);
  });
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};

const clicked = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('开始部署'));
  if (!btn) return 'button-not-found';
  btn.click();
  return 'clicked';
})()`);
console.log(`click=${clicked}`);

const started = Date.now();
let last = '';
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch {
    journal = undefined;
  }
  const domText = await evaluate("document.querySelector('.progress')?.parentElement?.innerText ?? ''");
  if (journal) {
    const line = `${journal.status} :: ${journal.steps.map((s) => `${s.id}=${s.status}`).join(' ')}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (['succeeded', 'paused', 'failed', 'rolled-back'].includes(journal.status)) {
      const uiSaysDone = /已完成|失败|已跳过/.test(domText);
      console.log(`ui_shows_status=${uiSaysDone}`);
      console.log(`elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
      ws.close();
      process.exit(journal.status === 'succeeded' ? 0 : 1);
    }
  }
  if (Date.now() - started > 12 * 60_000) {
    console.error('timeout waiting for terminal state');
    ws.close();
    process.exit(3);
  }
}
