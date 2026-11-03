import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

/** Errors that never reach React (timers, IPC listeners) still deserve a trace in the console. */
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] 未处理的 Promise 拒绝', event.reason);
});
window.addEventListener('error', (event) => {
  console.error('[renderer] 未捕获的错误', event.error ?? event.message);
});

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
