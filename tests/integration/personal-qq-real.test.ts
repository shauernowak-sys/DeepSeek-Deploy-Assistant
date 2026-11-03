import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createNodeBridgeDeps, readBridgeState, toBridgeState } from '@dda/core';

import type { Container } from '../../apps/desktop/src/main/services/container';
import type { HarnessService } from '../../apps/desktop/src/main/services/harness-service';
import { PersonalQqService } from '../../apps/desktop/src/main/services/personal-qq-service';

/**
 * 真实环境验收（门控）。
 *
 * 只有显式设置环境变量才运行，避免 CI/普通 `pnpm test` 依赖本机状态：
 *   DDA_REAL_PERSONAL_QQ=1
 *   DDA_REAL_HARNESS_URL=http://127.0.0.1:<port>       （Harness 正在运行）
 *   DDA_REAL_HARNESS_TOKEN=<url 里的 token>
 *
 * 断言的都是"真实探测结果"，任何一项环境不具备时都应给出明确的不通过原因，而不是伪造成功。
 */
const REAL = process.env.DDA_REAL_PERSONAL_QQ === '1';
const DATA_ROOT = process.env.DDA_REAL_DATA_ROOT ?? '';
const HARNESS_URL = process.env.DDA_REAL_HARNESS_URL ?? '';
const HARNESS_TOKEN = process.env.DDA_REAL_HARNESS_TOKEN ?? '';
const MANIFESTS = resolve(process.cwd(), 'apps', 'desktop', 'resources', 'manifests');

function containerStub(root: string): Container {
  return {
    paths: { root },
    manifestsDir: MANIFESTS,
    registry: 'https://registry.npmmirror.com',
    logger: { info: async () => undefined, warn: async () => undefined, error: async () => undefined },
  } as unknown as Container;
}

/** 用真实 `dsh plugin list` 覆盖"插件是否已安装"，不猜。 */
function realPluginList(): { name: string; version: string }[] {
  const node = join(DATA_ROOT, 'runtimes', 'node', '22.23.4', 'node.exe');
  const bin = join(DATA_ROOT, 'harness', '0.2.0-rc.2', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const stdout = execFileSync(node, [bin, 'plugin', '--profile', 'web', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: join(DATA_ROOT, 'dsh-home') },
    timeout: 180_000,
  });
  const plugins: { name: string; version: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(?:└── |├── )(@?[A-Za-z0-9][\w./@-]*)@([0-9][\w.+-]*)$/.exec(line);
    if (match) plugins.push({ name: match[1]!, version: match[2]! });
  }
  return plugins;
}

describe.skipIf(!REAL)('真实环境：个人 QQ 适配层（dsh-qq-link + Harness）', () => {
  it('bridge 状态接口返回真实结构，且令牌不出现在结果里', async () => {
    const result = await readBridgeState(createNodeBridgeDeps(), {
      baseUrl: HARNESS_URL,
      token: HARNESS_TOKEN,
    });

    console.log('[real] bridge errorCode=', result.errorCode ?? 'none');
    console.log('[real] bridge ok=', result.ok, 'backendOk=', result.backendOk, 'adapter=', result.adapterVersion);
    console.log('[real] bridge sessions=', result.sessionIds?.length ?? 0, 'bindings=', result.bindings?.length ?? 0);
    if (result.errorMessage) console.log('[real] bridge message=', result.errorMessage);

    // 状态接口本身必须是通的（插件已加载 + 会话 cookie 通过），这一条与 SnowLuma 是否在跑无关。
    expect(result.ok).toBe(true);
    expect(result.adapterVersion).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(HARNESS_TOKEN);
    expect(toBridgeState(result).ok).toBe(Boolean(result.backendOk));

    // OneBot 后端是否可用取决于 SnowLuma 是否真的在运行：没有后端时必须如实报错，不得假装联通。
    if (process.env.DDA_REAL_EXPECT_BACKEND === '1') {
      expect(result.backendOk).toBe(true);
      expect(result.errorCode).toBeUndefined();
    } else {
      expect(result.backendOk).toBe(false);
      expect(result.errorCode).toBe('backend-unreachable');
      expect(result.errorMessage).toBeTruthy();
    }
  });

  it('服务层在真实机器上给出诚实相位（SnowLuma 未装时必须说未安装）', async () => {
    const plugins = realPluginList();
    const installed = plugins.some((item) => item.name === 'dsh-qq-link');

    const harness = {
      running: true,
      auth: () => ({ baseUrl: HARNESS_URL, token: HARNESS_TOKEN }),
      listPlugins: async () => plugins.map((item) => ({ ...item, installed: true })),
      installPlugin: async () => undefined,
      removePlugin: async () => undefined,
      restart: async () => ({ running: true }),
    } as unknown as HarnessService;

    const service = new PersonalQqService(containerStub(DATA_ROOT), harness, { env: process.env, manifestsDir: MANIFESTS });
    const status = await service.status();

    console.log('[real] plugin dsh-qq-link installed=', installed);
    console.log('[real] phase=', status.phase);
    console.log('[real] qq installed=', status.client.installed, 'running=', status.client.running);
    console.log('[real] snowluma installed=', status.component.installed, 'dir=', status.component.installDir ?? '-');
    console.log('[real] onebot responsive=', status.service.onebotResponsive, 'error=', status.service.error ?? '-');
    console.log('[real] automation allowed=', status.automation.allowed);
    for (const item of status.evidence) console.log(`[real] evidence[${item.source}] ${item.line}`);

    expect(installed).toBe(true);
    expect(status.adapter.installed).toBe(true);
    // 本机没有安装 SnowLuma 时，必须如实报告未安装，不能因为插件存在就说"已联通"。
    expect(status.phase).toBe('snowluma-not-installed');
    expect(status.bridge?.sessionIds?.length ?? 0).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(status)).not.toContain('do-not-leak');
  });
});
