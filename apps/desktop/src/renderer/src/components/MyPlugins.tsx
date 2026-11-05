import { useState } from 'react';
import type { InstalledPluginView, PluginEvidence, PluginInventorySnapshot } from '@dda/spec';

const evidenceText: Record<PluginEvidence, string> = {
  yes: '是',
  no: '否',
  unknown: '未验证',
};

const evidenceClass = (value: PluginEvidence): string =>
  value === 'yes' ? 'evidence-installed' : value === 'no' ? 'evidence-failed' : 'evidence-unverified';

export function PluginStateBadges({ plugin }: { plugin: InstalledPluginView }): JSX.Element {
  return (
    <div className="market-evidence">
      <span className="evidence-verified">安装：{evidenceText.yes}</span>
      <span className={evidenceClass(plugin.state.composed)}>加入配置：{evidenceText[plugin.state.composed]}</span>
      <span className={evidenceClass(plugin.state.loaded)}>已加载：{evidenceText[plugin.state.loaded]}</span>
      <span className={evidenceClass(plugin.state.configured)}>配置已写入：{evidenceText[plugin.state.configured]}</span>
    </div>
  );
}

export type MyPluginsProps = {
  snapshot?: PluginInventorySnapshot;
  loading: boolean;
  error?: string;
  busy?: string;
  notice?: { ok: boolean; message: string };
  onReload: () => void;
  onOpenSettings: (name: string) => void;
  onUninstall: (name: string, confirmed: boolean) => void;
  onOpenGuide: (guideId: string) => void;
  onBrowse: () => void;
  onOpenDiagnostics: () => void;
  onOpenPersonalQq: () => void;
};

export function MyPlugins(props: MyPluginsProps): JSX.Element {
  const [confirming, setConfirming] = useState<string>();
  const { snapshot, loading, error, busy, notice } = props;

  return (
    <section className="market-mine" aria-labelledby="mine-title">
      <div className="market-discover-head">
        <div>
          <span className="market-section-kicker">INSTALLED</span>
          <h3 id="mine-title">我的插件</h3>
          <p>这里只显示本软件管理的 web 配置环境里实际已安装的插件。</p>
        </div>
        <div className="row">
          <button onClick={props.onReload} disabled={loading}>刷新</button>
          <button onClick={props.onBrowse}>去「找插件」</button>
        </div>
      </div>

      {loading && <div className="market-panel" role="status">正在读取已安装的插件…</div>}

      {!loading && error !== undefined && (
        <div className="market-panel" role="alert">
          <h3>读取插件列表失败</h3>
          <p>{error}</p>
          <div className="row">
            <button onClick={props.onReload}>重试</button>
            <button onClick={props.onOpenDiagnostics}>打开故障诊断</button>
          </div>
        </div>
      )}

      {notice !== undefined && (
        <div className={`banner ${notice.ok ? 'ok' : 'bad'}`} role="status">{notice.message}</div>
      )}

      {!loading && error === undefined && snapshot !== undefined && (
        <>
          {snapshot.problems.length > 0 && (
            <div className="banner warn" role="alert">
              <strong>有些信息没读到</strong>
              <ul>{snapshot.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            </div>
          )}

          {!snapshot.harness.deployed && (
            <div className="market-panel">
              <h3>还没有部署 Harness</h3>
              <p>插件是装在 Harness 的 web 配置环境里的。先到「部署向导」完成环境部署，再回来管理插件。</p>
            </div>
          )}

          {snapshot.harness.deployed && snapshot.plugins.length === 0 && (
            <div className="market-panel">
              <h3>还没有安装任何插件</h3>
              <p>插件由你自己选择。到「找插件」里看看有什么适合你的，再回来这里打开设置或卸载。</p>
              <div className="row"><button className="primary" onClick={props.onBrowse}>去找插件</button></div>
            </div>
          )}

          {snapshot.plugins.length > 0 && (
            <div className="market-mine-list">
              <p className="market-recommend-note">
                Harness：{snapshot.harness.running ? '正在运行' : '未运行'}
                {snapshot.harness.version !== undefined ? ` · 版本 ${snapshot.harness.version}` : ''}
                {' · '}配置环境 {snapshot.harness.profile}
                {' · '}检查时间 {new Date(snapshot.checkedAt).toLocaleTimeString()}
              </p>
              {snapshot.plugins.map((plugin) => (
                <article className="market-mine-card" key={plugin.name}>
                  <header>
                    <div>
                      <h4>{plugin.title}</h4>
                      <p className="market-mine-name">{plugin.name}{plugin.version !== undefined ? ` · ${plugin.version}` : ''}</p>
                    </div>
                    {!plugin.known && <span className="badge warn">未收录</span>}
                  </header>
                  <p>{plugin.summary}</p>
                  <PluginStateBadges plugin={plugin} />

                  {plugin.stateNotes.length > 0 && (
                    <details className="advanced-settings">
                      <summary>状态说明（为什么是这些结论）</summary>
                      <ul>{plugin.stateNotes.map((note) => <li key={note}>{note}</li>)}</ul>
                    </details>
                  )}

                  {plugin.requires !== undefined && plugin.requires.length > 0 && (
                    <details className="advanced-settings">
                      <summary>使用前需要准备</summary>
                      <ul>{plugin.requires.map((line) => <li key={line}>{line}</li>)}</ul>
                    </details>
                  )}

                  <div className="route-actions">
                    {plugin.settings !== undefined ? (
                      <button
                        className="primary"
                        disabled={busy === plugin.name}
                        onClick={() => props.onOpenSettings(plugin.name)}
                        title={`${plugin.settings.label}（${plugin.settings.verifiedAt} 核实）`}
                      >
                        {busy === plugin.name ? '正在打开…' : plugin.settings.label}
                      </button>
                    ) : (
                      <span className="market-hint">没有已核实的设置入口</span>
                    )}
                    {plugin.guideId !== undefined && (
                      <button onClick={() => props.onOpenGuide(plugin.guideId!)}>使用引导</button>
                    )}
                    <button onClick={() => setConfirming(plugin.name)} disabled={busy === plugin.name}>卸载…</button>
                  </div>

                  {plugin.settings !== undefined && (
                    <p className="market-hint">
                      {plugin.settings.note ?? ''}（{plugin.settings.verifiedAt} 核实：{plugin.settings.evidence}）
                    </p>
                  )}

                  {confirming === plugin.name && (
                    <div className="market-confirm-inline" role="alertdialog" aria-label={`确认卸载 ${plugin.title}`}>
                      <h5>卸载 {plugin.title}？</h5>
                      <p>{plugin.uninstall.dataNote}</p>
                      <p>卸载前会自动备份 web 配置环境，可在「回到上一可用」里恢复。</p>
                      {plugin.uninstall.restartRequired && <p>卸载后需要重启 Harness。本软件会在它运行时自动重启。</p>}
                      <div className="row">
                        <button className="primary" onClick={() => { setConfirming(undefined); props.onUninstall(plugin.name, true); }}>
                          确认卸载
                        </button>
                        <button onClick={() => setConfirming(undefined)}>取消</button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
