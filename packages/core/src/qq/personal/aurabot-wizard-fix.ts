/**
 * Aurabot 向导第 4 步的「下一步」只在 WebSocket 已连上、并且内部核对通过时才可点。
 * 「测试连接」走的是 HTTP，弹窗写「连上了」也不会打开这个按钮。
 * 连接如果卡在「正在连接」，原插件不会超时重试。
 *
 * 这些替换只作用于已经安装的 `dsh-aurabot-qq@1.2.0` 源码，并且可以重复执行。
 */

const CONNECT_TIMEOUT_MARKER = 'dda:ws-connect-timeout';

export function patchAurabotOnebotClient(source: string): string {
  const closeOld = `    sock.onclose = (ev) => {\n      if (ws === sock) ws = null`;
  const closeNew = `    sock.onclose = (ev) => {\n      clearTimeout(giveUp)\n      if (ws === sock) ws = null`;
  if (source.includes(CONNECT_TIMEOUT_MARKER)) {
    return source.includes(closeOld) ? source.replace(closeOld, closeNew) : source;
  }
  const original = `  function connect() {
    if (stopped) return
    const ep = endpoint()
    if (!ep.wsUrl) {
      setState('unconfigured', '没有 WS 地址')
      schedule()
      return
    }
    setState('connecting')
    let url = ep.wsUrl
    if (ep.wsToken) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ep.wsToken)
    let sock
    try {
      sock = new WebSocket(url)
    } catch (error) {
      log.warn('WS 连接失败：', error.message)
      schedule()
      return
    }
    ws = sock
    sock.onopen = () => {
      backoff = RECONNECT_MIN
      setState('connected')`;
  const patched = `  function connect() {
    if (stopped) return
    const ep = endpoint()
    if (!ep.wsUrl) {
      setState('unconfigured', '没有 WS 地址')
      schedule()
      return
    }
    // ${CONNECT_TIMEOUT_MARKER}：卡在连接中就关掉重试，避免「测试连接」已成功但向导下一步一直是灰的。
    if (ws && ws.readyState === 0) {
      try { ws.close() } catch (error) {}
    }
    setState('connecting')
    let url = ep.wsUrl
    if (ep.wsToken) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ep.wsToken)
    let sock
    try {
      sock = new WebSocket(url)
    } catch (error) {
      log.warn('WS 连接失败：', error.message)
      schedule()
      return
    }
    ws = sock
    const giveUp = setTimeout(() => {
      if (sock.readyState === 0) {
        log.warn('WS 连接超过 8 秒还没连上，准备重试')
        try { sock.close() } catch (error) {}
      }
    }, 8000)
    sock.onopen = () => {
      clearTimeout(giveUp)
      backoff = RECONNECT_MIN
      setState('connected')`;
  if (!source.includes(original)) return source;
  return source.replace(original, patched).replace(
    `    sock.onclose = (ev) => {
      if (ws === sock) ws = null`,
    `    sock.onclose = (ev) => {
      clearTimeout(giveUp)
      if (ws === sock) ws = null`,
  );
}

export function patchAurabotWizard(source: string): string {
  const verified = 'const verified = conn && login && String(login.uin) === String(st.config.botQQ) && !st.onebot.problem';
  const verifiedNext = 'const verified = conn && login && String(login.uin) === String(st.config.botQQ)';
  let next = source.includes(verified) ? source.replace(verified, verifiedNext) : source;
  next = next.replaceAll(
    "const r = await get('/onebot/test'); toast(r.message) }",
    "const r = await get('/onebot/test'); toast(r.message); reload() }",
  );
  return next;
}

export function patchAurabotHost(source: string): string {
  const original = "problem: onebotState === 'connected' && loginOk ? '' : await connectionProblem()";
  const patched = "problem: onebotState === 'connected' && (loginOk || (login && login.uin === String(cfg.botQQ))) ? '' : await connectionProblem()";
  if (!source.includes(original) || source.includes(patched)) return source;
  return source.replace(original, patched);
}
