import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyManagedBlock, readQqEntry, readStoredCredentials } from '@dda/core';
import { appPaths, type AppPaths } from '@dda/adapters';
import { DEFAULT_QQ_SETTINGS, QqCredentialsSchema, type QqSettings } from '@dda/spec';

/** Same DPAPI fake used by the M3.1 service tests: ciphertext only ever touches disk. */
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  },
}));

const { QqService } = await import('../../apps/desktop/src/main/services/qq-service');
const { Secrets } = await import('../../apps/desktop/src/main/security/secrets');
const { Logger } = await import('@dda/core');

const APPID = '102000001';
const SECRET = 'qq-secret-value-000111';

const apiConfig = {
  template: 'deepseek' as const,
  label: 'DeepSeek 官方',
  protocol: 'anthropic-messages' as const,
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
  credentialRef: 'DEEPSEEK_API_KEY',
  contextWindow: 1_000_000,
};

const settings: QqSettings = {
  ...DEFAULT_QQ_SETTINGS,
  requireMention: false,
  textChunkLimit: 3000,
  access: { ...DEFAULT_QQ_SETTINGS.access, groupMode: 'allowlist', groupAllow: ['group-openid'] },
};

function fakeHarness(overrides: Record<string, unknown> = {}) {
  return {
    running: false,
    startedAt: undefined,
    pluginEvents: [],
    outputTail: () => [],
    listPlugins: async () => [{ name: '@tencent-connect/dsh-qqbot', version: '0.5.5', installed: true }],
    installQqPlugin: async () => undefined,
    restart: async () => ({ running: true }),
    launch: async () => ({ running: true }),
    ...overrides,
  };
}

async function fixture(harness = fakeHarness()) {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-m32-'));
  const paths: AppPaths = appPaths(localAppData);
  await mkdir(paths.logs, { recursive: true });
  await mkdir(join(paths.dshHome, 'profiles', 'web'), { recursive: true });
  // Fake runtime layout: status() keys "deployed" off the real files, not off a mock flag.
  const dshBin = join(paths.harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  await mkdir(join(paths.harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
  await writeFile(dshBin, '', 'utf8');
  await mkdir(paths.nodeDir, { recursive: true });
  await writeFile(join(paths.nodeDir, 'node.exe'), '', 'utf8');
  const logger = await Logger.create(paths.logs, 'test.log');
  const secrets = new Secrets(paths.root);
  const container = { paths, logger, registry: 'https://registry.npmmirror.com' } as never;
  const service = new QqService(container, secrets, harness as never, { verify: async () => [] });
  const patchPath = join(paths.dshHome, 'profiles', 'web', 'cordis.patch.yml');
  return { paths, secrets, service, patchPath, harness };
}

describe('QQ 凭据：DPAPI 加密 + 环境变量注入（方式 A）', () => {
  it('保存后凭据只在密文里，patch 只写占位符，launchEnv 提供注入值', async () => {
    const { paths, service, patchPath } = await fixture();
    const result = await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    expect(result.ok).toBe(true);

    const patch = await readFile(patchPath, 'utf8');
    expect(patch).not.toContain(SECRET);
    expect(patch).not.toContain(APPID);
    expect(readQqEntry(patch).config.appId).toBe('__FROM_ENV__');
    expect(readStoredCredentials(patch).plaintext).toBe(false);

    expect(await service.launchEnv()).toEqual({ QQBOT_APPID: APPID, QQBOT_SECRET: SECRET });

    // 整个数据目录不得出现明文密钥（与 M3.1 同样的强断言）
    const files = await readdir(paths.root, { recursive: true, withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const full = join(entry.parentPath ?? paths.root, entry.name);
      const content = await readFile(full, 'utf8').catch(() => '');
      expect(content).not.toContain(SECRET);
    }

    const view = await service.settings();
    expect(view.credentialSource).toBe('dpapi');
    expect(view.appId).toBe(APPID);
    expect(view.appSecretMask).toBe('qq-****0111');
    expect(view.plaintextInProfile).toBe(false);
  });

  it('解绑：清除密文并把凭据字段从 patch 移除，launchEnv 变空', async () => {
    const { paths, service, patchPath } = await fixture();
    await service.saveCredentials({ appId: APPID, appSecret: SECRET });

    const removed = await service.deleteCredentials();
    expect(removed.ok).toBe(true);
    expect(await service.launchEnv()).toEqual({});

    const patch = await readFile(patchPath, 'utf8');
    const entry = readQqEntry(patch);
    expect(entry.present).toBe(true);
    expect('appId' in entry.config).toBe(false);
    expect('appSecret' in entry.config).toBe(false);

    // 设置项保留，用户不必重填
    await service.saveSettings({ settings, mode: 'qr' });
    await expect(readFile(patchPath, 'utf8')).resolves.toContain('requireMention: false');
    expect(await service.settings().then((s) => s.credentialSource)).toBe('none');
  });

  it('无效凭据被 schema 拒绝（IPC 层同样校验）', () => {
    expect(QqCredentialsSchema.safeParse({ appId: '', appSecret: SECRET }).success).toBe(false);
    expect(QqCredentialsSchema.safeParse({ appId: '102 0001', appSecret: SECRET }).success).toBe(false);
    expect(QqCredentialsSchema.safeParse({ appId: APPID, appSecret: 'short' }).success).toBe(false);
    expect(QqCredentialsSchema.safeParse({ appId: APPID, appSecret: SECRET }).success).toBe(true);
  });
});

describe('QQ 凭据：官方扫码后的明文迁移（方式 B → DPAPI）', () => {
  it('把插件写入的明文搬到 DPAPI 并从 patch 清掉', async () => {
    const { service, patchPath } = await fixture();
    // 模拟插件扫码成功后的写法：字面量 appId/appSecret
    await service.saveSettings({ settings, mode: 'qr' });
    await writeFile(
      patchPath,
      [
        '# >>> dda:managed:qq:begin  (DeepSeek Deploy Assistant 写入，请勿手工修改)',
        '- id: im-qqbot',
        '  config:',
        `    appId: '${APPID}'`,
        `    appSecret: '${SECRET}'`,
        '    requireMention: false',
        '# <<< dda:managed:qq:end',
        '',
      ].join('\n'),
      'utf8',
    );
    expect((await service.settings()).plaintextInProfile).toBe(true);

    const migrated = await service.migrateToDpapi();
    expect(migrated.ok).toBe(true);

    const patch = await readFile(patchPath, 'utf8');
    expect(patch).not.toContain(SECRET);
    expect(patch).not.toContain(APPID);
    expect(readQqEntry(patch).config.appId).toBe('__FROM_ENV__');
    expect(await service.launchEnv()).toEqual({ QQBOT_APPID: APPID, QQBOT_SECRET: SECRET });
    expect((await service.settings()).plaintextInProfile).toBe(false);
  });

  it('没有明文可迁移时明确失败，不偷偷改动任何东西', async () => {
    const { service } = await fixture();
    const result = await service.migrateToDpapi();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('没有找到');
  });
});

describe('QQ 配置写入与 M3.1 API 配置互不影响', () => {
  it('保存 QQ 设置后 API 受管块仍然存在（回归）', async () => {
    const { service, patchPath } = await fixture();
    await writeFile(patchPath, applyManagedBlock('[]\n', apiConfig), 'utf8');

    const saved = await service.saveSettings({ settings, mode: 'env' });
    expect(saved.ok).toBe(true);

    const patch = await readFile(patchPath, 'utf8');
    expect(patch).toContain('apiKeyEnv: DEEPSEEK_API_KEY');
    expect(patch).toContain('agent-default-model');
    expect(patch).toContain('im-qqbot');
    expect(patch).toContain('requireMention: false');
  });

  it('切换凭据方式为 env 时，如果 Harness 在跑就重启（让启动环境重新注入）', async () => {
    const restart = vi.fn(async () => ({ running: true }));
    const { service } = await fixture(fakeHarness({ running: true, restart }));
    const result = await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result.restarted).toBe(true);
  });

  it('Harness 未运行时不做重启，只提示"启动时生效"', async () => {
    const restart = vi.fn(async () => ({ running: true }));
    const { service } = await fixture(fakeHarness({ running: false, restart }));
    const result = await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    expect(restart).not.toHaveBeenCalled();
    expect(result.restarted).toBe(false);
    expect(result.message).toContain('启动 Harness');
  });

  it('点"官方扫码"时即使 Harness 没在跑也会启动它（一键入口）', async () => {
    const launch = vi.fn(async () => ({ running: true }));
    const restart = vi.fn(async () => ({ running: true }));
    const { service } = await fixture(fakeHarness({ running: false, launch, restart }));
    const result = await service.startBinding();
    expect(result.ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it('扫码不会清掉已保存的凭据（改为环境置空，可随时取消回到原路径）', async () => {
    const { service, patchPath } = await fixture(fakeHarness({ running: false }));
    await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    await service.startBinding();
    const patch = await readFile(patchPath, 'utf8');
    expect(patch).not.toContain(SECRET);
    // DPAPI 里的凭据仍在（取消扫码即可恢复），所以 launchEnv 是"置空 + 打开官方授权页"
    const env = await service.launchEnv();
    expect(env.QQBOT_APPID).toBe('');
    expect(env.QQBOT_BIND_OPEN_BROWSER).toBe('1');
  });
});

describe('扫码流程：不破坏已验证成功的 AppID/AppSecret 路径（回归）', () => {
  it('点"官方扫码绑定"不删除 DPAPI 凭据，只是让子进程环境看到空值', async () => {
    const { service } = await fixture(fakeHarness({ running: false }));
    await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    expect(await service.launchEnv()).toEqual({ QQBOT_APPID: APPID, QQBOT_SECRET: SECRET });

    const bound = await service.startBinding();
    expect(bound.ok).toBe(true);

    // 环境里显式置空（触发官方扫码）+ 打开官方降级通道
    const env = await service.launchEnv();
    expect(env.QQBOT_APPID).toBe('');
    expect(env.QQBOT_SECRET).toBe('');
    expect(env.QQBOT_BIND_OPEN_BROWSER).toBe('1');

    // 凭据仍在 DPAPI：取消扫码后立即恢复
    const cancelled = await service.cancelBinding();
    expect(cancelled.ok).toBe(true);
    expect(await service.launchEnv()).toEqual({ QQBOT_APPID: APPID, QQBOT_SECRET: SECRET });
    expect((await service.settings()).credentialSource).toBe('dpapi');
  });

  it('重新生成二维码会再启动一次 Harness，并累计尝试次数', async () => {
    const launch = vi.fn(async () => ({ running: true }));
    const { service } = await fixture(fakeHarness({ running: false, launch }));
    await service.startBinding();
    const second = await service.startBinding({ regenerate: true });
    expect(second.ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect((await service.status()).bindingAttempts).toBe(2);
  });

  it('扫码模式下状态不会因为"有 DPAPI 凭据"就判成 connecting', async () => {
    const { service } = await fixture(fakeHarness({ running: true, startedAt: new Date().toISOString() }));
    await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    await service.startBinding();
    const status = await service.status();
    // patch 已切到 qr 模式：凭据来源回到 none/待扫码，而不是"拿着旧凭据在连接"
    expect(['binding', 'unbound']).toContain(status.phase);
    expect(status.credentialSource).not.toBe('dpapi');
  });

  it('保存新凭据会退出扫码模式', async () => {
    const { service } = await fixture(fakeHarness({ running: false }));
    await service.startBinding();
    expect((await service.settings()).bindingMode).toBe(true);
    await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    expect((await service.settings()).bindingMode).toBe(false);
    expect(await service.launchEnv()).toEqual({ QQBOT_APPID: APPID, QQBOT_SECRET: SECRET });
  });
});

describe('QQ 状态：区分"装了插件"与"真的连上"', () => {
  it('插件已装、Harness 未运行 → installed', async () => {
    const { service } = await fixture();
    const status = await service.status();
    expect(status.phase).toBe('installed');
    expect(status.pluginVersion).toBe('0.5.5');
  });

  it('版本不匹配 → version-mismatch', async () => {
    const harness = fakeHarness({
      listPlugins: async () => [{ name: '@tencent-connect/dsh-qqbot', version: '0.4.0', installed: true }],
    });
    const { service } = await fixture(harness);
    expect((await service.status()).phase).toBe('version-mismatch');
  });

  it('有凭据但在跑、尚未 ready → connecting（不因配置存在而宣称已连接）', async () => {
    const harness = fakeHarness({ running: true, startedAt: new Date().toISOString() });
    const { service } = await fixture(harness);
    await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    expect((await service.status()).phase).toBe('connecting');
  });

  it('Bot ready 事件 → connected', async () => {
    const harness = fakeHarness({
      running: true,
      startedAt: new Date().toISOString(),
      pluginEvents: [{ at: new Date().toISOString(), event: { kind: 'ready', appId: APPID } }],
    });
    const { service } = await fixture(harness);
    await service.saveCredentials({ appId: APPID, appSecret: SECRET });
    const status = await service.status();
    expect(status.phase).toBe('connected');
    expect(status.appId).toBe(APPID);
  });
});
