import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildDiagnosticSections, previewLines, sanitize } from '@dda/core';

const home = 'C:\\Users\\zhangsan';

describe('诊断报告脱敏', () => {
  it('抹掉 API Key / QQ Token / appId / 用户目录 / 长数字', () => {
    const input = [
      'key=sk-abcdef1234567890',
      'QQBOT_SECRET=zzzzzzzzzzzz',
      'appSecret: abcdef1234567890',
      'url=http://127.0.0.1:3080/?token=JqObWoCuEaIZSgNXxe5KfsTh_KuDSeZRmrhPwNnDT7Y',
      'appId: 1234567890',
      'path=C:\\Users\\zhangsan\\AppData\\Local\\DeepSeekDeployAssistant\\logs',
    ].join('\n');

    const out = sanitize(input, home);
    expect(out).not.toContain('sk-abcdef1234567890');
    expect(out).not.toContain('zzzzzzzzzzzz');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).not.toContain('JqObWoCuEaIZSgNXxe5KfsTh');
    expect(out).not.toContain('1234567890');
    expect(out).not.toContain('zhangsan');
    expect(out).toContain('<redacted>');
    expect(out).toContain('<user>');
  });

  it('普通文本不被破坏', () => {
    expect(sanitize('dsh 0.2.0-rc.2 started in 1234ms', home)).toBe('dsh 0.2.0-rc.2 started in 1234ms');
  });
});

describe('诊断报告内容', () => {
  it('包含 PRD 要求的 7 类信息，且预览与内容一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-diag-'));
    const logFile = join(dir, 'app.log');
    await writeFile(logFile, '2026-11-02 INFO [deploy] download-node ok\nkey=sk-secretsecret123\n', 'utf8');
    const profileDir = join(dir, 'profiles', 'web');
    await writeFile(join(dir, 'placeholder'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'package.json'), '{}');

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
    expect(byName['03-profile.txt']).toContain('package.json');
    expect(byName['04-plugins.json']).toContain('dsh-qqbot');
    expect(byName['05-task.json']).toContain('succeeded');
    expect(byName['06-network.txt']).toContain('npm-mirror');
    expect(byName['07-logs.txt']).toContain('download-node ok');
    // Secrets must not survive into any section.
    for (const section of sections) {
      expect(section.content).not.toContain('sk-secretsecret123');
    }

    const preview = previewLines(sections);
    expect(preview).toHaveLength(7);
    expect(preview[0]).toContain('01-system.txt');
  });
});
