import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildDiagnosticSections, buildZip, previewLines, sanitize } from '@dda/core';

const home = 'C:\\Users\\zhangsan';

describe('sanitize：用户目录与用户名', () => {
  it('homeDir 为空时不得破坏正文（replaceAll("") 会把占位符插进每个字符之间）', () => {
    const text = 'Node.js: 22.23.4\nProfile: C:\\Users\\zhangsan\\x (存在)';
    const out = sanitize(text, '');
    expect(out).toBe(text);
    expect(out).not.toContain('<user><');
  });

  it('homeDir 只有 1-2 个字符时同样跳过路径替换', () => {
    expect(sanitize('ab', 'C:')).toBe('ab');
    expect(sanitize('keep this', '')).toBe('keep this');
  });

  it('反斜杠、正斜杠、结尾斜杠三种 homeDir 写法都能替换', () => {
    const text = 'a=C:\\Users\\zhangsan\\AppData b=C:/Users/zhangsan/AppData c=C:\\Users\\zhangsan\\';
    for (const variant of ['C:\\Users\\zhangsan', 'C:\\Users\\zhangsan\\', 'C:/Users/zhangsan', 'C:\\Users\\zhangsan/']) {
      const out = sanitize(text, variant);
      expect(out).not.toContain('zhangsan');
      expect(out).toContain('<user>');
    }
  });

  it('JSON 中被二次转义的用户目录也要替换', () => {
    const json = JSON.stringify({ pluginsPath: 'C:\\Users\\zhangsan\\.dsh' });
    const out = sanitize(json, 'C:\\Users\\zhangsan');
    expect(out).not.toContain('zhangsan');
    expect(out).toContain('<user>');
  });
});

describe('sanitize：凭据覆盖', () => {
  const cases: [string, string][] = [
    ['sk- 前缀密钥', 'key=sk-abcdef1234567890'],
    ['环境变量式 API Key', 'DEEPSEEK_API_KEY=abc123def456ghi789'],
    ['下划线风格', 'api_key: abcdef1234567890'],
    ['camelCase', 'apiKey=abcdef1234567890'],
    ['QQ 机器人 secret（大写环境变量）', 'QQBOT_SECRET=zzzzzzzzzzzzzzzz'],
    ['appSecret 冒号式', 'appSecret: abcdef1234567890'],
    ['appSecret 等号式', 'AppSecret=abcdef1234567890'],
    ['appSecret JSON', '{"appSecret":"abcdef1234567890"}'],
    ['URL 查询串 token', 'http://127.0.0.1:3080/?token=JqObWoCuEaIZSgNXxe5KfsTh_KuDSeZRmrhPwNnDT7Y'],
    ['裸 token 赋值', 'token=abcdef1234567890'],
    ['password', 'password=hunter2hunter2'],
    ['Authorization 头', 'Authorization: Bearer abcdef1234567890abcdef'],
    ['openid', 'openid=ABCDEF1234567890abcdef1234567890'],
  ];

  for (const [label, sample] of cases) {
    it(`脱敏：${label}`, () => {
      const out = sanitize(sample, home);
      expect(out).not.toMatch(/abcdef1234567890|zzzzzzzzzzzzzzzz|JqObWoCuEaIZSgNX|hunter2|ABCDEF1234567890/);
      expect(out).not.toContain('sk-abcdef1234567890');
    });
  }

  it('appId / QQ 号（5-8 位）也会被替换', () => {
    const out = sanitize(
      ['appId: 1234567890', 'app_id=1234567', 'qq=12345', 'QQ 12345678', 'uin: 123456789', 'user_id: 987654'].join('\n'),
      home,
    );
    expect(out).not.toContain('1234567890');
    expect(out).not.toContain('1234567');
    expect(out).not.toContain('12345');
    expect(out).not.toContain('12345678');
    expect(out).not.toContain('123456789');
    expect(out).not.toContain('987654');
  });

  it('普通诊断信息不被误伤', () => {
    const text = [
      'dsh 0.2.0-rc.2 started in 1234ms',
      'HTTP 200 status=200 12ms',
      'port=51270',
      'monkey=banana',
      'hotkey=Ctrl+C',
      'keyboard: on',
    ].join('\n');
    expect(sanitize(text, home)).toBe(text);
  });
});

describe('诊断报告内容', () => {
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'dda-diag-'));
    const logFile = join(dir, 'app.log');
    await writeFile(logFile, '2026-11-02 INFO [deploy] download-node ok\nkey=sk-secretsecret123\n', 'utf8');
    const profileDir = join(dir, 'profiles', 'web');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(profileDir, { recursive: true });
    // A profile file that *does* contain a credential: it must never be copied into the report.
    await writeFile(join(profileDir, 'config.json'), '{"apiKey":"sk-profileOnlySecret999"}');
    return { dir, logFile, profileDir };
  }

  it('包含 PRD 要求的 7 类信息，且预览与内容一致', async () => {
    const { logFile, profileDir } = await fixture();
    const sections = await buildDiagnosticSections({
      generatedAt: '2026-11-02T00:00:00.000Z',
      appVersion: '0.2.0',
      os: { caption: 'Windows 10', arch: 'x64', admin: false },
      runtime: { node: '22.23.4', pnpm: '11.28.5', dsh: '0.2.0-rc.2', profile: profileDir, profileExists: true },
      plugins: [{ name: '@tencent-connect/dsh-qqbot', version: '0.5.5', installed: true }],
      task: { taskId: 'full-deploy', status: 'succeeded', steps: [], startedAt: '2026-11-02T00:00:00.000Z' },
      network: {
        generatedAt: '2026-11-02T00:00:00.000Z',
        items: [{ target: 'npm-mirror', url: 'https://registry.npmmirror.com/-/ping', ok: true, status: 200, millis: 12 }],
      },
      logFiles: [logFile],
      homeDir: home,
      dataDir: join(home, 'AppData', 'Local', 'DeepSeekDeployAssistant'),
    });

    const names = sections.map((s) => s.name);
    expect(names).toEqual([
      '01-system.txt',
      '02-runtime.txt',
      '03-profile.txt',
      '04-plugins.json',
      '05-task.json',
      '06-network.txt',
      '07-logs.txt',
    ]);

    const byName = Object.fromEntries(sections.map((s) => [s.name, s.content]));
    expect(byName['02-runtime.txt']).toContain('0.2.0-rc.2');
    expect(byName['03-profile.txt']).toContain('config.json');
    expect(byName['04-plugins.json']).toContain('dsh-qqbot');
    expect(byName['05-task.json']).toContain('succeeded');
    expect(byName['06-network.txt']).toContain('npm-mirror');
    expect(byName['07-logs.txt']).toContain('download-node ok');

    const preview = previewLines(sections);
    expect(preview).toHaveLength(7);
    expect(preview[0]).toContain('01-system.txt');
    for (const line of preview) expect(line).toMatch(/— .+（\d+ 字节）/);
  });

  it('Profile 段只列目录结构，绝不包含文件内容', async () => {
    const { logFile, profileDir } = await fixture();
    const sections = await buildDiagnosticSections({
      generatedAt: '2026-11-02T00:00:00.000Z',
      appVersion: '0.2.0',
      os: { caption: 'Windows 10', arch: 'x64', admin: false },
      runtime: { profile: profileDir, profileExists: true },
      plugins: [],
      network: { generatedAt: '2026-11-02T00:00:00.000Z', items: [] },
      logFiles: [logFile],
      homeDir: home,
      dataDir: join(home, 'AppData', 'Local', 'DeepSeekDeployAssistant'),
    });
    const profile = sections.find((s) => s.name === '03-profile.txt')!;
    expect(profile.content).not.toContain('sk-profileOnlySecret999');
    expect(profile.content).not.toContain('apiKey');
    expect(profile.content).toContain('config.json');
  });

  it('任何一段都不携带凭据（含日志段、task 错误、network 错误）', async () => {
    const { logFile, profileDir } = await fixture();
    const sections = await buildDiagnosticSections({
      generatedAt: '2026-11-02T00:00:00.000Z',
      appVersion: '0.2.0',
      os: { caption: 'Windows 10', arch: 'x64', admin: false },
      runtime: { node: '22.23.4', profile: profileDir, profileExists: true },
      plugins: [{ name: 'p', version: '1.0.0', installed: true }],
      task: {
        taskId: 't',
        status: 'failed',
        steps: [],
        startedAt: '2026-11-02T00:00:00.000Z',
        error: 'apiKey=abcdef1234567890',
      },
      network: {
        generatedAt: '2026-11-02T00:00:00.000Z',
        items: [
          {
            target: 'npm',
            url: 'https://r/?token=abcdef1234567890',
            ok: false,
            error: 'HTTP 401 for https://r/?token=abcdef1234567890',
          },
        ],
      },
      logFiles: [logFile],
      homeDir: home,
      dataDir: join(home, 'AppData', 'Local', 'DeepSeekDeployAssistant'),
    });
    for (const section of sections) {
      expect(section.content).not.toContain('sk-secretsecret123');
      expect(section.content).not.toContain('abcdef1234567890');
      expect(section.content).not.toContain('sk-profileOnlySecret999');
      expect(section.content).not.toContain('zhangsan');
    }
  });

  it('写出的 ZIP 字节里不含任何凭据', async () => {
    const { logFile, profileDir } = await fixture();
    const sections = await buildDiagnosticSections({
      generatedAt: '2026-11-02T00:00:00.000Z',
      appVersion: '0.2.0',
      os: { caption: 'Windows 10', arch: 'x64', admin: false },
      runtime: { profile: profileDir, profileExists: true },
      plugins: [],
      network: { generatedAt: '2026-11-02T00:00:00.000Z', items: [] },
      logFiles: [logFile],
      homeDir: home,
      dataDir: join(home, 'AppData', 'Local', 'DeepSeekDeployAssistant'),
    });
    const zip = buildZip(sections.map((s) => ({ name: s.name, content: s.content })));
    const text = zip.toString('utf8');
    expect(text).not.toContain('sk-secretsecret123');
    expect(text).not.toContain('sk-profileOnlySecret999');
    expect(text).not.toContain('zhangsan');
    for (const section of sections) expect(text).toContain(section.name);
  });

  it('homeDir 缺失时仍能生成完整 7 段（不抛异常、不被占位符淹没）', async () => {
    const { logFile, profileDir } = await fixture();
    const sections = await buildDiagnosticSections({
      generatedAt: '2026-11-02T00:00:00.000Z',
      appVersion: '0.2.0',
      os: { caption: 'Windows 10', arch: 'x64', admin: false },
      runtime: { profile: profileDir, profileExists: true },
      plugins: [],
      network: { generatedAt: '2026-11-02T00:00:00.000Z', items: [] },
      logFiles: [logFile],
      homeDir: '',
      dataDir: 'C:\\Users\\zhangsan\\AppData\\Local\\DeepSeekDeployAssistant',
    });
    expect(sections).toHaveLength(7);
    const logs = sections.find((s) => s.name === '07-logs.txt')!;
    expect(logs.content).toContain('download-node ok');
    expect(logs.content).not.toContain('<user><');
    expect(logs.content).toContain('app.log');
  });

  it('日志最多只取前 3 个文件，缺失文件不抛异常', async () => {
    const { dir, profileDir } = await fixture();
    const files: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const p = join(dir, `log-${i}.log`);
      await writeFile(p, `line-${i}\n`);
      files.push(p);
    }
    const sections = await buildDiagnosticSections({
      generatedAt: '2026-11-02T00:00:00.000Z',
      appVersion: '0.2.0',
      os: { caption: 'Windows 10', arch: 'x64', admin: false },
      runtime: { profile: profileDir, profileExists: true },
      plugins: [],
      network: { generatedAt: '2026-11-02T00:00:00.000Z', items: [] },
      logFiles: [...files, join(dir, 'missing.log')],
      homeDir: home,
      dataDir: join(home, 'AppData', 'Local', 'DeepSeekDeployAssistant'),
    });
    const logs = sections.find((s) => s.name === '07-logs.txt')!;
    expect(logs.content).toContain('log-0.log');
    expect(logs.content).toContain('log-2.log');
    expect(logs.content).not.toContain('log-3.log');
    expect(logs.content).not.toContain('missing.log');
  });
});
