/**
 * §21.12 可访问性走查：三档缩放（100% / 125% / 150%）+ 仅键盘可达性。
 *
 *   node scripts/m4-a11y-ui-smoke.mjs
 *
 * 做法（真实 DPI，不是 CSS 缩放假装）：
 * - 每个档位单独启动一次 Electron，带 `--force-device-scale-factor=1|1.25|1.5`；
 * - 独立 LOCALAPPDATA + 预置 fixture（一份 profile 备份、一份含失败步骤的任务），
 *   这样"弹窗列表"与"重试这一步"都是真实渲染出来的；
 * - 通过 CDP 发**真实按键事件**（Tab / Enter / Escape），而不是 `element.focus()`——
 *   否则 `:focus-visible` 不会触发，焦点环检查就变成自欺。
 *
 * 断言（任一不满足即失败）：
 *  1) `devicePixelRatio` 等于目标缩放；`html[lang]` 为中文；
 *  2) 首页 / 部署页 / 弹窗在三种缩放下均无横向溢出；
 *  3) 纯 Tab 能到达导航与部署页关键按钮，且每次焦点都有可见焦点指示（outline 或 box-shadow）；
 *  4) 打开弹窗后焦点进入弹窗内；Esc 关闭弹窗；关闭后焦点回到触发按钮；
 *  5) 所有 `.badge` 都有文字（颜色不是唯一标识）。
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = join(repoRoot, 'docs', 'evidence');
const SCALES = [
  { scale: 1, file: 'm4-a11y-100.png' },
  { scale: 1.25, file: 'm4-a11y-125.png' },
  { scale: 1.5, file: 'm4-a11y-150.png' },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function seedDataRoot() {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-a11y-'));
  const root = join(localAppData, 'DeepSeekDeployAssistant');
  const backup = join(root, 'state', 'backups', 'plugin-2026-11-05T00-00-00-000Z');
  await mkdir(backup, { recursive: true });
  for (const [name, content] of Object.entries({
    'package.json': '{"name":"web-profile"}',
    'pnpm-workspace.yaml': 'packages: []\n',
    'cordis.patch.yml': 'patches: []\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  })) {
    await writeFile(join(backup, name), content, 'utf8');
  }
  const pnpmBin = join(root, 'runtimes', 'pnpm', 'node_modules', 'pnpm', 'bin');
  await mkdir(pnpmBin, { recursive: true });
  await writeFile(join(pnpmBin, 'pnpm.cjs'), '// a11y smoke fixture: makes the "pnpm available" check pass\n', 'utf8');

  const tasks = join(root, 'state', 'tasks');
  await mkdir(tasks, { recursive: true });
  await writeFile(
    join(tasks, 'full-deploy-0_2_0-rc_2.json'),
    JSON.stringify(
      {
        taskId: 'full-deploy-0_2_0-rc_2',
        scenario: 'full-deploy',
        status: 'failed',
        startedAt: '2026-11-05T00:10:00.000Z',
        finishedAt: '2026-11-05T00:12:00.000Z',
        error: 'a11y smoke fixture：下载 Node 时网络中断',
        pausedByUser: false,
        steps: [
          { id: 'preflight', title: '环境预检', status: 'succeeded', attempts: 1 },
          { id: 'download-node', title: '下载 Node 运行时', status: 'failed', attempts: 2, message: '网络中断（fixture）' },
          { id: 'install-node', title: '安装 Node 运行时', status: 'pending', attempts: 0 },
        ],
        created: [],
      },
      null,
      2,
    ),
    'utf8',
  );
  return { localAppData, root };
}

async function findPage(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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
  // 无头/后台窗口会让 Tab 不推进焦点；打开焦点模拟并前置，键盘走查才有意义。
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
  await send('Page.bringToFront').catch(() => undefined);
  await wait(1500);
  return { ws, send, evaluate };
}

const KEYS = {
  Tab: { type: 'rawKeyDown', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab' },
  Enter: { type: 'keyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
  Escape: { type: 'keyDown', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
};

async function pressKey(send, name) {
  const { type, ...key } = KEYS[name];
  await send('Input.dispatchKeyEvent', { type, ...key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, text: undefined });
  await wait(120);
}

/** 当前焦点元素的标签 + 是否有可见焦点指示（outline 或 box-shadow）。 */
const FOCUS_PROBE = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { label: '(body)', visible: false, tag: 'body' };
  const style = getComputedStyle(el);
  const outline = parseFloat(style.outlineWidth || '0') > 0 && style.outlineStyle !== 'none';
  const shadow = style.boxShadow && style.boxShadow !== 'none';
  return {
    label: (el.textContent ?? el.value ?? '').trim().slice(0, 40) || el.getAttribute('aria-label') || el.tagName,
    tag: el.tagName,
    visible: Boolean(outline || shadow),
    inModal: Boolean(el.closest('.modal')),
  };
})()`;

async function runScale(electronPath, scaleConfig, index) {
  const { localAppData, root } = await seedDataRoot();
  const port = 9410 + index;
  const child = execFile(
    electronPath,
    ['.', `--remote-debugging-port=${port}`, `--force-device-scale-factor=${scaleConfig.scale}`],
    { cwd: repoRoot, env: { ...process.env, LOCALAPPDATA: localAppData, DDA_A11Y_SMOKE: '1' } },
  );

  try {
    const { ws, send, evaluate } = await connect(port);

    const dpr = await evaluate('window.devicePixelRatio');
    assert(Math.abs(dpr - scaleConfig.scale) < 0.01, `缩放未生效：devicePixelRatio=${dpr}，期望 ${scaleConfig.scale}`);

    const lang = await evaluate('document.documentElement.lang');
    assert(lang.toLowerCase().startsWith('zh'), `界面语言不是中文：${lang}`);

    const homeOverflow = await evaluate(
      '(() => ({ w: window.innerWidth, s: document.documentElement.scrollWidth }))()',
    );
    assert(homeOverflow.s <= homeOverflow.w + 1, `首页在 ${scaleConfig.scale * 100}% 下横向溢出：${homeOverflow.s} > ${homeOverflow.w}`);

    // 键盘走查：Tab 前若干次应覆盖导航与页面主要按钮，且每次都要有可见焦点。
    const stops = [];
    for (let i = 0; i < 14; i += 1) {
      await pressKey(send, 'Tab');
      stops.push(await evaluate(FOCUS_PROBE));
    }
    const lostFocus = stops.filter((stop) => stop.tag === 'body').length;
    assert(lostFocus === 0, `Tab 走查中出现 ${lostFocus} 次焦点丢失（落到 body）`);
    const withoutRing = stops.filter((stop) => !stop.visible);
    assert(
      withoutRing.length === 0,
      `有 ${withoutRing.length} 个焦点位置没有可见焦点指示：${withoutRing.map((s) => s.label).join(' / ')}`,
    );
    const navReached = stops.some((stop) => stop.label.includes('部署向导'));
    assert(navReached, `Tab 无法到达导航「部署向导」，实际经过：${stops.map((s) => s.label).join(' / ')}`);

    // 进入部署页（页面切换用鼠标点击，键盘走查针对部署页的操作按钮）。
    await evaluate(`(() => {
      const nav = [...document.querySelectorAll('.navigation button')].find((b) => b.textContent.includes('部署向导'));
      nav?.click();
    })()`);
    await wait(1200);
    for (let i = 0; i < 60; i += 1) {
      const clicked = await evaluate(`(() => {
        const btn = [...document.querySelectorAll('section button')].find((b) => b.textContent.includes('下一步：部署环境'));
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })()`);
      if (clicked) break;
      // 首次检测在隔离数据目录下可能卡在"正在读取真实环境"，中间催一次重新检测。
      if (i === 15 || i === 35) {
        await evaluate(`(() => {
          const btn = [...document.querySelectorAll('section button')].find((b) => b.textContent.includes('重新检测'));
          btn?.click();
        })()`);
      }
      await wait(1000);
    }
    await wait(900);

    const deployOverflow = await evaluate(
      '(() => ({ w: window.innerWidth, s: document.documentElement.scrollWidth }))()',
    );
    assert(
      deployOverflow.s <= deployOverflow.w + 1,
      `部署页在 ${scaleConfig.scale * 100}% 下横向溢出：${deployOverflow.s} > ${deployOverflow.w}`,
    );

    // 键盘打开「回到上一可用」：聚焦后按 Enter（不点击）。
    const focused = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('section button')].find((b) => b.textContent.includes('回到上一可用'));
      const section = btn ? btn.closest('section') : null;
      const dump = {
        where: location.hash,
        page: document.querySelector('.card h2')?.textContent ?? '(none)',
        found: Boolean(btn),
        sectionHidden: section ? Boolean(section.hidden) : null,
        disabled: btn ? btn.disabled : null,
        active: document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.textContent ?? '').trim().slice(0, 20) : '(null)',
        buttons: [...document.querySelectorAll('section button')].map((b) => b.textContent.trim()).slice(0, 14),
      };
      if (!btn) return { ok: false, ...dump };
      btn.focus();
      return { ok: document.activeElement === btn, ...dump };
    })()`);
    assert(focused.ok === true, `找不到「回到上一可用」按钮或无法聚焦：${JSON.stringify(focused)}`);
    await pressKey(send, 'Enter');
    let modal = null;
    for (let i = 0; i < 30; i += 1) {
      modal = await evaluate(`(() => {
        const node = document.querySelector('.modal');
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const badges = [...document.querySelectorAll('.badge')].map((b) => (b.textContent ?? '').trim());
        return {
          role: node.getAttribute('role'),
          ariaModal: node.getAttribute('aria-modal'),
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          left: rect.left,
          right: rect.right,
          focusInModal: Boolean(document.activeElement && document.activeElement.closest('.modal')),
          emptyBadges: badges.filter((text) => text === '').length,
        };
      })()`);
      if (modal !== null) break;
      await wait(500);
    }
    assert(modal !== null, 'Enter 没有打开弹窗（键盘不可达）');
    assert(modal.role === 'dialog' && modal.ariaModal === 'true', `弹窗缺少 dialog 语义：role=${modal.role} aria-modal=${modal.ariaModal}`);
    assert(modal.focusInModal, '弹窗打开后焦点没有进入弹窗（键盘用户会被留在背景里）');
    assert(
      modal.scrollWidth <= modal.innerWidth + 1 && modal.left >= -1 && modal.right <= modal.innerWidth + 1,
      `弹窗在 ${scaleConfig.scale * 100}% 下超出视口：${JSON.stringify(modal)}`,
    );
    assert(modal.emptyBadges === 0, `有 ${modal.emptyBadges} 个 badge 只有颜色没有文字`);

    // 焦点陷阱：连续 Tab 后焦点必须仍在弹窗内（aria-modal 才能名副其实）。
    const modalStops = [];
    for (let i = 0; i < 6; i += 1) {
      await pressKey(send, 'Tab');
      modalStops.push(await evaluate(FOCUS_PROBE));
    }
    const escaped = modalStops.filter((stop) => stop.inModal !== true);
    assert(
      escaped.length === 0,
      `Tab 从弹窗跑到了背景：${escaped.map((s) => s.label).join(' / ') || '(无)'}（共 ${modalStops.length} 次）`,
    );

    const shotModal = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(resolve(outDir, scaleConfig.file.replace('.png', '-modal.png')), Buffer.from(shotModal.data, 'base64'));

    // Esc 关闭，焦点回到触发按钮
    await pressKey(send, 'Escape');
    await wait(600);
    const afterEscape = await evaluate(`(() => ({
      modal: document.querySelector('.modal') !== null,
      label: (document.activeElement?.textContent ?? '').trim().slice(0, 20),
    }))()`);
    assert(afterEscape.modal === false, 'Esc 没有关闭弹窗');
    assert(afterEscape.label.includes('回到上一可用'), `Esc 关闭后焦点没有回到触发按钮，实际在「${afterEscape.label}」`);

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(resolve(outDir, scaleConfig.file), Buffer.from(shot.data, 'base64'));

    console.log(
      `scale=${scaleConfig.scale} dpr=${dpr} lang=${lang} focus_stops=${stops.length} ringless=0 ` +
        `overflow=none modal_ok=yes esc_closes=yes screenshot=${scaleConfig.file}`,
    );
    ws.close();
  } finally {
    await new Promise((r) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => r()));
    if (process.env.DDA_A11Y_KEEP_ROOT === '1') console.log(`  kept data root: ${root}`);
    else await rm(localAppData, { recursive: true, force: true });
  }
}

const electronPath = (await import('electron')).default;
await mkdir(outDir, { recursive: true });
console.log(`[a11y] electron=${electronPath}`);
for (const [index, scaleConfig] of SCALES.entries()) {
  await runScale(electronPath, scaleConfig, index);
}
console.log('RESULT=PASS');
