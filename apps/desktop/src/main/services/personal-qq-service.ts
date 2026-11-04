import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  composePersonalQqStatus,
  createNodeBridgeDeps,
  createNodeDetectionDeps,
  decideManifestAutomation,
  detectQqnt,
  detectSnowLuma,
  discoverInstallDirs,
  loadSnowLumaManifest,
  postBridgeConfig,
  probeOneBot,
  probeTcp,
  readBridgeState,
  readOneBotEndpoint,
  toBridgeState,
  type BridgeHttpDeps,
  type BridgeReadResult,
  type DetectionDeps,
} from '@dda/core';
import {
  DEFAULT_PERSONAL_QQ_SETTINGS,
  PersonalQqSettingsSchema,
  selectAsset,
  type PersonalQqAdapterState,
  type PersonalQqGuide,
  type PersonalQqSettings,
  type PersonalQqStatus,
  type SnowLumaManifest,
} from '@dda/spec';

import type { Container } from './container';
import type { HarnessService } from './harness-service';

import { PERSONAL_QQ_ADAPTER } from '@dda/spec';

/** 适配插件：只做 OneBot ↔ Harness 的桥接，不含 QQ 协议实现；版本与白名单在 @dda/spec 单一来源。 */
export const ADAPTER_PLUGIN = PERSONAL_QQ_ADAPTER.name;
export const ADAPTER_VERSION = PERSONAL_QQ_ADAPTER.version;

export interface PersonalQqServiceDeps {
  detection?: DetectionDeps;
  bridge?: BridgeHttpDeps;
  manifestsDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface PersonalQqActionResult {
  ok: boolean;
  message: string;
  nextStep?: string;
}

/**
 * 个人 QQ（SnowLuma 路线）的服务层。
 *
 * 边界（本阶段产品决策）：
 *  - **不**下载/解压/安装/启动 SnowLuma，只做只读探测与引导；
 *  - 唯一由本软件代为操作的是 **适配插件** `dsh-qq-link`（官方 `dsh plugin add`）与它的配置；
 *  - SnowLuma 的 `accessToken` 只读、只进内存，绝不回显/落盘/进日志。
 */
export class PersonalQqService {
  private readonly detection: DetectionDeps;
  private readonly bridgeDeps: BridgeHttpDeps;
  private manifestCache?: SnowLumaManifest;
  /** 最近一次成功/失败的 bridge 读取结果（供会话绑定等动作复用，不落盘）。 */
  private lastBridge?: BridgeReadResult;

  constructor(
    private readonly container: Container,
    private readonly harness: HarnessService,
    private readonly deps: PersonalQqServiceDeps = {},
  ) {
    this.detection = deps.detection ?? createNodeDetectionDeps();
    this.bridgeDeps = deps.bridge ?? createNodeBridgeDeps();
  }

  private get settingsPath(): string {
    return join(this.container.paths.root, 'state', 'personal-qq.json');
  }

  private get env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async manifest(): Promise<SnowLumaManifest> {
    if (!this.manifestCache) {
      this.manifestCache = await loadSnowLumaManifest(this.deps.manifestsDir ?? this.container.manifestsDir);
    }
    return this.manifestCache;
  }

  async settings(): Promise<PersonalQqSettings> {
    try {
      const raw = JSON.parse(await readFile(this.settingsPath, 'utf8')) as unknown;
      const parsed = PersonalQqSettingsSchema.safeParse(raw);
      if (parsed.success) return { ...DEFAULT_PERSONAL_QQ_SETTINGS, ...parsed.data };
    } catch {
      // 首次运行 / 文件损坏：退回默认值（不删除、不覆盖用户文件直到保存）。
    }
    return { ...DEFAULT_PERSONAL_QQ_SETTINGS };
  }

  async saveSettings(settings: PersonalQqSettings): Promise<PersonalQqSettings> {
    const parsed = PersonalQqSettingsSchema.parse(settings);
    await mkdir(join(this.container.paths.root, 'state'), { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify(parsed, null, 2), 'utf8');
    await this.container.logger.info(
      'personal-qq',
      `settings saved (route=${parsed.route}, port=${parsed.onebotHttpPort}, installDir=${parsed.installDir ?? 'auto'})`,
    );
    return parsed;
  }

  /**
   * SnowLuma 由用户自行安装：在常见位置只读查找（与「我已完成安装」用同一套扫描逻辑）。
   * 这里只返回"校验通过"的目录；找不到就交给界面上的目录选择入口。
   */
  async discoverInstallDir(settings: PersonalQqSettings): Promise<string | undefined> {
    if (settings.installDir) return settings.installDir;
    const manifest = await this.manifest();
    const candidates = await discoverInstallDirs(
      {
        exists: (path) => this.detection.exists(path),
        readFile: async (path) => JSON.stringify(await this.detection.readJson(path)),
        readdir: (path) => this.detection.readdir(path),
      },
      { env: this.env, expectedVersion: manifest.version },
    );
    return candidates.find((item) => item.verification.valid)?.verification.installDir;
  }

  private async adapterState(): Promise<PersonalQqAdapterState> {
    try {
      const plugins = await this.harness.listPlugins();
      const found = plugins.find((item) => item.name === ADAPTER_PLUGIN);
      return { installed: Boolean(found?.installed), version: found?.version, expectedVersion: ADAPTER_VERSION };
    } catch {
      return { installed: false, expectedVersion: ADAPTER_VERSION };
    }
  }

  async status(): Promise<PersonalQqStatus> {
    const settings = await this.settings();
    const manifest = await this.manifest();
    const automation = decideManifestAutomation(manifest);

    const qq = await detectQqnt({
      exists: (path) => this.detection.exists(path),
      listProcesses: () => this.detection.listProcesses(),
      env: this.env,
    });

    const installDir = await this.discoverInstallDir(settings);
    const snowluma = await detectSnowLuma(
      {
        exists: (path) => this.detection.exists(path),
        readJson: (path) => this.detection.readJson(path),
        listProcesses: () => this.detection.listProcesses(),
      },
      {
        installDir: installDir ?? join(this.container.paths.root, 'components', 'snowluma', '(not-installed)'),
        expectedVersion: manifest.version,
        releaseFile: manifest.layout.releaseFile,
      },
    );

    const endpointResult =
      snowluma.installed && installDir
        ? await readOneBotEndpoint(
            { readdir: (path) => this.detection.readdir(path), readJson: (path) => this.detection.readJson(path) },
            { installDir, configDir: manifest.layout.configDir, defaultPort: settings.onebotHttpPort },
          )
        : { evidence: ['配置读取：跳过（未检测到 SnowLuma 安装）'] };

    const onebotBaseUrl = endpointResult.endpoint?.baseUrl ?? `http://127.0.0.1:${settings.onebotHttpPort}`;
    const webuiPort = settings.webuiPort ?? manifest.ports.webui;

    const webui = await probeTcp({ connect: (h, p, t) => this.detection.connect(h, p, t) }, {
      port: webuiPort,
      label: 'WebUI',
    });
    const onebotPort = await probeTcp({ connect: (h, p, t) => this.detection.connect(h, p, t) }, {
      port: endpointResult.endpoint?.port ?? settings.onebotHttpPort,
      label: 'OneBot HTTP',
    });

    const onebot = await probeOneBot(
      { getJson: (url, init) => this.detection.getJson(url, init) },
      { baseUrl: onebotBaseUrl, accessToken: endpointResult.endpoint?.accessToken },
    );

    const adapter = await this.adapterState();
    const notes: string[] = [];
    let bridge: ReturnType<typeof toBridgeState> | undefined;

    const auth = this.harness.auth();
    if (!adapter.installed) {
      notes.push('适配层：未安装 dsh-qq-link（第 4 步「安装 / 修复适配插件」）');
    } else if (!auth) {
      notes.push('适配层：Harness 未运行，无法读取插件状态');
    } else {
      const result = await readBridgeState(this.bridgeDeps, { baseUrl: auth.baseUrl, token: auth.token });
      this.lastBridge = result;
      bridge = toBridgeState(result);
      bridge.sessionIds = result.sessionIds;
      bridge.bindings = (result.bindings ?? []).map((item) => ({ 类型: item.类型, 号码: item.号码, 会话: item.会话 }));
      if (result.errorMessage) notes.push(`适配层：${result.errorMessage}`);
    }

    const status = composePersonalQqStatus({
      manifest,
      automation,
      qq,
      snowluma,
      webui,
      onebot,
      onebotEvidence: [...endpointResult.evidence, onebotPort.line],
      adapter,
      bridge,
      messageVerified: Boolean(settings.messageVerifiedAt),
      notes,
      now: this.now(),
    });

    await this.container.logger.info(
      'personal-qq',
      `status phase=${status.phase} qq=${qq.installed}/${qq.running} snowluma=${snowluma.installed}/${snowluma.running} adapter=${adapter.installed} bridge=${bridge?.ok ?? false}`,
    );
    return status;
  }

  /** 安装/修复适配插件（唯一由本软件代装的第三方组件；允许在线安装，不打包）。 */
  async installAdapter(): Promise<PersonalQqActionResult> {
    try {
      await this.harness.installAdapterPlugin();
      const restarted = await this.restartIfRunning();
      await this.container.logger.info('personal-qq', `adapter installed, restarted=${restarted}`);
      return {
        ok: true,
        message: restarted
          ? `适配插件 ${ADAPTER_PLUGIN}@${ADAPTER_VERSION} 已安装，Harness 已重启并加载`
          : `适配插件 ${ADAPTER_PLUGIN}@${ADAPTER_VERSION} 已安装；启动 Harness 时会加载`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.container.logger.error('personal-qq', `adapter install failed: ${message}`);
      return {
        ok: false,
        message: `安装适配插件失败：${message}`,
        nextStep: '检查网络/代理后重试；该插件从 npm 在线安装。',
      };
    }
  }

  /**
   * 把 OneBot 端点与令牌交给适配插件（只写必要键）。
   * 前置：SnowLuma 已配置 OneBot HTTP（配置里能读到 accessToken），Harness 正在运行。
   */
  async pushBridgeConfig(): Promise<PersonalQqActionResult> {
    const settings = await this.settings();
    const manifest = await this.manifest();
    const installDir = await this.discoverInstallDir(settings);
    if (!installDir) {
      return {
        ok: false,
        message: '没有找到 SnowLuma 安装目录，无法读取 OneBot 配置',
        nextStep: '先按引导安装 SnowLuma 并完成登录，然后在第 1 步选择它的安装目录。',
      };
    }

    const endpointResult = await readOneBotEndpoint(
      { readdir: (path) => this.detection.readdir(path), readJson: (path) => this.detection.readJson(path) },
      { installDir, configDir: manifest.layout.configDir, defaultPort: settings.onebotHttpPort },
    );
    const endpoint = endpointResult.endpoint;
    if (!endpoint) {
      return {
        ok: false,
        message: '没有在 SnowLuma 配置里找到 OneBot HTTP 服务',
        nextStep: '打开 SnowLuma WebUI → 连接配置，启用 OneBot v11 的 HTTP 服务（默认端口 3000），再回来重试。',
      };
    }

    return this.applyBridgeEndpoint({ baseUrl: endpoint.baseUrl, accessToken: endpoint.accessToken });
  }

  /**
   * 把指定端点写入适配插件（部署编排器也走这里，保证只有一处实现）。
   * 令牌只经内存传递，不写日志、不回显。
   */
  async applyBridgeEndpoint(endpoint: { baseUrl: string; accessToken?: string }): Promise<PersonalQqActionResult> {
    const auth = this.harness.auth();
    if (!auth) {
      return { ok: false, message: 'Harness 未运行，无法写入插件配置', nextStep: '先在第 2 节启动 Harness。' };
    }

    const result = await postBridgeConfig(this.bridgeDeps, {
      baseUrl: auth.baseUrl,
      token: auth.token,
      patch: {
        NapCat: endpoint.baseUrl,
        令牌: endpoint.accessToken ?? '',
        总开关: true,
        试运行: false,
      },
    });
    await this.container.logger.info(
      'personal-qq',
      `bridge config pushed ok=${result.ok} endpoint=${endpoint.baseUrl} token=${endpoint.accessToken ? 'present' : 'absent'}`,
    );
    if (!result.ok) {
      return {
        ok: false,
        message: `写入适配插件配置失败：${result.error ?? '未知错误'}`,
        nextStep: '确认 Harness 正在运行且适配插件已加载（第 4 步）。',
      };
    }
    return {
      ok: true,
      message: `已把 OneBot 地址 ${endpoint.baseUrl} 与访问令牌写入适配插件（令牌不回显、不落日志）`,
    };
  }

  /** 把一个 QQ 私聊绑定到指定的 Harness 会话（插件用 `绑定` 数组路由消息）。 */
  async bindPrivateSession(input: { sessionId: string; uin: string }): Promise<PersonalQqActionResult> {
    const sessionId = input.sessionId.trim();
    const uin = input.uin.trim();
    if (!sessionId || !uin) return { ok: false, message: '会话与 QQ 号都必须有值' };

    const auth = this.harness.auth();
    if (!auth) return { ok: false, message: 'Harness 未运行，无法写入绑定' };

    // 先读一次现状，保留用户已有绑定（不整份覆盖）。
    const current = await readBridgeState(this.bridgeDeps, { baseUrl: auth.baseUrl, token: auth.token });
    if (!current.ok) {
      return {
        ok: false,
        message: `读取适配插件配置失败：${current.errorMessage ?? '未知错误'}`,
        nextStep: current.nextStep,
      };
    }
    const existing = (current.bindings ?? []).filter((row) => !(row.类型 === '私聊' && row.号码 === uin));
    const merged = [...existing, { 类型: '私聊', 号码: uin, 会话: sessionId, 称呼: '对方', 开: true, 门槛: false }];

    const result = await postBridgeConfig(this.bridgeDeps, {
      baseUrl: auth.baseUrl,
      token: auth.token,
      patch: { 绑定: merged },
    });
    if (!result.ok) {
      return { ok: false, message: `写入绑定失败：${result.error ?? '未知错误'}` };
    }
    await this.container.logger.info('personal-qq', `binding written for uin=${uin} session=${sessionId}`);
    return { ok: true, message: `已把 QQ ${uin} 的私聊绑定到会话 ${sessionId}` };
  }

  /** 人工确认"已真实收到回复"（只由用户点击；不根据探测结果自动置位）。 */
  async markMessageVerified(verified: boolean): Promise<PersonalQqSettings> {
    const settings = await this.settings();
    const next: PersonalQqSettings = { ...settings };
    if (verified) next.messageVerifiedAt = this.now().toISOString();
    else delete next.messageVerifiedAt;
    return this.saveSettings(next);
  }


  private async restartIfRunning(): Promise<boolean> {
    if (!this.harness.running) return false;
    await this.harness.restart();
    return true;
  }

  /** 给 UI 的组件信息与官方入口（不含任何机密；URL 由这里集中管理，IPC 只认这些）。 */
  async guide(): Promise<PersonalQqGuide> {
    const manifest = await this.manifest();
    const settings = await this.settings();
    const asset = selectAsset(manifest);
    return {
      displayName: manifest.displayName,
      version: manifest.version,
      projectUrl: manifest.projectUrl,
      releasesUrl: manifest.releasesUrl,
      license: manifest.license,
      ports: manifest.ports,
      launcher: manifest.layout.launcher,
      installDir: await this.discoverInstallDir(settings),
      webuiUrl: `http://127.0.0.1:${settings.webuiPort ?? manifest.ports.webui}`,
      asset: {
        fileName: asset.fileName,
        sizeBytes: asset.sizeBytes,
        sha256: asset.sha256,
        url: asset.url,
      },
    };
  }

  /** 白名单：只返回清单里登记的地址（避免把任意 URL 交给系统浏览器）。 */
  async targetUrl(target: 'project' | 'releases' | 'license' | 'eula' | 'webui'): Promise<string> {
    const g = await this.guide();
    switch (target) {
      case 'project':
        return g.projectUrl;
      case 'releases':
        return g.releasesUrl;
      case 'license':
        return g.license.textUrl;
      case 'eula':
        return g.license.eulaUrl;
      case 'webui':
        return g.webuiUrl;
    }
  }
}
