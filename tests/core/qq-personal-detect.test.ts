import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  composePersonalQqStatus,
  decideManifestAutomation,
  detectQqnt,
  detectSnowLuma,
  isQqProcess,
  isSnowLumaProcess,
  parseSnowLumaManifest,
  probeOneBot,
  probeTcp,
  readOneBotEndpoint,
  sanitizeSecrets,
  type ComposePersonalQqInput,
  type ProcessInfo,
} from '@dda/core';
import type { SnowLumaManifest } from '@dda/spec';

const manifestPath = join(process.cwd(), 'apps', 'desktop', 'resources', 'manifests', 'snowluma.json');
const at = '2026-11-03T12:00:00.000Z';

async function loadManifest(): Promise<SnowLumaManifest> {
  return parseSnowLumaManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
}

const INSTALL_DIR = 'C:\\Users\\me\\AppData\\Local\\DeepSeekDeployAssistant\\components\\snowluma\\2.4.0';
const QQ_PATH = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';

const qqRunning: ProcessInfo[] = [{ pid: 100, exePath: QQ_PATH }];
const snowlumaRunning: ProcessInfo[] = [
  { pid: 200, exePath: `${INSTALL_DIR}\\node.exe`, cmdline: `node ${INSTALL_DIR}\\index.mjs` },
];

describe('QQ NT 探测', () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

  it('找到 QQ.exe 且在运行', async () => {
    const result = await detectQqnt({
      exists: async () => true,
      listProcesses: async () => qqRunning,
      env,
    });
    expect(result.installed).toBe(true);
    expect(result.running).toBe(true);
    expect(result.pids).toEqual([100]);
    expect(result.evidence.join('\n')).toContain('进程检测');
  });

  it('未安装时明确说"未安装"，不把其它进程当 QQ', async () => {
    const result = await detectQqnt({
      exists: async () => false,
      listProcesses: async () => [{ pid: 1, exePath: 'C:\\Program Files\\nodejs\\node.exe' }],
      env,
    });
    expect(result.installed).toBe(false);
    expect(result.running).toBe(false);
    expect(result.evidence.join('\n')).toContain('未安装');
  });

  it('只认同名 QQ.exe，避免误判腾讯其它进程', () => {
    expect(isQqProcess({ pid: 1, exePath: 'C:\\x\\QQ.exe' })).toBe(true);
    expect(isQqProcess({ pid: 1, exePath: 'C:\\x\\QQProtect.exe' })).toBe(false);
    expect(isQqProcess({ pid: 1 })).toBe(false);
  });
});

describe('SnowLuma 探测', () => {
  const options = { installDir: INSTALL_DIR, expectedVersion: '2.4.0' };

  it('release.json 可读且版本一致 → 已安装', async () => {
    const result = await detectSnowLuma(
      {
        exists: async () => true,
        readJson: async () => ({ version: '2.4.0' }),
        listProcesses: async () => snowlumaRunning,
      },
      options,
    );
    expect(result.installed).toBe(true);
    expect(result.version).toBe('2.4.0');
    expect(result.versionProblem).toBeUndefined();
    expect(result.running).toBe(true);
  });

  it('版本与清单不一致 → 给出 versionProblem（用户需要升级/重装）', async () => {
    const result = await detectSnowLuma(
      {
        exists: async () => true,
        readJson: async () => ({ version: '2.3.4' }),
        listProcesses: async () => [],
      },
      options,
    );
    expect(result.versionProblem).toContain('2.3.4');
    expect(result.versionProblem).toContain('2.4.0');
  });

  it('绝不把整机 node.exe 当成 SnowLuma（关键防误判）', async () => {
    const foreign: ProcessInfo[] = [
      { pid: 9, exePath: 'C:\\Program Files\\nodejs\\node.exe', cmdline: 'node index.mjs' },
    ];
    expect(isSnowLumaProcess(foreign[0]!, INSTALL_DIR)).toBe(false);

    const result = await detectSnowLuma(
      { exists: async () => true, readJson: async () => ({ version: '2.4.0' }), listProcesses: async () => foreign },
      options,
    );
    expect(result.running).toBe(false);
    expect(result.evidence.join('\n')).toContain('不能只看 node.exe');
  });

  it('安装目录不存在 → 明确"未安装/目录不对"', async () => {
    const result = await detectSnowLuma(
      { exists: async () => false, readJson: async () => ({}), listProcesses: async () => [] },
      options,
    );
    expect(result.installed).toBe(false);
    expect(result.evidence.join('\n')).toContain('未安装');
  });
});

describe('端口探测', () => {
  it('可连/不可连都只给事实，不给"已联通"结论', async () => {
    const open = await probeTcp({ connect: async () => true }, { port: 5099, label: 'WebUI' });
    const closed = await probeTcp({ connect: async () => false }, { port: 5099, label: 'WebUI' });
    expect(open.reachable).toBe(true);
    expect(open.line).toContain('可连接');
    expect(closed.line).toContain('不可连接');
  });
});

describe('OneBot 探测', () => {
  it('get_login_info 返回真实 QQ 号才算响应', async () => {
    const result = await probeOneBot(
      { getJson: async () => ({ status: 200, body: { status: 'ok', retcode: 0, data: { user_id: 123456, nickname: '小号' } } }) },
      { baseUrl: 'http://127.0.0.1:3000/', accessToken: 'secret-token-1234' },
    );
    expect(result.responsive).toBe(true);
    expect(result.uin).toBe('123456');
    expect(result.nickname).toBe('小号');
  });

  it('HTTP 200 但没有 user_id → 不算可用', async () => {
    const result = await probeOneBot(
      { getJson: async () => ({ status: 200, body: { status: 'ok', data: {} } }) },
      { baseUrl: 'http://127.0.0.1:3000' },
    );
    expect(result.responsive).toBe(false);
    expect(result.error).toContain('没有返回 QQ 号');
  });

  it('鉴权失败/异常时错误里不得出现访问令牌', async () => {
    const token = 'super-secret-token-abcdef';
    const result = await probeOneBot(
      {
        getJson: async () => {
          throw new Error(`request failed for http://127.0.0.1:3000/get_login_info?access_token=${token} (Bearer ${token})`);
        },
      },
      { baseUrl: 'http://127.0.0.1:3000', accessToken: token },
    );
    expect(result.responsive).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain(token);
    expect(result.error).toContain('access_token=***');
  });

  it('401 明确报 HTTP 状态', async () => {
    const result = await probeOneBot(
      { getJson: async () => ({ status: 401, body: 'unauthorized' }) },
      { baseUrl: 'http://127.0.0.1:3000' },
    );
    expect(result.error).toContain('HTTP 401');
  });

  it('sanitizeSecrets 兜底抹除令牌', () => {
    expect(sanitizeSecrets('token=abcdefg&x=1', ['abcdefg'])).not.toContain('abcdefg');
  });
});

describe('SnowLuma OneBot 配置读取（只读）', () => {
  it('账号级配置优先于全局配置，且证据里不出现令牌', async () => {
    const files: Record<string, unknown> = {
      'onebot.json': { networks: { httpServers: [{ name: 'http-default', port: 3000, accessToken: 'GLOBALTOKEN' }] } },
      'onebot_123456.json': {
        networks: { httpServers: [{ name: 'http-default', port: 3300, accessToken: 'PERACCOUNTTOKEN' }] },
      },
    };
    const result = await readOneBotEndpoint(
      {
        readdir: async () => Object.keys(files),
        readJson: async (path) => files[path.split(/[\\/]/).pop()!],
      },
      { installDir: INSTALL_DIR, defaultPort: 3000 },
    );

    expect(result.endpoint?.port).toBe(3300);
    expect(result.endpoint?.baseUrl).toBe('http://127.0.0.1:3300');
    expect(result.endpoint?.accessToken).toBe('PERACCOUNTTOKEN');
    expect(result.evidence.join('\n')).not.toContain('PERACCOUNTTOKEN');
    expect(result.evidence.join('\n')).not.toContain('GLOBALTOKEN');
  });

  it('没有配置文件时给出可理解的原因', async () => {
    const result = await readOneBotEndpoint(
      { readdir: async () => { throw new Error('ENOENT'); }, readJson: async () => ({}) },
      { installDir: INSTALL_DIR, defaultPort: 3000 },
    );
    expect(result.endpoint).toBeUndefined();
    expect(result.evidence.join('\n')).toContain('不存在或不可读');
  });
});

describe('个人 QQ 状态合成（八相位）', () => {
  const webuiOk = { reachable: true, line: '端口检测：WebUI 127.0.0.1:5099 可连接' };

  async function input(overrides: Partial<ComposePersonalQqInput> = {}): Promise<ComposePersonalQqInput> {
    const manifest = await loadManifest();
    return {
      manifest,
      automation: decideManifestAutomation(manifest),
      qq: { installed: true, path: QQ_PATH, running: true, pids: [100], evidence: ['文件检测：找到 QQ.exe'] },
      snowluma: {
        installed: true,
        installDir: INSTALL_DIR,
        version: '2.4.0',
        running: true,
        pids: [200],
        evidence: ['版本比对：与清单一致（2.4.0）'],
      },
      webui: webuiOk,
      onebot: { reachable: true, responsive: true, uin: '123456' },
      onebotEvidence: ['配置读取：onebot_123456.json 中 http-default 为 127.0.0.1:3000（带访问令牌）'],
      adapter: { installed: true, version: '1.5.1', expectedVersion: '1.5.1' },
      bridge: { ok: true, adapterVersion: '1.5.1', backendOk: true },
      now: new Date(at),
      ...overrides,
    };
  }

  it('缺 QQ → qq-missing，并指向官网安装', async () => {
    const status = composePersonalQqStatus(
      await input({
        qq: { installed: false, running: false, pids: [], evidence: ['文件检测：未安装'] },
        snowluma: { installed: false, running: false, pids: [], evidence: ['文件检测：未安装'] },
      }),
    );
    expect(status.phase).toBe('qq-missing');
    expect(status.nextStep).toContain('QQ');
  });

  it('QQ 已装但没运行 → qq-not-running（即使用户已经装了 SnowLuma）', async () => {
    const status = composePersonalQqStatus(
      await input({ qq: { installed: true, running: false, pids: [], evidence: [] } }),
    );
    expect(status.phase).toBe('qq-not-running');
  });

  it('缺组件 → snowluma-not-installed；未授权时下一步是"打开官方下载页"', async () => {
    const status = composePersonalQqStatus(
      await input({ snowluma: { installed: false, running: false, pids: [], evidence: [] } }),
    );
    expect(status.phase).toBe('snowluma-not-installed');
    expect(status.nextStep).toContain('官方下载页');
    expect(status.automation.allowed).toBe(false);
  });

  it('组件已装未运行 → snowluma-installed；未授权时让用户自己启动 launcher.bat', async () => {
    const status = composePersonalQqStatus(
      await input({ snowluma: { installed: true, installDir: INSTALL_DIR, running: false, pids: [], evidence: [] } }),
    );
    expect(status.phase).toBe('snowluma-installed');
    expect(status.nextStep).toContain('launcher.bat');
  });

  it('进程在跑但 OneBot 没响应 → snowluma-running（不是"已连接"）', async () => {
    const status = composePersonalQqStatus(
      await input({ onebot: { reachable: false, responsive: false, error: 'connect ECONNREFUSED' } }),
    );
    expect(status.phase).toBe('snowluma-running');
    expect(status.message).toContain('服务还没有响应');
  });

  it('OneBot 通了但适配插件没联通 → snowluma-logged-in', async () => {
    const status = composePersonalQqStatus(await input({ bridge: undefined }));
    expect(status.phase).toBe('snowluma-logged-in');
    expect(status.nextStep).toContain('打通 Harness');
  });

  it('全部通过 → harness-linked；用户确认后才到 message-verified', async () => {
    const linked = composePersonalQqStatus(await input());
    expect(linked.phase).toBe('harness-linked');
    expect(linked.evidence.some((item) => item.source === 'bridge')).toBe(true);

    const verified = composePersonalQqStatus(await input({ messageVerified: true }));
    expect(verified.phase).toBe('message-verified');
  });

  it('探测异常 → failed，证据里带上错误但不得含令牌', async () => {
    const token = 'tok-abcdef-123456';
    const status = composePersonalQqStatus(
      await input({
        errors: [`probe failed: access_token=${token}`],
        onebot: { reachable: false, responsive: false, error: sanitizeSecrets(`bad token ${token}`, [token]) },
      }),
    );
    expect(status.phase).toBe('failed');
    const text = status.evidence.map((item) => item.line).join('\n');
    expect(text).not.toContain(token);
    expect(text).toContain('错误：');
  });

  it('许可证依据每次都要出现在证据里（便于事后复核）', async () => {
    const status = composePersonalQqStatus(await input());
    expect(status.evidence.some((item) => item.source === 'license')).toBe(true);
  });
});
