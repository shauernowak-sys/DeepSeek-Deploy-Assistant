import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  applyManagedBlock,
  DEEPSEEK_TEMPLATE,
  maskCredential,
  normalizeBaseUrl,
  providerRouteOf,
  removeManagedBlock,
  testConnection,
  validateProviderConfig,
  verifyComposedConfig,
  writeFileAtomic,
  type ApiProviderConfig,
  type ConnectionResult,
  type VerifyResult,
} from '@dda/core';
import { dshBinJs, fileExists, nodeExe, runCommand } from '@dda/adapters';
import { BASELINE } from '@dda/spec';

import type { Container } from './container';
import type { Secrets } from '../security/secrets';

const SECRET_KEY = 'api.credential';
/** How many `.dda-backup-*` files are kept per config file before the oldest are removed. */
const BACKUP_RETENTION = 3;

export interface ApiStatus {
  configured: boolean;
  /** Non-secret provider settings, if the user already saved a configuration. */
  config?: ApiProviderConfig;
  keyMask?: string;
  patchPath: string;
  /** Whether the Harness is installed and its composed config could be read back. */
  harnessInstalled: boolean;
}

export interface SaveResult {
  ok: boolean;
  status?: ApiStatus;
  problems: string[];
  applied?: boolean;
  message: string;
}

export interface TestResult extends ConnectionResult {
  harness?: VerifyResult;
}

/**
 * Owns everything the API page writes.
 *
 * Security model (PRD §11): the key only ever exists as DPAPI ciphertext on disk. The Harness
 * credential seam resolves `apiKeyEnv` from the launch environment first, so we hand the key to
 * `dsh web` as an environment variable instead of writing a plaintext credentials file.
 *
 * Configuration (route/model) is written into the profile's own patch layer — the documented place
 * the Harness settings UI persists changes — after a backup, and is read back with `--dump-config`.
 */
export class ApiService {
  constructor(
    private readonly container: Container,
    private readonly secrets: Secrets,
  ) {}

  private get paths() {
    return this.container.paths;
  }

  private get configPath(): string {
    return join(this.paths.root, 'api-config.json');
  }

  private get patchPath(): string {
    return join(this.paths.dshHome, 'profiles', BASELINE.dsh.profile, 'cordis.patch.yml');
  }

  private get harnessBin(): string {
    return dshBinJs(this.paths);
  }

  async loadConfig(): Promise<ApiProviderConfig | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.configPath, 'utf8')) as ApiProviderConfig;
      return raw && typeof raw === 'object' && 'credentialRef' in raw ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  async status(): Promise<ApiStatus> {
    const config = await this.loadConfig();
    const key = await this.secrets.get(SECRET_KEY);
    return {
      configured: Boolean(config && key),
      config,
      keyMask: key ? maskCredential(key) : undefined,
      patchPath: this.patchPath,
      harnessInstalled: await fileExists(this.harnessBin),
    };
  }

  /** Environment the Harness must see so its credential seam can resolve `apiKeyEnv`. */
  async launchEnv(): Promise<Record<string, string>> {
    const config = await this.loadConfig();
    if (!config) return {};
    const key = await this.secrets.get(SECRET_KEY);
    return key ? { [config.credentialRef]: key } : {};
  }

  validate(config: ApiProviderConfig): string[] {
    return validateProviderConfig({ ...config, baseUrl: normalizeBaseUrl(config.baseUrl) }).map((p) => p.message);
  }

  async test(input: { config: ApiProviderConfig; apiKey?: string }): Promise<TestResult> {
    const problems = this.validate(input.config);
    if (problems.length > 0) {
      return { verdict: 'config', message: problems.join('；'), nextStep: '请先修正页面上的填写项。', millis: 0, steps: [] };
    }
    const key = input.apiKey?.trim() || (await this.secrets.get(SECRET_KEY));
    if (!key) {
      return { verdict: 'config', message: '本机没有保存密钥', nextStep: '请先填写 API Key。', millis: 0, steps: [] };
    }
    const config = { ...input.config, baseUrl: normalizeBaseUrl(input.config.baseUrl) };
    const result = await testConnection(config, key);
    this.container.logger.info(
      'api',
      `connection test ${result.verdict} (${config.protocol}, ${result.millis}ms, http=${result.httpStatus ?? '-'})`,
    );
    if (result.verdict !== 'ok') return result;
    return { ...result, harness: await this.verifyHarness(config) };
  }

  async save(input: { config: ApiProviderConfig; apiKey?: string }): Promise<SaveResult> {
    const config: ApiProviderConfig = { ...input.config, baseUrl: normalizeBaseUrl(input.config.baseUrl) };
    const problems = this.validate(config);
    if (problems.length > 0) return { ok: false, problems, message: problems.join('；') };

    const typedKey = input.apiKey?.trim();
    const storedKey = typedKey || (await this.secrets.get(SECRET_KEY));
    if (!storedKey) return { ok: false, problems: ['缺少 API Key'], message: '请填写 API Key' };

    const patchBackup = await this.backup(this.patchPath);
    const configBackup = await this.backup(this.configPath);

    try {
      await mkdir(join(this.paths.dshHome, 'profiles', BASELINE.dsh.profile), { recursive: true });
      const currentPatch = (await fileExists(this.patchPath)) ? await readFile(this.patchPath, 'utf8') : '[]\n';
      await writeFile(this.patchPath, applyManagedBlock(currentPatch, config), 'utf8');

      if (typedKey || !(await this.secrets.get(SECRET_KEY))) await this.secrets.set(SECRET_KEY, storedKey);
      await writeFileAtomic(this.configPath, JSON.stringify(config, null, 2));

      const harness = await this.verifyHarness(config);
      if (harness && !harness.ok) {
        await this.restore(patchBackup, this.patchPath);
        await this.restore(configBackup, this.configPath);
        return {
          ok: false,
          applied: false,
          problems: harness.problems,
          message: 'Harness 没有接受这份配置，已回滚到写入前的状态',
        };
      }

      await this.container.logger.info(
        'api',
        `provider saved (${config.template}/${config.protocol}), harnessApplied=${harness ? harness.ok : 'not-installed'}`,
      );
      return {
        ok: true,
        applied: harness ? harness.ok : false,
        problems: [],
        status: await this.status(),
        message: harness
          ? '配置已写入 Harness 并通过回读校验'
          : '配置已保存；检测到 Harness 尚未部署，部署后会自动生效',
      };
    } catch (error) {
      await this.restore(patchBackup, this.patchPath);
      await this.restore(configBackup, this.configPath);
      const message = error instanceof Error ? error.message : String(error);
      await this.container.logger.error('api', `provider save failed: ${message}`);
      return { ok: false, problems: [message], message: `保存失败，已回滚：${message}` };
    }
  }

  async remove(): Promise<ApiStatus> {
    if (await fileExists(this.patchPath)) {
      const patch = await readFile(this.patchPath, 'utf8');
      await writeFile(this.patchPath, removeManagedBlock(patch), 'utf8');
    }
    await rm(this.configPath, { force: true });
    await this.secrets.remove(SECRET_KEY);
    await this.container.logger.info('api', 'provider configuration removed');
    return this.status();
  }

  async verifyHarness(config: ApiProviderConfig): Promise<VerifyResult | undefined> {
    if (!(await fileExists(this.harnessBin))) return undefined;
    if (!(await fileExists(nodeExe(this.paths)))) return undefined;
    try {
      const { stdout } = await runCommand({
        exePath: nodeExe(this.paths),
        args: [this.harnessBin, '--profile', BASELINE.dsh.profile, '--dump-config'],
        env: { ...process.env, DSH_HOME: this.paths.dshHome },
        timeoutMs: 120_000,
      });
      return verifyComposedConfig(stdout, {
        provider: providerRouteOf(config),
        model: config.model,
        baseUrl: config.baseUrl,
        apiKeyEnv: config.credentialRef,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, problems: [`读取 Harness 配置失败：${message}`], method: 'textual' };
    }
  }

  private async backup(path: string): Promise<string | undefined> {
    if (!(await fileExists(path))) return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${path}.dda-backup-${stamp}`;
    await copyFile(path, backupPath);
    // Prune only after the new backup exists, so the newest good copy can never be the one removed.
    await this.pruneBackups(path).catch((error: unknown) => {
      void this.container.logger.warn('api', `旧备份清理失败（不影响本次保存）: ${String(error)}`);
    });
    return backupPath;
  }

  /** Keeps the newest `keep` backups of `path`; older ones are removed. Returns removed files. */
  private async pruneBackups(path: string, keep = BACKUP_RETENTION): Promise<string[]> {
    const dir = dirname(path);
    const prefix = `${basename(path)}.dda-backup-`;
    const names = await readdir(dir).catch(() => [] as string[]);
    // Timestamps are ISO-based, so a descending name sort is a descending time sort.
    const backups = names.filter((name) => name.startsWith(prefix)).sort().reverse();
    const removed: string[] = [];
    for (const name of backups.slice(keep)) {
      const full = join(dir, name);
      try {
        await rm(full, { force: true });
        removed.push(full);
      } catch {
        // A backup held open by another process is not worth failing the save over.
      }
    }
    if (removed.length > 0) {
      void this.container.logger.info('api', `清理了 ${removed.length} 份旧配置备份（保留最近 ${keep} 份）`);
    }
    return removed;
  }

  private async restore(backupPath: string | undefined, target: string): Promise<void> {
    if (backupPath) {
      await copyFile(backupPath, target);
      return;
    }
    await rm(target, { force: true });
  }
}

export const DEFAULT_API_CONFIG = DEEPSEEK_TEMPLATE;