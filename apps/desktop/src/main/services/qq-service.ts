import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  applyQqSection,
  checkQqVersion,
  deriveQqStatus,
  findQqPlugin,
  readQqEntry,
  readQqSettings,
  readStoredCredentials,
  QQ_APPID_ENV,
  QQ_PLUGIN_NAME,
  QQ_SECRET_ENV,
} from '@dda/core';
import { dshBinJs, fileExists, nodeExe, runCommand } from '@dda/adapters';
import {
  BASELINE,
  DEFAULT_QQ_SETTINGS,
  QQ_BINDING_TIMEOUT_MS,
  type QqCredentialMode,
  type QqSaveResult,
  type QqSettings,
  type QqStatus,
} from '@dda/spec';

import type { Container } from './container';
import type { Secrets } from '../security/secrets';
import type { HarnessService } from './harness-service';

const APPID_KEY = 'qq.appId';
const SECRET_KEY = 'qq.appSecret';

/**
 * QQ 官方机器人接入（M3.2）。
 *
 * 授权方式与安全模型：
 *  - 方式 A（推荐）：AppID/AppSecret 只以 DPAPI 密文落盘，启动 `dsh` 时作为 `QQBOT_APPID` /
 *    `QQBOT_SECRET` 注入；profile 的 patch 里只写 `__FROM_ENV__` 占位符。
 *  - 方式 B：官方扫码（插件自己调用 q.qq.com 授权页）。插件成功后会把凭据写进 profile 的
 *    `cordis.patch.yml`（**插件自身行为，明文**）。产品必须在界面上如实披露，并提供
 *    「迁移到加密存储」把明文搬到 DPAPI 再清掉。
 */
export interface QqServiceDeps {
  /** 回读校验实现（默认真的跑 `dsh --dump-config`；测试里可注入）。 */
  verify?: (settings: QqSettings, mode: QqCredentialMode) => Promise<string[]>;
}

export class QqService {
  /** `dsh plugin list` spawns a process (~1-2s); status polling must not do that every tick. */
  private pluginCache?: { at: number; plugins: Awaited<ReturnType<HarnessService['listPlugins']>> };
  /**
   * 扫码模式（用户点"官方扫码绑定"后进入）：
   * - 子进程环境里把 `QQBOT_APPID` / `QQBOT_SECRET` 显式置空，插件的 `resolveEnv` 拿到空值 → 走官方扫码；
   * - **不删除 DPAPI 里已保存的凭据**（决策：不能影响已验证成功的 AppID/AppSecret 路径），
   *   取消扫码或重新保存即立即恢复；
   * - 同时打开插件自带的官方降级通道 `QQBOT_BIND_OPEN_BROWSER=1`，让浏览器自动打开授权页。
   */
  private binding?: { startedAt: string; attempts: number };
  private bindingMode = false;

  constructor(
    private readonly container: Container,
    private readonly secrets: Secrets,
    private readonly harness: HarnessService,
    private readonly deps: QqServiceDeps = {},
  ) {}

  private get paths() {
    return this.container.paths;
  }

  private get patchPath(): string {
    return join(this.paths.dshHome, 'profiles', BASELINE.dsh.profile, 'cordis.patch.yml');
  }

  private get harnessBin(): string {
    return dshBinJs(this.paths);
  }

  /** 环境变量注入：扫码模式显式置空（触发官方扫码），否则注入 DPAPI 里的凭据。 */
  async launchEnv(): Promise<Record<string, string>> {
    if (this.bindingMode) {
      return { [QQ_APPID_ENV]: '', [QQ_SECRET_ENV]: '', QQBOT_BIND_OPEN_BROWSER: '1' };
    }
    const appId = await this.secrets.get(APPID_KEY);
    const appSecret = await this.secrets.get(SECRET_KEY);
    if (!appId || !appSecret) return {};
    return { [QQ_APPID_ENV]: appId, [QQ_SECRET_ENV]: appSecret };
  }

  async status(options: { refreshPlugins?: boolean } = {}): Promise<QqStatus> {
    const harnessInstalled = await fileExists(this.harnessBin);
    const plugins = harnessInstalled ? await this.plugins(options.refreshPlugins === true) : [];
    const plugin = findQqPlugin(plugins);
    const versionCheck = checkQqVersion(plugin?.version, BASELINE.qqbot.version);

    const patch = await this.readPatch();
    const stored = readStoredCredentials(patch);
    const dpapiAppId = await this.secrets.get(APPID_KEY);
    const dpapiSecret = await this.secrets.get(SECRET_KEY);

    const credentialSource = dpapiAppId && dpapiSecret ? 'dpapi' : stored.plaintext ? 'profile' : 'none';

    return deriveQqStatus({
      harnessInstalled,
      harnessRunning: this.harness.running,
      pluginInstalled: Boolean(plugin?.installed),
      pluginVersion: versionCheck.found,
      expectedVersion: BASELINE.qqbot.version,
      // 扫码模式下子进程环境被显式置空：对运行中的 Harness 而言就是"没有凭据"。
      credentialSource: this.bindingMode ? 'none' : credentialSource,
      appId: credentialSource === 'dpapi' && !this.bindingMode ? dpapiAppId : stored.appId,
      events: this.harness.pluginEvents,
      startedAt: this.harness.startedAt,
      bindingStartedAt: this.binding?.startedAt,
      bindingAttempts: this.binding?.attempts,
      bindingTimeoutMs: QQ_BINDING_TIMEOUT_MS,
      bindQr: this.harness.qrArt?.() ?? [],
    });
  }

  /** 非机密视图：设置表单初值 + 凭据来源 + 明文风险提示。 */
  async settings(): Promise<{
    settings: QqSettings;
    mode: QqCredentialMode;
    credentialSource: 'none' | 'dpapi' | 'profile';
    appId?: string;
    appSecretMask?: string;
    plaintextInProfile: boolean;
    bindingMode: boolean;
    outputTail: string[];
  }> {
    const patch = await this.readPatch();
    const stored = readStoredCredentials(patch);
    const dpapiAppId = await this.secrets.get(APPID_KEY);
    const dpapiSecret = await this.secrets.get(SECRET_KEY);
    const credentialSource = dpapiAppId && dpapiSecret ? 'dpapi' : stored.plaintext ? 'profile' : 'none';
    return {
      settings: readQqSettings(patch),
      mode: this.bindingMode || credentialSource === 'profile' ? 'qr' : 'env',
      credentialSource,
      appId: dpapiAppId ?? stored.appId,
      appSecretMask: dpapiSecret ? maskSecret(dpapiSecret) : stored.appSecret ? maskSecret(stored.appSecret) : undefined,
      plaintextInProfile: stored.plaintext,
      bindingMode: this.bindingMode,
      outputTail: this.harness.outputTail(15),
    };
  }

  /** 方式 A：保存 AppID/AppSecret（DPAPI）并写 `__FROM_ENV__` 占位块。 */
  async saveCredentials(input: { appId: string; appSecret: string }): Promise<QqSaveResult> {
    const appId = input.appId.trim();
    const appSecret = input.appSecret.trim();
    if (!appId || !appSecret) {
      return { ok: false, message: 'AppID 与 AppSecret 都必须填写', problems: ['缺少凭据'] };
    }

    const patch = await this.readPatch();
    const settings = readQqSettings(patch);
    const backup = await this.backup(this.patchPath);
    try {
      this.bindingMode = false;
      this.binding = undefined;
      await this.secrets.set(APPID_KEY, appId);
      await this.secrets.set(SECRET_KEY, appSecret);
      await this.writePatch(applyQqSection(patch, settings, { mode: 'env' }));
      const problems = await this.verify(settings, 'env');
      if (problems.length > 0) {
        await this.restore(backup, this.patchPath);
        await this.secrets.remove(APPID_KEY);
        await this.secrets.remove(SECRET_KEY);
        return { ok: false, message: 'Harness 没有接受这份 QQ 配置，已回滚', problems };
      }
      const restarted = await this.restartIfRunning();
      await this.container.logger.info('qq', `credentials saved (dpapi), restarted=${restarted}`);
      return {
        ok: true,
        message: restarted
          ? '凭据已加密保存，Harness 已重启并在注入凭据后连接 QQ'
          : '凭据已加密保存；启动 Harness 时会自动注入',
        problems: [],
        restarted,
        status: await this.status(),
      };
    } catch (error) {
      await this.restore(backup, this.patchPath);
      const message = error instanceof Error ? error.message : String(error);
      await this.container.logger.error('qq', `credential save failed: ${message}`);
      return { ok: false, message: `保存失败，已回滚：${message}`, problems: [message] };
    }
  }

  /** 解绑：清除 DPAPI 凭据，并让插件回到"未授权"（扫码）状态。 */
  async deleteCredentials(): Promise<QqSaveResult> {
    const patch = await this.readPatch();
    const settings = readQqSettings(patch);
    const backup = await this.backup(this.patchPath);
    try {
      this.bindingMode = false;
      this.binding = undefined;
      await this.secrets.remove(APPID_KEY);
      await this.secrets.remove(SECRET_KEY);
      await this.writePatch(applyQqSection(patch, settings, { mode: 'qr' }));
      const restarted = await this.restartIfRunning();
      await this.container.logger.info('qq', `credentials removed, restarted=${restarted}`);
      return {
        ok: true,
        message: restarted ? '已解绑，Harness 已重启并回到未授权状态' : '已解绑；下次启动 Harness 时生效',
        problems: [],
        restarted,
        status: await this.status(),
      };
    } catch (error) {
      await this.restore(backup, this.patchPath);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `解绑失败，已回滚：${message}`, problems: [message] };
    }
  }

  /**
   * 方式 B 的善后（决策 D2）：把插件扫码后写入 profile 的明文凭据搬进 DPAPI 并清掉明文。
   */
  async migrateToDpapi(): Promise<QqSaveResult> {
    const patch = await this.readPatch();
    const stored = readStoredCredentials(patch);
    if (!stored.appId || !stored.appSecret) {
      return { ok: false, message: '没有找到插件写入的明文凭据（可能还没扫码完成）', problems: ['无可迁移凭据'] };
    }
    const settings = readQqSettings(patch);
    const backup = await this.backup(this.patchPath);
    try {
      this.bindingMode = false;
      this.binding = undefined;
      await this.secrets.set(APPID_KEY, stored.appId);
      await this.secrets.set(SECRET_KEY, stored.appSecret);
      await this.writePatch(applyQqSection(patch, settings, { mode: 'env' }));
      const problems = await this.verify(settings, 'env');
      if (problems.length > 0) {
        await this.restore(backup, this.patchPath);
        return { ok: false, message: '迁移后回读校验失败，已回滚', problems };
      }
      const restarted = await this.restartIfRunning();
      await this.container.logger.info('qq', `credentials migrated to dpapi, restarted=${restarted}`);
      return {
        ok: true,
        message: restarted
          ? '已把明文凭据迁移到加密存储，Harness 已重启'
          : '已把明文凭据迁移到加密存储；下次启动 Harness 时生效',
        problems: [],
        restarted,
        status: await this.status(),
      };
    } catch (error) {
      await this.restore(backup, this.patchPath);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `迁移失败，已回滚：${message}`, problems: [message] };
    }
  }

  async saveSettings(input: { settings: QqSettings; mode: QqCredentialMode }): Promise<QqSaveResult> {
    const patch = await this.readPatch();
    const stored = readStoredCredentials(patch);
    const backup = await this.backup(this.patchPath);
    try {
      const next = applyQqSection(patch, input.settings, {
        mode: input.mode,
        preserved: { appId: stored.appId, appSecret: stored.appSecret },
      });
      await this.writePatch(next);
      const problems = await this.verify(input.settings, input.mode);
      if (problems.length > 0) {
        await this.restore(backup, this.patchPath);
        return { ok: false, message: 'Harness 没有接受这份消息配置，已回滚', problems };
      }
      // 只有切换到"环境注入"模式才必须重启（凭据要在进程启动环境里）。
      const restarted = input.mode === 'env' ? await this.restartIfRunning() : false;
      await this.container.logger.info('qq', `settings saved (mode=${input.mode}), restarted=${restarted}`);
      return {
        ok: true,
        message: restarted ? '消息配置已保存，Harness 已重启' : '消息配置已保存并触发 Harness 热重载',
        problems: [],
        restarted,
        status: await this.status(),
      };
    } catch (error) {
      await this.restore(backup, this.patchPath);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `保存失败，已回滚：${message}`, problems: [message] };
    }
  }

  /**
   * 官方扫码：让插件进入"没有凭据"的分支并打印官方二维码（同时打开官方授权页）。
   *
   * **不删除 DPAPI 里的 AppID/AppSecret**：只是把子进程环境里的这两个值置空。
   * 已通过 AppID/AppSecret 验证成功的用户，点一下"取消扫码"或重新"保存并应用"即可回到原路径。
   */
  async startBinding(options: { regenerate?: boolean } = {}): Promise<QqSaveResult> {
    const patch = await this.readPatch();
    const settings = readQqSettings(patch);
    const stored = readStoredCredentials(patch);
    const backup = await this.backup(this.patchPath);
    try {
      // patch 里不能留字面量凭据，否则插件会继续用它们而不再走扫码。
      await this.writePatch(
        applyQqSection(patch, settings, {
          mode: 'qr',
          preserved: options.regenerate ? undefined : { appId: stored.appId, appSecret: stored.appSecret },
        }),
      );
      this.bindingMode = true;
      this.binding = {
        startedAt: new Date().toISOString(),
        attempts: (this.binding?.attempts ?? 0) + 1,
      };
      const restarted = await this.restartOrLaunch();
      await this.container.logger.info(
        'qq',
        `binding started (official QR flow) attempt=${this.binding.attempts} restarted=${restarted}`,
      );
      return {
        ok: true,
        message: options.regenerate
          ? '已重新向 QQ 官方申请二维码，请稍候'
          : '已启动官方扫码流程：浏览器会自动打开官方授权页，二维码也会显示在下方',
        problems: [],
        restarted,
        status: await this.status(),
      };
    } catch (error) {
      this.bindingMode = false;
      this.binding = undefined;
      await this.restore(backup, this.patchPath);
      const message = error instanceof Error ? error.message : String(error);
      await this.container.logger.error('qq', `binding start failed: ${message}`);
      return { ok: false, message: `启动扫码失败：${message}`, problems: [message] };
    }
  }

  /** 取消扫码：回到"用 DPAPI 凭据启动"的正常路径（不影响已保存的凭据）。 */
  async cancelBinding(): Promise<QqSaveResult> {
    const patch = await this.readPatch();
    const settings = readQqSettings(patch);
    const appId = await this.secrets.get(APPID_KEY);
    const appSecret = await this.secrets.get(SECRET_KEY);
    this.bindingMode = false;
    this.binding = undefined;
    try {
      await this.writePatch(
        appId && appSecret
          ? applyQqSection(patch, settings, { mode: 'env' })
          : applyQqSection(patch, settings, { mode: 'qr', preserved: readStoredCredentials(patch) }),
      );
      const restarted = await this.restartIfRunning();
      await this.container.logger.info('qq', `binding cancelled, restarted=${restarted}`);
      return {
        ok: true,
        message: restarted
          ? '已取消扫码，Harness 已按原有凭据重启'
          : '已取消扫码；下次启动 Harness 时按原有凭据运行',
        problems: [],
        restarted,
        status: await this.status(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `取消失败：${message}`, problems: [message] };
    }
  }

  /** 安装 / 修复插件到验证过的精确版本。 */
  async repairPlugin(): Promise<QqSaveResult> {
    try {
      await this.harness.installQqPlugin();
      const plugins = await this.harness.listPlugins();
      const version = checkQqVersion(findQqPlugin(plugins)?.version, BASELINE.qqbot.version);
      if (version.state !== 'ok') {
        return { ok: false, message: `安装后版本仍不符合预期：${version.message}`, problems: [version.message] };
      }
      return { ok: true, message: `插件已就绪（${version.found}）`, problems: [], status: await this.status() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.container.logger.error('qq', `plugin install failed: ${message}`);
      return {
        ok: false,
        message: `安装失败：${message}`,
        problems: [message, '若提示网络错误，请检查网络或代理；该插件只能在线安装（其依赖 qqbot-connector 为 UNLICENSED，不能打包分发）'],
      };
    }
  }

  /** 用 `--dump-config` 回读组合结果，确认 im-qqbot 条目真的带上了我们写的值。 */
  async verify(settings: QqSettings, mode: QqCredentialMode): Promise<string[]> {
    if (this.deps.verify) return this.deps.verify(settings, mode);
    if (!(await fileExists(this.harnessBin)) || !(await fileExists(nodeExe(this.paths)))) return [];
    let stdout: string;
    try {
      const result = await runCommand({
        exePath: nodeExe(this.paths),
        args: [this.harnessBin, '--profile', BASELINE.dsh.profile, '--dump-config'],
        env: { ...process.env, DSH_HOME: this.paths.dshHome },
        timeoutMs: 120_000,
      });
      stdout = result.stdout;
    } catch (error) {
      return [`读取 Harness 配置失败：${error instanceof Error ? error.message : String(error)}`];
    }

    const problems: string[] = [];
    const entry = readQqEntry(stdout);
    if (!entry.present) {
      problems.push(`组合配置里没有 ${QQ_PLUGIN_NAME} 的条目（插件可能未安装）`);
      return problems;
    }
    const actual = readQqSettings(stdout);
    const expected = { ...DEFAULT_QQ_SETTINGS, ...settings };
    if (actual.requireMention !== expected.requireMention) problems.push('requireMention 未生效');
    if (actual.textChunkLimit !== expected.textChunkLimit) problems.push('textChunkLimit 未生效');
    if (actual.historyLimit !== expected.historyLimit) problems.push('historyLimit 未生效');
    if (actual.streaming !== expected.streaming) problems.push('streaming 未生效');
    if (actual.access.c2cMode !== expected.access.c2cMode) problems.push('access.c2cMode 未生效');
    if (actual.access.groupMode !== expected.access.groupMode) problems.push('access.groupMode 未生效');
    if (actual.mediaEnabled !== expected.mediaEnabled) problems.push('media.enabled 未生效');
    if (mode === 'env') {
      const config = entry.config;
      if (config.appId !== '__FROM_ENV__') problems.push('appId 未写成环境变量占位符');
      if (config.appSecret !== '__FROM_ENV__') problems.push('appSecret 未写成环境变量占位符');
    }
    return problems;
  }

  private async plugins(refresh: boolean): Promise<Awaited<ReturnType<HarnessService['listPlugins']>>> {
    const now = Date.now();
    if (!refresh && this.pluginCache && now - this.pluginCache.at < 60_000) return this.pluginCache.plugins;
    try {
      const plugins = await this.harness.listPlugins();
      this.pluginCache = { at: now, plugins };
      return plugins;
    } catch {
      // 未部署/命令失败时保留上一次结果，避免状态抖动成"未安装"。
      return this.pluginCache?.plugins ?? [];
    }
  }

  private async readPatch(): Promise<string> {
    if (!(await fileExists(this.patchPath))) return '[]\n';
    return readFile(this.patchPath, 'utf8');
  }

  private async writePatch(text: string): Promise<void> {
    await mkdir(join(this.paths.dshHome, 'profiles', BASELINE.dsh.profile), { recursive: true });
    await writeFile(this.patchPath, text, 'utf8');
  }

  private async restartIfRunning(): Promise<boolean> {
    if (!this.harness.running) return false;
    await this.harness.restart();
    return true;
  }

  /** 保存/切换凭据需要"重启或在运行时启动"，两者都要让新环境生效。 */
  private async restartOrLaunch(): Promise<boolean> {
    if (this.harness.running) {
      await this.harness.restart();
      return true;
    }
    await this.harness.launch(0);
    return true;
  }

  private async backup(path: string): Promise<string | undefined> {
    if (!(await fileExists(path))) return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${path}.dda-backup-${stamp}`;
    await copyFile(path, backupPath);
    return backupPath;
  }

  private async restore(backupPath: string | undefined, target: string): Promise<void> {
    if (backupPath) {
      await copyFile(backupPath, target);
      return;
    }
    await rm(target, { force: true });
  }
}

function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
