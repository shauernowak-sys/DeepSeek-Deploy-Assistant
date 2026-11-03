import { DdaError, ERROR_CODES, selectAsset, type SnowLumaManifest } from '@dda/spec';

/**
 * SnowLuma 官方版本管理（M3.3-01）。
 *
 * 三件事必须同时成立才允许进入下载：
 *  1. 清单里的版本/文件名/大小/哈希必须是"精确锁定"的（不接受 latest）；
 *  2. 下载地址必须落在**官方 GitHub Releases** 的固定形状上（不接受第三方镜像）；
 *  3. 能联网时必须用 GitHub Releases API 反查同名资产的 size 与 digest，出现不一致即整份拒绝。
 *
 * 第 3 条失败（断网/代理）只降级为"仅按清单校验"，因为下载完成后的 SHA-256 校验才是最终闸门。
 */

export interface ReleaseHttpDeps {
  getJson(
    url: string,
    init?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ status: number; body: unknown }>;
}

export interface ResolvedRelease {
  version: string;
  fileName: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  /** 校验深度：既核对了清单也核对了 GitHub API，或仅核对清单（离线）。 */
  verifiedAgainst: 'manifest+github' | 'manifest-only';
  checkedAt: string;
  /** 已脱敏的证据行（可直接展示给用户/写日志）。 */
  evidence: string[];
}

const SNOWLUMA_REPO = 'SnowLuma/SnowLuma';
const SNOWLUMA_API_BASE = 'https://api.github.com/repos/SnowLuma/SnowLuma';

/** 官方资产的 URL 形状：`https://github.com/SnowLuma/SnowLuma/releases/download/v<ver>/<file>`。 */
export function officialAssetProblems(asset: { url: string; fileName: string; version: string }): string[] {
  const problems: string[] = [];
  let url: URL;
  try {
    url = new URL(asset.url);
  } catch {
    return ['下载地址不是合法 URL'];
  }
  if (url.protocol !== 'https:') problems.push('下载地址必须是 https');
  if (url.host !== 'github.com') problems.push(`下载地址必须来自 github.com（实际 ${url.host}）`);
  const expectedPath = `/${SNOWLUMA_REPO}/releases/download/v${asset.version}/${asset.fileName}`;
  if (url.pathname !== expectedPath) problems.push(`下载路径必须是 ${expectedPath}（实际 ${url.pathname}）`);
  if (url.search || url.hash) problems.push('下载地址不得带查询串或片段');
  if (!/^SnowLuma-v\d+\.\d+\.\d+-win-x64(-lite)?\.zip$/.test(asset.fileName)) {
    problems.push(`资产文件名不是官方 Windows x64 包：${asset.fileName}`);
  }
  if (!asset.fileName.includes(`-v${asset.version}-`)) {
    problems.push(`资产文件名里的版本与清单版本 ${asset.version} 不一致`);
  }
  return problems;
}

interface ReleaseAssetShape {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
}

interface ReleaseShape {
  tag_name?: unknown;
  assets?: unknown;
}

function pickAsset(body: unknown, fileName: string): { size?: number; digest?: string } | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const assets = (body as ReleaseShape).assets;
  if (!Array.isArray(assets)) return undefined;
  const found = assets.find((item) => (item as ReleaseAssetShape)?.name === fileName) as ReleaseAssetShape | undefined;
  if (!found) return undefined;
  return {
    size: typeof found.size === 'number' ? found.size : undefined,
    digest: typeof found.digest === 'string' ? found.digest : undefined,
  };
}

interface ResolveReleaseOptions {
  /** false 时断网即失败；默认允许降级为"仅清单校验"，并在证据里标注。 */
  allowOffline?: boolean;
  timeoutMs?: number;
  now?: () => Date;
}

export async function resolveRelease(
  deps: ReleaseHttpDeps,
  manifest: SnowLumaManifest,
  options: ResolveReleaseOptions = {},
): Promise<ResolvedRelease> {
  const asset = selectAsset(manifest);
  const evidence: string[] = [];

  const problems = officialAssetProblems({ url: asset.url, fileName: asset.fileName, version: manifest.version });
  if (problems.length > 0) {
    throw new DdaError(
      ERROR_CODES.E_MANIFEST_INVALID,
      `内置清单的下载来源不合规：${problems.join('；')}`,
      '重新安装应用以恢复官方清单；不要手工编辑 resources/manifests',
    );
  }
  evidence.push(`版本锁定：v${manifest.version}（${asset.fileName}，${asset.sizeBytes} 字节）`);
  evidence.push(`来源核对：官方 GitHub Releases（${SNOWLUMA_REPO}），地址形状校验通过`);

  const checkedAt = (options.now ? options.now() : new Date()).toISOString();
  let verifiedAgainst: ResolvedRelease['verifiedAgainst'] = 'manifest-only';

  try {
    const timeoutMs = options.timeoutMs ?? 8000;
    const release = await deps.getJson(`${SNOWLUMA_API_BASE}/releases/tags/v${manifest.version}`, {
      headers: { Accept: 'application/vnd.github+json' },
      timeoutMs,
    });
    if (release.status !== 200) {
      evidence.push(`在线核对：GitHub 返回 HTTP ${release.status}，改按清单校验哈希`);
    } else {
      const body = release.body as ReleaseShape | null;
      const tag = body?.tag_name;
      if (tag !== `v${manifest.version}`) {
        throw new DdaError(
          ERROR_CODES.E_MANIFEST_INVALID,
          `GitHub 上的标签是 ${String(tag)}，与清单锁定的 v${manifest.version} 不一致`,
          '不要使用 latest；等应用更新清单后再部署',
        );
      }
      const found = pickAsset(release.body, asset.fileName);
      if (!found) {
        throw new DdaError(
          ERROR_CODES.E_MANIFEST_INVALID,
          `官方 Releases 里没有 ${asset.fileName}`,
          '该版本可能已被上游删除；请更新应用',
        );
      }
      if (found.size !== undefined && found.size !== asset.sizeBytes) {
        throw new DdaError(
          ERROR_CODES.E_MANIFEST_INVALID,
          `官方资产大小 ${found.size} 与清单 ${asset.sizeBytes} 不一致`,
          '清单与上游不一致，停止部署以免装入被替换的文件',
        );
      }
      if (found.digest) {
        const normalized = found.digest.replace(/^sha256:/i, '').toLowerCase();
        if (normalized !== asset.sha256.toLowerCase()) {
          throw new DdaError(
            ERROR_CODES.E_MANIFEST_INVALID,
            '官方资产的 SHA-256 与清单不一致',
            '停止部署：上游产物已变化，需要人工复核清单',
          );
        }
        evidence.push(`在线核对：GitHub 提供的 sha256 与清单一致（${normalized.slice(0, 12)}…）`);
      } else {
        evidence.push('在线核对：GitHub 未提供该资产的 digest，按清单哈希在下载后强制校验');
      }
      verifiedAgainst = 'manifest+github';

      try {
        const latest = await deps.getJson(`${SNOWLUMA_API_BASE}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' },
          timeoutMs,
        });
        const latestTag = (latest.body as ReleaseShape | null)?.tag_name;
        if (typeof latestTag === 'string' && latestTag !== `v${manifest.version}`) {
          evidence.push(`提示：上游已有 ${latestTag}，本产品当前锁定 v${manifest.version}（未做兼容验证）`);
        }
      } catch {
        // 最新版本提示是附加信息，失败不影响部署。
      }
    }
  } catch (error) {
    if (error instanceof DdaError) throw error;
    if (options.allowOffline === false) {
      throw new DdaError(
        ERROR_CODES.E_DOWNLOAD_NETWORK,
        `无法联网核对官方版本：${error instanceof Error ? error.message : String(error)}`,
        '检查网络/代理后重试',
      );
    }
    evidence.push('在线核对：无法访问 GitHub API，改为仅按内置清单校验（下载后仍会强制校验 SHA-256）');
  }

  return {
    version: manifest.version,
    fileName: asset.fileName,
    url: asset.url,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    verifiedAgainst,
    checkedAt,
    evidence,
  };
}
