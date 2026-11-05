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
      {(stage === 'detail' || stage === 'confirm') && <ol className="market-steps" aria-label="插件安装步骤">
        {([['list', '找插件'], ['detail', '看详情'], ['confirm', '确认安装']] as const).map(([key, label], index) => (
          <li key={key} className={stage === key ? 'current' : ''} aria-current={stage === key ? 'step' : undefined}>
            <b>{index + 1}</b>
            {label}
          </li>
        ))}
      </ol>}

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
          <button className="market-back" onClick={stage === 'confirm' ? () => setStage('detail') : back}>
            ← {stage === 'confirm' ? '返回详情' : '返回列表'}
          </button>
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
              {isCandidate(selected) && (
                <details className="market-more-info">
                  <summary>安装与兼容说明</summary>
                  <p>{selected.review.reason}</p>
                  {selected.review.blockers.map((blocker) => (
                    <p key={blocker.code}>
                      <b>{reasons[blocker.code]}：</b>
                      {blocker.detail}
                    </p>
                  ))}
                </details>
              )}
              <div className="market-detail-grid">
                <div><span>项目形态</span><strong>{marketOf(selected) ? kindLabels[marketOf(selected)!.kind] : '未记录'}</strong></div>
                <div><span>适用路线</span><strong>{marketOf(selected) ? routeLabels[marketOf(selected)!.route] : '待确认'}</strong></div>
                <div><span>作者</span><strong>{selected.author ?? '未提供'}</strong></div>
                <div><span>来源</span><strong>{sourceLabel(selected)}</strong></div>
                <div><span>版本</span><strong>{selected.version}</strong></div>
                <div>
                  <span>公开关注度</span>
                  <strong>{marketOf(selected)?.attention ? `GitHub ★ ${marketOf(selected)!.attention!.stars}（${marketOf(selected)!.attention!.queriedAt} 查询）` : '未记录'}</strong>
                </div>
                <div><span>许可</span><strong>{selected.license.spdx}</strong></div>
                <div><span>兼容性</span><strong>{compatibilityText(selected)}</strong></div>
                <div><span>体积</span><strong>{sizeText(selected)}</strong></div>
                <div><span>安装方式</span><strong>{marketOf(selected) ? installMethodLabels[marketOf(selected)!.installMethod] : '未记录'}</strong></div>
              </div>

              <h4>用途与风险</h4>
              <p>{selected.zh.description}</p>
              <p className="market-risk">{selected.zh.risk}</p>

              <h4>外部组件与前置条件</h4>
              {marketOf(selected)?.requires.length ? (
                <ul>{marketOf(selected)!.requires.map((line) => <li key={line}>{line}</li>)}</ul>
              ) : (
                <p>未记录必须另行安装的外部组件。</p>
              )}

              <h4>可能冲突</h4>
              {marketOf(selected)?.conflicts.length ? (
                <ul>{marketOf(selected)!.conflicts.map((line) => <li key={line}>{line}</li>)}</ul>
              ) : (
                <p>未记录已知冲突；启用前仍应确认没有另一个插件同时处理同一个 QQ 会话。</p>
              )}

              {'safety' in selected && (
                <>
                  <h4>联网与权限</h4>
                  <ul>
                    {[...selected.safety.network, ...selected.safety.permissions].map((line) => <li key={line}>{line}</li>)}
                  </ul>
                  {selected.safety.requiresRestart && <p>安装后需要重启助手程序。</p>}
                </>
              )}

              <h4>许可与分发</h4>
              <p>{licenseNote(selected)}</p>
              {'acceptance' in selected && (
                <details className="advanced-settings">
                  <summary>查看验收方式与许可详情</summary>
                  <ul>{selected.acceptance.map((item) => <li key={item.id}>{item.step}：{item.evidence}</li>)}</ul>
                  <p>兼容组合：{selected.compat}</p>
                  <p>校验值：<code>{selected.integrity}</code></p>
                  <p>依赖闭包：{selected.depsClosure.length} 项</p>
                </details>
              )}
              <h4>来源与使用引导</h4>
              <div className="market-links">
                {selected.homepage && <a href={selected.homepage} target="_blank" rel="noopener noreferrer">项目主页 ↗</a>}
                {'repository' in selected && selected.repository && (
                  <a href={selected.repository.url} target="_blank" rel="noopener noreferrer">源码仓库 ↗</a>
                )}
                {selected.source.type === 'npm' && (
                  <a href={`https://www.npmjs.com/package/${selected.name}`} target="_blank" rel="noopener noreferrer">npm 页面 ↗</a>
                )}
              </div>
              {guideFor(selected) ? (
                <button onClick={() => openGuide(selected)}>查看使用引导 →</button>
              ) : (
                <p>暂无已验证的使用引导。请打开上面的官方来源查看说明；本产品不编造跳转地址或操作步骤。</p>
              )}

              {isCandidate(selected) && selected.installNotes.length > 0 && (
                <>
                  <h4>安装说明</h4>
                  <ul>{selected.installNotes.map((line) => <li key={line}>{line}</li>)}</ul>
                </>
              )}

              {'acceptance' in selected && (
                <details className="advanced-settings">
                  <summary>高级操作</summary>
                  <p>命令使用终端当前的运行环境，可能与本软件管理的环境不同。建议使用下方的安装方案。</p>
                  <div className="row market-extra-actions">
                    <button onClick={() => void navigator.clipboard.writeText(`dsh plugin --profile web add ${selected.name}@${selected.version}`).then(() => setResult({ ok: true, message: '安装命令已复制。' })).catch(() => setResult({ ok: false, message: '复制失败，请重试。' }))}>复制安装命令</button>
                    <button onClick={() => void openHarness().then((response) => { if (!response.ok) setResult({ ok: false, message: response.reason ?? '助手尚未启动，请先到运行状态页面启动。' }); }).catch(() => setResult({ ok: false, message: '无法打开助手，请先启动。' }))}>打开助手</button>
                  </div>
                </details>
              )}

              {result && <div className={`banner ${result.ok ? 'ok' : 'bad'}`} role="status">{result.message}</div>}
              <div className="route-actions">
                <MarketInstallAction item={selected} onClick={() => { setResult(undefined); setStage('confirm'); }} />
              </div>
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
              <div className="banner">
                <strong>下载来源说明</strong>
                <p>本软件没有自建国内资源库。安装时会先尝试国内镜像 npmmirror，失败后按项目现有策略切换官方 npmjs；实际使用哪个来源，会在下面的进度里显示。</p>
                <p>首个来源：<code>https://registry.npmmirror.com/</code>；回退来源：<code>https://registry.npmjs.org/</code>。两者都不可达时会如实失败。</p>
                <p>无法保证所有国内网络都能直连；如果镜像和官方源都不可达，会如实失败并给出下一步，不会跳过校验或改称成功。</p>
              </div>
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
