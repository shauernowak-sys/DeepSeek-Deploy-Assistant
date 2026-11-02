/**
 * Dev-only CDP helper: evaluates an expression in the running renderer and prints the value.
 * Usage: node scripts/cdp-eval.mjs <port> "<expression>"
 */
const port = process.argv[2] ?? '9336';
const expression = process.argv[3] ?? 'document.title';

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

const result = await new Promise((resolve, reject) => {
  const messageId = ++id;
  pending.set(messageId, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
  ws.send(
    JSON.stringify({
      id: messageId,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }),
  );
  setTimeout(() => reject(new Error('timeout')), 15000);
});

if (result.exceptionDetails) {
  console.error(JSON.stringify(result.exceptionDetails));
  process.exit(1);
}
console.log(typeof result.result?.value === 'string' ? result.result.value : JSON.stringify(result.result?.value));
ws.close();
process.exit(0);
