import { useEffect, useMemo, useState } from 'react';
import type {
  CatalogCandidate,
  CatalogCandidateMarket,
  CatalogEntry,
  CatalogSupportLevel,
  CandidateBlockerCode,
  MarketInstallProgressEvent,
  PluginInventorySnapshot,
} from '@dda/spec';

import { GuideView } from './GuideView';
import { MyPlugins } from './MyPlugins';
import { guideById, type Guide } from './guides';

export type MarketData = {
  entries: readonly CatalogEntry[];
  candidates: readonly CatalogCandidate[];
  categories: Readonly<Record<string, { en: string; zh: string }>>;
};

/** 「我的插件」需要的一切（快照 + 动作），由 App 注入，组件本身不做 IPC。 */
export type MineProps = {
  snapshot?: PluginInventorySnapshot;
  loading: boolean;
  error?: string;
  busy?: string;
  notice?: { ok: boolean; message: string };
  reload: () => void;
  openSettings: (name: string) => void;
  uninstall: (name: string, confirmed: boolean) => void;
  openPersonalQq: () => void;
};

type Item = CatalogEntry | CatalogCandidate;
type Stage = 'list' | 'detail' | 'confirm' | 'guide';
type Route = 'official' | 'personal';
type Tab = 'find' | 'mine';

const reasons: Record<CandidateBlockerCode, string> = {
  'host-version-incompatible': '宿主版本不兼容',
  'not-a-bundle': '不是可加载的插件',
  'unverified-publisher': '发布者信息待核实',
  'license-restricted': '许可限制',
  'install-script': '安装时需要运行脚本',
  'closure-not-audited': '依赖许可尚未审核',
  'duplicates-product-scope': '与本产品功能范围重复',
  'native-capability-preferred': '宿主已有相关功能',
  'size-excessive': '资源体积较大',
  'no-declared-compatibility': '未声明兼容版本',
  'closure-needs-review': '依赖许可需要复核',
  'install-failed': '实际安装探测失败',
  'noncommercial-license': '禁止商业使用',
  'asset-license-restricted': '素材许可有限制',
};

const kindLabels: Record<CatalogCandidateMarket['kind'], string> = {
  plugin: 'Harness 插件',
  bridge: '独立桥接程序',
  tool: '扩展工具',
  reference: '参考资料',
};

const routeLabels: Record<CatalogCandidateMarket['route'], string> = {
  'official-qq': '官方 QQ',
  'personal-qq': '个人 QQ',
  unconfirmed: '待确认',
};

const installMethodLabels: Record<CatalogCandidateMarket['installMethod'], string> = {
  npm: 'npm 在线安装',
  github: 'GitHub 源安装',
  manual: '用户自行部署',
  none: '不提供安装',
};

const supportLabels: Record<CatalogSupportLevel, string> = {
  verified: '已验证',
  declared: '已声明，未实测',
  unverified: '未验证',
  unsupported: '不兼容/不支持',
};

const stepStatusLabels = {
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  skipped: '已跳过',
  unverified: '未验证',
} as const;

function isCandidate(item: Item): item is CatalogCandidate {
  return 'review' in item;
}

function marketOf(item: Item): CatalogCandidateMarket | undefined {
  return 'market' in item ? item.market : undefined;
}

function sourceLabel(item: Item): string {
  return item.source.type === 'npm' ? 'npm' : 'Git 仓库';
}

function licenseNote(item: Item): string {
  if (item.license.redistributable) return '许可允许本软件分发。';
  if (item.license.needsReview) return '许可或闭包仍需复核，本软件不分发其字节。';
  return '本软件不分发该项目的字节，只提供来源与说明。';
}

function sizeText(item: Item): string {
  if (isCandidate(item)) {
    if (item.review.facts.unpackedSizeBytes > 0) {
      return `解压后约 ${(item.review.facts.unpackedSizeBytes / 1024 / 1024).toFixed(1)} MB`;
    }
    return item.market.sizeNote ?? '暂无可靠数据';
  }
  return item.market?.sizeNote ?? '暂无可靠数据';
}

function compatibilityText(item: Item): string {
  if (!isCandidate(item)) return item.enginesDsh;
  return item.market.compatibilityNote ?? '尚未通过策展验证';
}

/** 目录条目 → 已核实的真实图文引导（见 guides.ts）。没有引导的条目返回 undefined。 */
export function guideFor(item: Item): Guide | undefined {
  if (item.id === 'plg-official-qqbot') return guideById('guide-official-qqbot');
  if (item.id === 'plg-dsh-aurabot-qq') return guideById('guide-aurabot-persona');
  return undefined;
}

/**
 * 详情页最醒目的部分：可复制的安装地址。
 * 没有地址时不渲染复制按钮，只说明原因（blocked / manual / none 不给地址）。
 */
export function InstallAddress({
  spec,
  reason,
  onCopy,
}: {
  spec?: string;
  reason: string;
  onCopy: (value: string) => void;
}): JSX.Element {
  if (spec === undefined) {
    return (
      <div className="market-install-spec market-install-spec-off">
        <span className="market-install-spec-label">安装地址</span>
        <p>{reason}</p>
      </div>
    );
  }
  return (
    <div className="market-install-spec">
      <span className="market-install-spec-label">安装地址</span>
      <code>{spec}</code>
      <button className="primary" onClick={() => onCopy(spec)}>复制</button>
    </div>
  );
}

/**
 * 可复制给 Harness 的安装地址。
 *
 * 只有真实存在的安装来源才给地址：npm 用 exact 版本，GitHub 源用 `github:owner/repo`；
 * 已判定 blocked、或安装方式是 manual/none **不提供**地址，避免把装不上的东西包装成可用。
 */
export function installSpecFor(item: Item): string | undefined {
  if (item.status === 'blocked') return undefined;
  const method = marketOf(item)?.installMethod;
  if (method === 'manual' || method === 'none') return undefined;
  if (item.source.type === 'npm') return `${item.name}@${item.version}`;
  const match = /^https:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?$/.exec(item.source.url);
  if (match) return `github:${match[1]}`;
  const git = item.source.url.endsWith('.git') ? item.source.url : `${item.source.url}.git`;
  return `git+${git}#${item.source.commit}`;
}

/** 为什么没有可复制的安装地址。 */
export function specMissingReason(item: Item): string {
  const method = marketOf(item)?.installMethod;
  if (item.status === 'blocked') return '这个插件没有通过本产品的安装评估，因此不提供安装地址。';
  if (method === 'manual') return '这个插件需要你自己下载安装（见下方项目主页），没有可复制的安装地址。';
  if (method === 'none') return '这个插件不提供自动安装方式。';
  return '暂无可用的安装地址。';
}

export function MarketInstallAction({ item, onClick }: { item: Item; onClick: () => void }): JSX.Element | null {
  if (item.status !== 'verified') return null;
  return <button className="primary" onClick={onClick}>查看安装方案 →</button>;
}

export function MarketEvidence({
  item,
  installed,
  installedVersion,
}: {
  item: Item;
  installed?: boolean;
  installedVersion?: string;
}): JSX.Element {
  return (
    <div className="market-evidence">
      <span className={item.status === 'verified' ? 'evidence-verified' : 'evidence-unverified'}>
        策展：{item.status === 'verified' ? '已验证' : '未通过'}
      </span>
      <span className="evidence-unverified">下载：未验证</span>
      <span className={item.status === 'verified' && installed === true ? 'evidence-installed' : 'evidence-unverified'}>
        安装：{item.status === 'verified' && installed !== undefined ? (installed ? `已安装${installedVersion ? ` ${installedVersion}` : ''}` : '未安装') : '未验证'}
      </span>
      <span className="evidence-unverified">加载：未验证</span>
      <span className="evidence-unverified">配置：未验证</span>
      <span className="evidence-unverified">连接：未验证</span>
    </div>
  );
}

function ItemCard({ item, onOpen, onGuide, isInstalled }: { item: Item; onOpen: () => void; onGuide?: () => void; isInstalled?: boolean }): JSX.Element {
  const market = marketOf(item);
  const guide = guideFor(item);
  return (
    <article className="market-item">
      <div className="market-item-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7M14 17.5h7"/></svg>
      </div>
      <div className="market-item-copy">
        <div className="market-item-title">
          <h4>{item.zh.name}</h4>
          {isInstalled === true && <span className="badge ok">已安装</span>}
        </div>
        <p>{item.zh.summary}</p>
        <div className="market-meta">
          <span>{item.author ?? '作者未提供'}</span>
          <span>{sourceLabel(item)}</span>
          <span>v{item.version}</span>
          {market && <span>{kindLabels[market.kind]}</span>}
          {market && <span>{routeLabels[market.route]}</span>}
          {market?.attention && (
            <span>
              GitHub ★ {market.attention.stars}（{market.attention.queriedAt} 查询）
            </span>
          )}
        </div>
      </div>
      <div className="market-item-actions">
        <button onClick={onOpen}>查看详情</button>
        {guide && onGuide && <button onClick={onGuide}>使用引导</button>}
        {item.homepage && (
          <a href={item.homepage} target="_blank" rel="noopener noreferrer">
            来源 ↗
          </a>
        )}
      </div>
    </article>
  );
}

function InstallProgress({ progress }: { progress?: MarketInstallProgressEvent }): JSX.Element {
  if (!progress) {
    return <p className="market-progress-idle">安装开始后，这里会显示实际步骤、当前下载来源和进度。</p>;
  }
  const stepNumber = progress.step?.index;
  const percent = progress.phase === 'done' ? 100 : stepNumber === undefined ? 0 : Math.round((stepNumber / 9) * 100);
  return (
    <div className="market-progress" role="status" aria-live="polite" aria-atomic="false">
      <div className="market-progress-head">
        <strong>{progress.message}</strong>
        {stepNumber !== undefined && <span>{stepNumber}/9</span>}
      </div>
      <div className="market-progress-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(percent, progress.phase === 'starting' ? 3 : 0)}%` }} />
      </div>
      {progress.source && (
        <p>
          当前来源：{progress.source.label}
          {progress.source.attempt !== undefined && progress.source.total !== undefined
            ? `（第 ${progress.source.attempt}/${progress.source.total} 个来源）`
            : ''}
          {progress.source.ok === true ? '，已完成' : progress.source.ok === false ? '，不可用，继续尝试下一个来源' : ''}
        </p>
      )}
      {progress.step && (
        <p>
          步骤：{progress.step.title} · {stepStatusLabels[progress.step.status]}
        </p>
      )}
    </div>
  );
}

export function MarketCenter({
  data,
  loading,
  error,
  route = 'official',
  progress,
  reload,
  openDiagnostics,
  openHarness,
  dataDir,
  installed,
  installedVersion,
  install,
  mine,
  initialTab = 'find',
  copyText,
}: {
  data?: MarketData;
  loading: boolean;
  error?: string;
  route?: Route;
  progress?: MarketInstallProgressEvent;
  reload: () => void;
  openDiagnostics: () => void;
  openHarness: () => Promise<{ ok: boolean; reason?: string }>;
  dataDir?: string;
  installed?: boolean;
  installedVersion?: string;
  install: (id: string) => Promise<{ ok: boolean; message: string }>;
  /** 「我的插件」的真实快照与动作；缺省时该入口显示为读取中。 */
  mine?: MineProps;
  initialTab?: Tab;
  /** 复制到剪贴板（主进程实现）；缺省时退回浏览器 clipboard。 */
  copyText?: (value: string) => Promise<unknown>;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [selected, setSelected] = useState<Item>();
  const [guideItem, setGuideItem] = useState<Item>();
  const [guideStep, setGuideStep] = useState(0);
  const [stage, setStage] = useState<Stage>('list');
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const [routeChoice, setRouteChoice] = useState<Route>(route);

  useEffect(() => setRouteChoice(route), [route]);

  useEffect(() => {
    if (stage === 'guide') {
      setGuideStep(0);
    }
  }, [guideItem, stage]);

  const items = useMemo(() => [...(data?.entries ?? []), ...(data?.candidates ?? [])], [data]);

  const groups = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const matches = (item: Item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (!q) return true;
      const market = marketOf(item);
      return [
        item.name,
        item.zh.name,
        item.zh.summary,
        item.zh.description,
        item.author ?? '',
        ...item.keywords,
        ...item.labels,
        ...(market?.requires ?? []),
        ...(market?.conflicts ?? []),
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(q);
    };
    const visible = items.filter(matches);
    return {
      verified: visible.filter((item) => item.status === 'verified'),
      review: visible.filter((item) => item.status === 'needs-review'),
      blocked: visible.filter((item) => item.status === 'blocked'),
    };
  }, [items, query, category]);

  const recommendedIds: Record<Route, string[]> = {
    official: ['plg-official-qqbot', 'plg-dsh-meme'],
    personal: ['plg-dsh-aurabot-qq', 'plg-dsh-qq-tools', 'plg-dsh-meme'],
  };
  const recommended = recommendedIds[routeChoice]
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is Item => item !== undefined);

  const open = (item: Item) => {
    setSelected(item);
    setResult(undefined);
    setGuideItem(undefined);
    setGuideStep(0);
    setStage('detail');
  };
  const back = () => {
    setResult(undefined);
    setStage('list');
    setSelected(undefined);
    setGuideItem(undefined);
    setGuideStep(0);
  };
  const openGuide = (item: Item) => {
    setSelected(item);
    setGuideItem(item);
    setGuideStep(0);
    setStage('guide');
  };
  const doInstall = async () => {
    if (!selected || selected.status !== 'verified' || working) return;
    setWorking(true);
    try {
      setResult(await install(selected.id));
    } catch {
      setResult({ ok: false, message: '安装未完成，请检查网络或打开故障诊断后重试。' });
    } finally {
      setWorking(false);
    }
  };

  const copy = async (value: string, okMessage: string) => {
    try {
      if (copyText !== undefined) await copyText(value);
      else await navigator.clipboard.writeText(value);
      setResult({ ok: true, message: okMessage });
    } catch {
      setResult({ ok: false, message: '复制失败，请手动选中文字复制。' });
    }
  };

  const spec = selected === undefined ? undefined : installSpecFor(selected);

  const guide = guideItem ? guideFor(guideItem) : undefined;

  const installedPackages = new Set((mine?.snapshot?.plugins ?? []).map((plugin) => plugin.name));

  return (
    <main className="market-page">
      <div className="market-heading">
        <div>
          <span className="eyebrow">PLUGINS</span>
          <h2>插件中心</h2>
          <p>找插件，也管理已经装在这个环境里的插件。插件由你自己选择，我们只提供工具。</p>
        </div>
        <div className="market-heading-mark" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path d="M24 7v34M7 24h34M12 12l24 24M36 12 12 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="24" cy="24" r="7" fill="currentColor"/></svg></div>
      </div>

      <div className="market-tabs" role="tablist" aria-label="插件中心">
        <button
          role="tab"
          aria-selected={tab === 'find'}
          aria-controls="market-find-panel"
          className={tab === 'find' ? 'primary' : ''}
          onClick={() => { setTab('find'); back(); }}
        >
          找插件
        </button>
        <button
          role="tab"
          aria-selected={tab === 'mine'}
          aria-controls="market-mine-panel"
          className={tab === 'mine' ? 'primary' : ''}
          onClick={() => setTab('mine')}
        >
          我的插件{mine?.snapshot !== undefined ? `（${mine.snapshot.plugins.length}）` : ''}
        </button>
      </div>

      {tab === 'mine' && (
        <div id="market-mine-panel" role="tabpanel" aria-label="我的插件">
          <MyPlugins
            {...(mine?.snapshot === undefined ? {} : { snapshot: mine.snapshot })}
            loading={mine?.loading ?? true}
            {...(mine?.error === undefined ? {} : { error: mine.error })}
            {...(mine?.busy === undefined ? {} : { busy: mine.busy })}
            {...(mine?.notice === undefined ? {} : { notice: mine.notice })}
            onReload={() => mine?.reload()}
            onOpenSettings={(name) => mine?.openSettings(name)}
            onUninstall={(name, confirmed) => mine?.uninstall(name, confirmed)}
            onOpenGuide={(guideId) => {
              const targetId = guideId === 'guide-official-qqbot' ? 'plg-official-qqbot' : 'plg-dsh-aurabot-qq';
              const target = items.find((item) => item.id === targetId);
              if (target === undefined) return;
              setTab('find');
              openGuide(target);
            }}
            onBrowse={() => setTab('find')}
            onOpenDiagnostics={openDiagnostics}
            onOpenPersonalQq={() => mine?.openPersonalQq()}
          />
        </div>
      )}

      {tab === 'find' && (
      <div id="market-find-panel" role="tabpanel" aria-label="找插件">
      {(stage === 'detail' || stage === 'confirm') && selected !== undefined && (
        <ol className="market-steps" aria-label="插件安装步骤">
          <li>
            <button onClick={back}><b>1</b>找插件</button>
          </li>
          <li className={stage === 'detail' ? 'current' : ''} aria-current={stage === 'detail' ? 'step' : undefined}>
            <button onClick={() => { setResult(undefined); setStage('detail'); }}><b>2</b>看详情</button>
          </li>
          <li className={stage === 'confirm' ? 'current' : ''} aria-current={stage === 'confirm' ? 'step' : undefined}>
            <button
              disabled={selected.status !== 'verified'}
              onClick={() => { setResult(undefined); setStage('confirm'); }}
              title={selected.status === 'verified' ? '确认安装' : '这个插件没有通过安装评估'}
            >
              <b>3</b>确认安装
            </button>
          </li>
        </ol>
      )}

      {loading && <div className="market-panel" role="status">正在读取插件资源…</div>}

      {!loading && error && (
        <div className="market-panel" role="alert">
          <h3>无法读取插件资源</h3>
          <p>{error}</p>
          <p>可以先重新加载；如果仍然失败，请打开故障诊断查看详细原因。这里不会用空列表冒充正常。</p>
          <div className="row">
            <button onClick={reload}>重新加载</button>
            <button onClick={openDiagnostics}>打开故障诊断</button>
          </div>
        </div>
      )}

      {!loading && !error && data && stage === 'list' && (
        <>
          <section className="market-recommend" aria-labelledby="market-recommend-title">
            <div className="market-recommend-head">
              <div>
                <h3 id="market-recommend-title">推荐搭配</h3>
                <p>根据接入方式发现合适的插件，最终选择权在你。</p>
              </div>
              <div className="market-route-toggle" role="group" aria-label="选择 QQ 路线">
                <button className={routeChoice === 'official' ? 'primary' : ''} aria-pressed={routeChoice === 'official'} onClick={() => setRouteChoice('official')}>官方 QQ</button>
                <button className={routeChoice === 'personal' ? 'primary' : ''} aria-pressed={routeChoice === 'personal'} onClick={() => setRouteChoice('personal')}>个人 QQ</button>
              </div>
            </div>
            <div className="market-recommend-list">
              {routeChoice === 'personal' && (
                <article className="market-recommend-item">
                  <span className="market-recommend-index">01</span>
                  <div>
                    <strong>SnowLuma（外部组件）</strong>
                    <p>个人 QQ 接入所需组件，请自行安装并启动。</p>
                  </div>
                  <span className="badge warn">需自行准备</span>
                </article>
              )}
              {recommended.map((item, index) => {
                return (
                  <article className="market-recommend-item" key={item.id}>
                    <span className="market-recommend-index">{String(index + (routeChoice === 'personal' ? 2 : 1)).padStart(2, '0')}</span>
                    <div>
                      <strong>{item.zh.name}</strong>
                      <p>{item.zh.summary}</p>
                    </div>
                    <button onClick={() => open(item)}>查看</button>
                  </article>
                );
              })}
            </div>
            <p className="market-recommend-note">
              {routeChoice === 'official'
                ? '插件可单独选择；具体适用范围和限制请查看详情。'
                : 'SnowLuma 需自行准备。不同 QQ 通道可能重复回复，同一会话请只选一个通道。'}
            </p>
          </section>

          <div className="market-discover-head"><div><span className="market-section-kicker">DISCOVER</span><h3>浏览全部插件</h3></div><span>{items.length} 个项目</span></div>
          <div className="market-filters">
            <label className="form-field">
              <span>搜索插件</span>
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入名称、用途或需要的组件" />
            </label>
            <label className="form-field">
              <span>分类</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="all">全部分类</option>
                {Object.entries(data.categories).map(([id, label]) => (
                  <option key={id} value={id}>{label.zh}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="market-categories" role="group" aria-label="按分类筛选">
            <button className={category === 'all' ? 'primary' : ''} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>全部</button>
            {Object.entries(data.categories).map(([id, label]) => (
              <button key={id} className={category === id ? 'primary' : ''} aria-pressed={category === id} onClick={() => setCategory(id)}>{label.zh}</button>
            ))}
          </div>

          {(() => {
            const list = [...groups.verified, ...groups.review, ...groups.blocked];
            return (
              <section className="market-group">
                {list.length === 0 ? (
                  <p className="market-empty">没有符合条件的插件</p>
                ) : (
                  <div className="market-list">
                    {list.map((item) => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        isInstalled={installedPackages.has(item.name)}
                        onOpen={() => open(item)}
                        {...(guideFor(item) ? { onGuide: () => openGuide(item) } : {})}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })()}
        </>
      )}

      {!loading && !error && stage === 'guide' && guideItem && guide && (
        <GuideView
          guide={guide}
          step={guideStep}
          onStep={(index) => setGuideStep(index)}
          onBack={() => setStage('detail')}
        />
      )}

      {!loading && !error && selected && stage !== 'list' && stage !== 'guide' && (
        <section className="market-panel">
          <div className="market-detail-heading">
            <div>
              <span className="eyebrow">插件详情</span>
              <h3>{selected.zh.name}</h3>
              <p>{selected.zh.summary}</p>
            </div>
            <div className="market-detail-badges">
              <span className="badge">{selected.version}</span>
            </div>
          </div>

          {stage === 'detail' && (
            <>
              <InstallAddress
                {...(spec === undefined ? {} : { spec })}
                reason={specMissingReason(selected)}
                onCopy={(value) => void copy(value, '安装地址已复制，可以粘贴给 Harness。')}
              />

              {spec !== undefined && (
                <p className="market-install-hint">
                  在 Harness 左侧栏「插件」→ 右上角「添加插件」里粘贴；也可以让 Harness 里的助手按这个地址安装。
                  {selected.status !== 'verified' && ' 本产品尚未验证这个插件，兼容性与许可请自行确认。'}
                </p>
              )}

              {isCandidate(selected) && selected.status === 'blocked' && (
                <p className="market-hint">未通过评估：{selected.review.reason}</p>
              )}

              {result && <div className={`banner ${result.ok ? 'ok' : 'bad'}`} role="status">{result.message}</div>}

              <div className="route-actions">
                <MarketInstallAction item={selected} onClick={() => { setResult(undefined); setStage('confirm'); }} />
                {guideFor(selected) !== undefined && (
                  <button onClick={() => openGuide(selected)}>使用引导</button>
                )}
                {spec !== undefined && (
                  <button onClick={() => void copy(`dsh plugin --profile web add ${spec}`, '导入命令已复制。')}>复制导入命令</button>
                )}
              </div>

              <details className="advanced-settings market-more-info">
                <summary>更多说明（来源 / 许可 / 前置条件 / 风险）</summary>

                {isCandidate(selected) && (
                  <>
                    <p>{selected.review.reason}</p>
                    {selected.review.blockers.map((blocker) => (
                      <p key={blocker.code}>
                        <b>{reasons[blocker.code]}：</b>
                        {blocker.detail}
                      </p>
                    ))}
                  </>
                )}

                <div className="market-detail-grid">
                  <div><span>项目形态</span><strong>{marketOf(selected) ? kindLabels[marketOf(selected)!.kind] : '未记录'}</strong></div>
                  <div><span>适用路线</span><strong>{marketOf(selected) ? routeLabels[marketOf(selected)!.route] : '待确认'}</strong></div>
                  <div><span>作者</span><strong>{selected.author ?? '未提供'}</strong></div>
                  <div><span>来源</span><strong>{sourceLabel(selected)}</strong></div>
                  <div><span>版本</span><strong>{selected.version}</strong></div>
                  <div><span>许可</span><strong>{selected.license.spdx}</strong></div>
                  <div><span>兼容性</span><strong>{compatibilityText(selected)}</strong></div>
                  <div><span>体积</span><strong>{sizeText(selected)}</strong></div>
                </div>

                <p>{selected.zh.description}</p>
                <p className="market-risk">{selected.zh.risk}</p>

                {marketOf(selected)?.requires.length ? (
                  <>
                    <h4>使用前需要准备</h4>
                    <ul>{marketOf(selected)!.requires.map((line) => <li key={line}>{line}</li>)}</ul>
                  </>
                ) : null}

                {marketOf(selected)?.conflicts.length ? (
                  <>
                    <h4>可能冲突</h4>
                    <ul>{marketOf(selected)!.conflicts.map((line) => <li key={line}>{line}</li>)}</ul>
                  </>
                ) : null}

                {'safety' in selected && (
                  <>
                    <h4>联网与权限</h4>
                    <ul>{[...selected.safety.network, ...selected.safety.permissions].map((line) => <li key={line}>{line}</li>)}</ul>
                  </>
                )}

                <h4>许可与分发</h4>
                <p>{licenseNote(selected)}</p>

                {'acceptance' in selected && (
                  <>
                    <h4>验收方式</h4>
                    <ul>{selected.acceptance.map((item) => <li key={item.id}>{item.step}：{item.evidence}</li>)}</ul>
                    <p>兼容组合：{selected.compat}；依赖闭包：{selected.depsClosure.length} 项</p>
                    <p>校验值：<code>{selected.integrity}</code></p>
                  </>
                )}

                {isCandidate(selected) && selected.installNotes.length > 0 && (
                  <>
                    <h4>安装说明</h4>
                    <ul>{selected.installNotes.map((line) => <li key={line}>{line}</li>)}</ul>
                  </>
                )}

                <div className="market-links">
                  {selected.homepage && <a href={selected.homepage} target="_blank" rel="noopener noreferrer">项目主页 ↗</a>}
                  {'repository' in selected && selected.repository && (
                    <a href={selected.repository.url} target="_blank" rel="noopener noreferrer">源码仓库 ↗</a>
                  )}
                  {selected.source.type === 'npm' && (
                    <a href={`https://www.npmjs.com/package/${selected.name}`} target="_blank" rel="noopener noreferrer">npm 页面 ↗</a>
                  )}
                  <button onClick={() => void openHarness()}>打开助手</button>
                </div>
              </details>
            </>
          )}

          {stage === 'confirm' && selected.status === 'verified' && (
            <>
              <h4>确认安装</h4>
              <p>将在线安装 {selected.zh.name} {selected.version}，并修改本软件管理的 web 配置环境。</p>
              <div className="market-confirm-grid">
                <div><span>安装位置</span><strong>{dataDir ? `${dataDir}\\dsh-home\\profiles\\web` : '本软件数据目录中的 web 配置环境'}</strong></div>
                <div><span>预计空间</span><strong>{sizeText(selected)}</strong></div>
                <div><span>安装来源</span><strong>npm 在线安装，不由本软件分发插件字节</strong></div>
                <div><span>需要权限</span><strong>联网；安装后需要重启助手</strong></div>
              </div>
              <details className="advanced-settings">
                <summary>下载来源说明（会自动尝试国内镜像）</summary>
                <p>本软件没有自建国内资源库。安装时会先尝试国内镜像 npmmirror，失败后按项目现有策略切换官方 npmjs；实际使用哪个来源，会在下面的进度里显示。</p>
                <p>首个来源：<code>https://registry.npmmirror.com/</code>；回退来源：<code>https://registry.npmjs.org/</code>。两者都不可达时会如实失败。</p>
                <p>无法保证所有国内网络都能直连；如果镜像和官方源都不可达，会如实失败并给出下一步，不会跳过校验或改称成功。</p>
              </details>
              <p className="market-risk">{selected.zh.risk}</p>
              <ul>{selected.installNotes.map((line) => <li key={line}>{line}</li>)}</ul>
              <h4>安装进度</h4>
              <InstallProgress progress={progress} />
              {result && (
                <div className={`banner ${result.ok ? 'ok' : 'bad'}`} role="status">
                  {result.message}
                  {result.ok ? (
                    <div>
                      安装结果不代表插件已加载、已配置或 QQ 已连通。下一步：重启助手 → 打开插件自己的设置页 → 扫码授权 → 发送测试消息。
                    </div>
                  ) : (
                    <div>请检查网络后重试；问题持续时可打开故障诊断，或换一个可用来源后重试。</div>
                  )}
                </div>
              )}
              <div className="route-actions">
                <button onClick={() => setStage('detail')} disabled={working}>返回详情</button>
                {result?.ok && guideFor(selected) && <button onClick={() => openGuide(selected)}>查看使用引导</button>}
                {result?.ok && selected !== undefined && mine !== undefined && (
                  <button className="primary" onClick={() => mine.openSettings(selected.name)}>
                    打开设置
                  </button>
                )}
                {result?.ok && <button onClick={() => void openHarness()}>打开助手</button>}
                {result?.ok && <button onClick={() => { setTab('mine'); mine?.reload(); }}>去「我的插件」</button>}
                <button className="primary" onClick={() => void doInstall()} disabled={working || result?.ok}>
                  {working ? '安装中…' : result?.ok ? '已安装' : result ? '重试安装' : '确认并在线安装'}
                </button>
              </div>
            </>
          )}
        </section>
      )}
      </div>
      )}
    </main>
  );
}
