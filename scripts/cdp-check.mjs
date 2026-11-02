/**
 * Dev-only smoke check: connects to a running Electron renderer over CDP and prints the
 * text content of #root. Used to prove the packaged UI actually mounted (not a blank window).
 * Usage: node scripts/cdp-check.mjs [port]
 */
const port = process.argv[2] ?? '9333';

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: messageId, method, params }));
    setTimeout(() => reject(new Error(`${method} timeout`)), 8000);
  });

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  return result.result?.value;
};

const text = await evaluate("document.getElementById('root')?.innerText ?? ''");
const headerCount = await evaluate("document.querySelectorAll('.card').length");
console.log(`title=${await evaluate('document.title')}`);
console.log(`cards=${headerCount}`);
console.log(`rootText=${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
ws.close();
process.exit(text && headerCount > 0 ? 0 : 1);
