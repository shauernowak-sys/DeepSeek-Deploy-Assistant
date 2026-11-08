import { describe, expect, it } from 'vitest';

import { patchAurabotHost, patchAurabotOnebotClient, patchAurabotWizard } from '@dda/core';

const client = `  function connect() {
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
      setState('connected')
      log.info('已连上 QQ 网关（WS）')
    }
    sock.onclose = (ev) => {
      if (ws === sock) ws = null
    }
`;

describe('Aurabot 向导第 4 步不再被卡住的连接挡住', () => {
  it('连接超过 8 秒会关掉重试，并且重复打补丁不会再改', () => {
    const once = patchAurabotOnebotClient(client);
    expect(once).toContain('dda:ws-connect-timeout');
    expect(once).toContain('clearTimeout(giveUp)');
    expect(patchAurabotOnebotClient(once)).toBe(once);
  });

  it('登录号已经对上时，下一步不再额外要求 problem 为空；测试连接后会刷新', () => {
    const source = [
      'const verified = conn && login && String(login.uin) === String(st.config.botQQ) && !st.onebot.problem',
      "const r = await get('/onebot/test'); toast(r.message) } }, '测试连接')",
      "const r = await get('/onebot/test'); toast(r.message) } }, '测试连接')",
    ].join('\n');
    const once = patchAurabotWizard(source);
    expect(once).toContain('const verified = conn && login && String(login.uin) === String(st.config.botQQ)\n');
    expect(once).not.toContain('!st.onebot.problem');
    expect(once.match(/reload\(\)/g)).toHaveLength(2);
    expect(patchAurabotWizard(once)).toBe(once);
  });

  it('页面已经读到匹配的登录号时，不再把连接问题写成未连上', () => {
    const source = "problem: onebotState === 'connected' && loginOk ? '' : await connectionProblem()";
    const once = patchAurabotHost(source);
    expect(once).toContain('login && login.uin === String(cfg.botQQ)');
    expect(patchAurabotHost(once)).toBe(once);
  });
});
