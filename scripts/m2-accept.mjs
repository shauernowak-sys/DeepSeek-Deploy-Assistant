/**
 * Dev-only M2 acceptance driver: drives the packaged app over CDP so the checks go through
 * renderer -> IPC -> services -> disk (no direct service calls).
 *
 * Usage: node scripts/m2-accept.mjs <port> <scenario>
 *   snapshot       dump visible text + key badges
 *   start          click 开始部署 and return immediately
 *   wait           wait for a terminal journal state, print steps
 *   cancel         click 取消…, confirm with cleanup checked, wait terminal
 *   pause-resume   pause mid-run, assert status=paused, then resume and wait for success
 *   diag           export diagnostics zip, print target path + entry count
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const port = process.argv[2] ?? '9335';
const scenario = process.argv[3] ?? 'snapshot';
const tasksDir = join(process.env.LOCALAPPDATA ?? '', 'DeepSeekDeployAssistant', 'state', 'tasks');
const cancelDelayMs = Number(process.argv[4] ?? 6000);
const TERMINAL = ['succeeded', 'failed', 'rolled-back', 'cancelled'];

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let msgId = 0;
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`${method} timeout`)), 20000);
  });
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The deploy button is re-labelled after a successful run, and stays disabled while a call is in flight. */
async function clickDeploy() {
  let last = 'no-attempt';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    last = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /开始部署|重新部署/.test(b.textContent));
      if (!btn) return 'not-found';
      if (btn.disabled) return 'disabled';
      btn.click();
      return 'clicked:' + btn.textContent.trim();
    })()`);
    if (last.startsWith('clicked')) return last;
    await sleep(500);
  }
  return `failed:deploy-button(${last})`;
}

const clickText = (text) =>
  evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}));
    if (!btn) return 'not-found:${text}';
    if (btn.disabled) return 'disabled:${text}';
    btn.click();
    return 'clicked:${text}';
  })()`);

async function newestJournal() {
  try {
    const files = (await readdir(tasksDir)).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return undefined;
    let best;
    let bestTime = 0;
    for (const f of files) {
      const s = await stat(join(tasksDir, f));
      if (s.mtimeMs > bestTime) {
        bestTime = s.mtimeMs;
        best = f;
      }
    }
    return JSON.parse(await readFile(join(tasksDir, best), 'utf8'));
  } catch {
    return undefined;
  }
}

function stepLine(journal) {
  return `${journal.status} :: ${journal.steps.map((s) => `${s.id}=${s.status}`).join(' ')}`;
}

async function waitTerminal(limitMs = 12 * 60_000) {
  const started = Date.now();
  let last = '';
  for (;;) {
    await sleep(1500);
    const journal = await newestJournal();
    if (journal) {
      const line = stepLine(journal);
      if (line !== last) {
        console.log(line);
        last = line;
      }
      if (TERMINAL.includes(journal.status)) return journal;
    }
    if (Date.now() - started > limitMs) throw new Error('timeout waiting for terminal state');
  }
}

async function waitStatus(statuses, limitMs = 5 * 60_000) {
  const started = Date.now();
  for (;;) {
    const journal = await newestJournal();
    if (journal && statuses.includes(journal.status)) return journal;
    if (Date.now() - started > limitMs) throw new Error(`timeout waiting for ${statuses.join('|')}`);
    await sleep(700);
  }
}

async function waitModal(title, limitMs = 60_000) {
  const started = Date.now();
  for (;;) {
    const heading = await evaluate("document.querySelector('.modal h2')?.textContent ?? ''");
    if (heading.includes(title)) return true;
    if (Date.now() - started > limitMs) throw new Error(`modal "${title}" did not open (last="${heading}")`);
    await sleep(300);
  }
}

const uiText = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);

let exitCode = 0;
switch (scenario) {
  case 'snapshot': {
    const badges = await evaluate(
      "[...document.querySelectorAll('.badge')].map((b) => b.textContent.trim()).join(' | ')",
    );
    console.log(`badges: ${badges}`);
    const progressCard = await uiText('section.card:nth-of-type(3)');
    console.log('--- deploy card ---');
    console.log(progressCard.slice(0, 1200));
    break;
  }

  case 'start': {
    console.log(await clickDeploy());
    await sleep(1500);
    const journal = await newestJournal();
    console.log(`journal=${journal?.taskId ?? 'none'} status=${journal?.status ?? 'none'}`);
    break;
  }

  case 'wait': {
    const journal = await waitTerminal();
    console.log(`final=${journal.status} elapsedSteps=${journal.steps.length}`);
    if (journal.error) console.log(`error=${journal.error}`);
    console.log(`ui_progress_card:\n${(await uiText('.progress + p')).trim()}`);
    exitCode = journal.status === 'succeeded' ? 0 : 1;
    break;
  }

  case 'cancel': {
    console.log(await clickDeploy());
    // Let at least one step finish so cleanup has real paths to remove.
    const running = await waitStatus(['running'], 120_000);
    console.log(`reached running: ${stepLine(running).slice(0, 200)}`);
    console.log(`waiting ${cancelDelayMs}ms before cancelling`);
    await sleep(cancelDelayMs);
    const before = await newestJournal();
    console.log(`before_cancel: ${before ? stepLine(before).slice(0, 300) : 'no journal'}`);
    console.log(`created_before_cancel=${before?.created?.length ?? 0}`);
    console.log(await clickText('取消…'));
    await waitModal('取消部署');
    const preview = await uiText('.modal .evidence');
    const note = await uiText('.modal p.muted');
    console.log(`cleanup_note: ${note.replace(/\s+/g, ' ')}`);
    console.log(`preview_paths:\n${preview}`);
    console.log(await clickText('确认取消'));
    // The engine writes `cancelled` first; cleanup then rewrites the journal to `rolled-back`.
    const started = Date.now();
    let journal = await waitStatus(['cancelled', 'rolled-back'], 180_000);
    while (journal.status === 'cancelled' && Date.now() - started < 120_000) {
      await sleep(500);
      const next = await newestJournal();
      if (next) journal = next;
    }
    console.log(`final=${journal.status}`);
    if (journal.error) console.log(`error=${journal.error}`);
    console.log(`created_recorded=${journal.created?.length ?? 0}`);
    console.log(`ui_status_badge: ${await uiText('.badge.warn')}`);
    exitCode = journal.status === 'rolled-back' ? 0 : 1;
    break;
  }

  case 'pause-resume': {
    console.log(await clickDeploy());
    await waitStatus(['running'], 120_000);
    await sleep(4000);
    console.log(await clickText('暂停'));
    const paused = await waitStatus(['paused'], 300_000);
    console.log(`paused at: ${stepLine(paused).slice(0, 240)}`);
    const pausedUi = await evaluate("document.body.innerText.includes('已暂停') ? 'ui_shows_paused' : 'ui_missing_paused'");
    console.log(pausedUi);
    await sleep(1000);
    console.log(await clickText('继续'));
    const journal = await waitTerminal();
    console.log(`final=${journal.status}`);
    if (journal.error) console.log(`error=${journal.error}`);
    exitCode = journal.status === 'succeeded' ? 0 : 1;
    break;
  }

  case 'diag': {
    console.log(await clickText('导出诊断报告'));
    await waitModal('导出诊断报告');
    const entries = await uiText('.modal .evidence');
    const target = await evaluate("document.querySelector('.modal code')?.textContent ?? ''");
    console.log(`target=${target}`);
    console.log(`entry_lines=${entries.split('\n').filter(Boolean).length}`);
    console.log(entries.slice(0, 600));
    console.log(await clickText('确认导出'));
    const started = Date.now();
    let result = '';
    while (Date.now() - started < 120_000) {
      result = await evaluate(
        "[...document.querySelectorAll('section.card p.muted')].map((p) => p.textContent).find((t) => t && t.includes('.zip')) ?? ''",
      );
      if (result) break;
      await sleep(800);
    }
    console.log(`result=${result}`);
    exitCode = result.includes('.zip') ? 0 : 1;
    break;
  }

  default:
    console.error(`unknown scenario: ${scenario}`);
    exitCode = 4;
}

ws.close();
process.exit(exitCode);
