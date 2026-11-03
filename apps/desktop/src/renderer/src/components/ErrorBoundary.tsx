import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error?: Error;
  /** Component stack from React — logged, never rendered verbatim as "the error". */
  componentStack?: string;
}

/**
 * Without a boundary a render-time exception unmounts the whole tree and the user gets a white
 * window with no explanation. This keeps the window usable and says what happened.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? undefined });
    // eslint-disable-next-line no-console
    console.error('[renderer] 界面渲染异常', error, info.componentStack);
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app">
        <div className="card">
          <h2>界面发生异常</h2>
          <div className="error">{error.message}</div>
          <p className="muted">
            应用进程仍在运行，只是这一屏没能渲染出来。可以重新加载界面；如果反复出现，请打开日志目录并导出诊断报告。
          </p>
          <div className="row">
            <button className="primary" onClick={() => window.location.reload()}>
              重新加载界面
            </button>
            <button onClick={() => void window.dda?.openLogs()}>打开日志目录</button>
          </div>
          {this.state.componentStack && (
            <details>
              <summary className="muted">技术细节</summary>
              <pre className="evidence">{this.state.componentStack}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
