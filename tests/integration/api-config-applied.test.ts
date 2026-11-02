import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { applyManagedBlock, removeManagedBlock, verifyComposedConfig, type ApiProviderConfig } from '@dda/core';

const run = promisify(execFile);

/**
 * Real-Harness verification of the M3.1 write path (CFG-2):
 *  - `--dump-config` proves the composed tree contains exactly the route/model we wrote;
 *  - `headless` (with an unreachable endpoint) proves the credential seam really resolves the
 *    environment variable we would inject at launch — no plaintext credential file involved.
 *
 * Env-gated because it needs an installed Harness:
 *   DDA_DSH_BIN=<...>/node_modules/@deepseek-ai/dsh/lib/bin.js
 */
const DSH_BIN = process.env.DDA_DSH_BIN;
const ENABLED = Boolean(DSH_BIN);

const KEY_REF = 'LAB_GATEWAY_API_KEY';
const config: ApiProviderConfig = {
  template: 'openai-compatible',
  label: 'Lab Gateway',
  protocol: 'openai-completions',
  baseUrl: 'http://127.0.0.1:9/v1',
  model: 'lab-model-a',
  credentialRef: KEY_REF,
  contextWindow: 131072,
};

async function dumpConfig(dshHome: string): Promise<string> {
  const { stdout } = await run(process.execPath, [DSH_BIN!, '--profile', 'web', '--dump-config'], {
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function headless(dshHome: string, overlay: string, apiKey?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dshHome };
  if (apiKey) env[KEY_REF] = apiKey;
  else delete env[KEY_REF];
  try {
    const { stdout, stderr } = await run(process.execPath, [DSH_BIN!, 'headless', '--patch', overlay, 'reply with OK'], {
      env,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
  }
}

describe.skipIf(!ENABLED)('Harness 实际识别 M3.1 写入的配置（DDA_DSH_BIN）', () => {
  it('dump-config 认可写入的路由；密钥经启动环境注入后 Harness 能真正使用', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dda-m31-'));
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    const patchPath = join(profileDir, 'cordis.patch.yml');
    await writeFile(patchPath, '# shipped default\n[]\n', 'utf8');

    const patched = applyManagedBlock(await readFile(patchPath, 'utf8'), config);
    await writeFile(patchPath, patched, 'utf8');
    expect(await readFile(patchPath, 'utf8')).toContain('# shipped default');

    const dump = await dumpConfig(home);
    const verified = verifyComposedConfig(dump, {
      provider: 'dda-custom',
      model: config.model,
      baseUrl: config.baseUrl,
      apiKeyEnv: KEY_REF,
    });
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);
    expect(verified.method).toBe('structured');

    const overlay = join(home, 'overlay.yml');
    await writeFile(overlay, applyManagedBlock('[]\n', config), 'utf8');

    const withoutKey = await headless(home, overlay);
    expect(withoutKey).toMatch(/MISSING_CREDENTIAL/);

    const withKey = await headless(home, overlay, 'sk-lab-fake-key-for-seam-check');
    expect(withKey).not.toMatch(/MISSING_CREDENTIAL/);
    expect(withKey).toMatch(/TRANSPORT|ECONNREFUSED|Connection error/i);

    const cleaned = removeManagedBlock(await readFile(patchPath, 'utf8'));
    await writeFile(patchPath, cleaned, 'utf8');
    const restored = await dumpConfig(home);
    expect(restored).not.toContain('dda-custom');
    expect(restored).toContain('provider: deepseek-official');
  }, 600_000);
});