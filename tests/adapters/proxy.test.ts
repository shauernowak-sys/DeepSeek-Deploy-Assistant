import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appPaths } from '@dda/adapters';
import {
  assertArgsSafe,
  describeProxyReport,
  dshEnv,
  findDeadProxySettings,
  parseProxySettings,
  probeProxy,
  stripProxyEnv,
} from '@dda/adapters';

const connectAlways = (ok: boolean) => async () => ok;

describe('P-11 代理环境变量解析', () => {
  it('大小写同名变量只取一次，非法值忽略', () => {
    const settings = parseProxySettings({
      HTTP_PROXY: 'http://127.0.0.1:7990',
      http_proxy: 'http://127.0.0.1:7990',
      HTTPS_PROXY: 'socks5://127.0.0.1:1080',
      ALL_PROXY: 'not a url',
      NO_PROXY: 'localhost',
    } as NodeJS.ProcessEnv);

    expect(settings).toEqual([{ name: 'HTTP_PROXY', url: 'http://127.0.0.1:7990' }]);
  });

  it('未设置时返回空表', () => {
    expect(parseProxySettings({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('P-11 代理可达性探测', () => {
  it('连接成功 → 可达；连接失败 → 不可达', async () => {
    expect(await probeProxy('http://127.0.0.1:7990', { connectImpl: connectAlways(true) })).toBe(true);
    expect(await probeProxy('http://127.0.0.1:7990', { connectImpl: connectAlways(false) })).toBe(false);
  });

  it('无法解析的地址按不可达处理', async () => {
    expect(await probeProxy('::bad::', { connectImpl: connectAlways(true) })).toBe(false);
  });

  it('区分已死与可达的代理', async () => {
    const report = await findDeadProxySettings(
      {
        HTTP_PROXY: 'http://127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:2',
      } as NodeJS.ProcessEnv,
      {
        connectImpl: async (_host, port) => port === 2,
      },
    );

    expect(report.dead.map((item) => item.name)).toEqual(['HTTP_PROXY']);
    expect(report.reachable.map((item) => item.name)).toEqual(['HTTPS_PROXY']);
    expect(describeProxyReport(report)).toContain('不可达');
  });
});

describe('P-11 只剔除子进程副本，不动 process.env', () => {
  it('stripProxyEnv 返回新对象，保留 NO_PROXY，原对象不变', () => {
    const original = {
      HTTP_PROXY: 'http://127.0.0.1:7990',
      HTTPS_PROXY: 'http://127.0.0.1:7990',
      NO_PROXY: 'localhost,127.0.0.1',
      PATH: 'C:\\Windows',
    } as NodeJS.ProcessEnv;

    const stripped = stripProxyEnv(original, ['HTTP_PROXY', 'HTTPS_PROXY']);

    expect(stripped.HTTP_PROXY).toBeUndefined();
    expect(stripped.HTTPS_PROXY).toBeUndefined();
    expect(stripped.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(stripped.PATH).toBe('C:\\Windows');
    expect(original.HTTP_PROXY).toBe('http://127.0.0.1:7990');
  });

  it('dshEnv 只从返回的 env 里剔除，进程环境不受影响', async () => {
    const localAppData = await mkdtemp(join(tmpdir(), 'dda-proxy-'));
    const paths = appPaths(localAppData);
    const before = process.env.HTTP_PROXY;

    const env = dshEnv(
      {
        paths,
        pnpmBinDir: join(paths.root, 'bin'),
        registry: 'https://registry.npmmirror.com/',
        proxyExclusions: ['HTTP_PROXY', 'HTTPS_PROXY'],
      },
      {},
    );

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe(process.env.NO_PROXY);
    expect(process.env.HTTP_PROXY).toBe(before);
  });

  it('未给剔除清单时行为不变（保留原样透传）', async () => {
    const localAppData = await mkdtemp(join(tmpdir(), 'dda-proxy-'));
    const paths = appPaths(localAppData);
    const env = dshEnv({ paths, pnpmBinDir: join(paths.root, 'bin'), registry: 'https://registry.npmjs.org/' });
    expect(env.HTTP_PROXY).toBe(process.env.HTTP_PROXY);
  });
});

describe('参数安全：git spec 的 & 是 pnpm 分隔符，不是 shell 元字符', () => {
  it('git+https spec 允许 &path:', () => {
    expect(() =>
      assertArgsSafe(['plugin', '--profile', 'web', 'add', `git+https://github.com/a/b.git#${'a'.repeat(40)}&path:/pkg`]),
    ).not.toThrow();
  });

  it('git spec 里的真正 shell 元字符仍被拒绝', () => {
    expect(() => assertArgsSafe([`git+https://github.com/a/b.git#${'a'.repeat(40)}|whoami`])).toThrowError(/metacharacter/);
  });

  it('普通参数里的 & 依旧拒绝（防御性保留）', () => {
    expect(() => assertArgsSafe(['pkg@1.0.0 && echo pwned'])).toThrowError(/metacharacter/);
  });
});
