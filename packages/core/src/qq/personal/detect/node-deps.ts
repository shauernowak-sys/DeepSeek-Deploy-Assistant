import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';

import { tcpConnect } from './port';
import type { ProcessInfo } from './qqnt';

/**
 * 探测器的"真实世界"依赖。全部集中在这里，是为了让 detect/* 保持纯函数、可被单测穷举。
 *
 * 进程枚举走 WMI（Win32_Process）：需要 ExecutablePath/CommandLine 才能判断"是不是我们这个安装目录的
 * SnowLuma"，`tasklist` 只给名字，会把整机 node.exe 都算进来（见专项报告 §8 的坑）。
 */

export interface DetectionDeps {
  exists(path: string): Promise<boolean>;
  readJson(path: string): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  listProcesses(): Promise<ProcessInfo[]>;
  connect(host: string, port: number, timeoutMs: number): Promise<boolean>;
  getJson(
    url: string,
    init: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ status: number; body: unknown }>;
}

const PROCESS_QUERY =
  "$ErrorActionPreference='Stop';Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";

interface RawProcess {
  ProcessId?: unknown;
  ExecutablePath?: unknown;
  CommandLine?: unknown;
}

export function parseProcessList(raw: unknown): ProcessInfo[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: ProcessInfo[] = [];
  for (const item of items) {
    const typed = item as RawProcess;
    if (typeof typed?.ProcessId !== 'number') continue;
    out.push({
      pid: typed.ProcessId,
      exePath: typeof typed.ExecutablePath === 'string' ? typed.ExecutablePath : undefined,
      cmdline: typeof typed.CommandLine === 'string' ? typed.CommandLine : undefined,
    });
  }
  return out;
}

export async function listWindowsProcesses(timeoutMs = 15_000): Promise<ProcessInfo[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, out) => {
        if (error) reject(error);
        else resolve(out);
      },
    );
  });
  const text = stdout.trim();
  if (!text) return [];
  return parseProcessList(JSON.parse(text) as unknown);
}

export function createNodeDetectionDeps(): DetectionDeps {
  return {
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async readJson(path) {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    },
    readdir: (path) => readdir(path),
    listProcesses: () => listWindowsProcesses().catch(() => []),
    connect: tcpConnect,
    async getJson(url, init) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 2000);
      try {
        const response = await fetch(url, { headers: init.headers, signal: controller.signal });
        const text = await response.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          // 非 JSON 响应保留原文，交由上层判定（错误信息里会被脱敏）。
        }
        return { status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function readSetCookie(headers: Headers): string[] | undefined {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof withGetSetCookie.getSetCookie === 'function' ? withGetSetCookie.getSetCookie() : undefined;
  if (list && list.length > 0) return list;
  const single = headers.get('set-cookie');
  return single ? [single] : undefined;
}

async function request(
  method: 'GET' | 'POST',
  url: string,
  init: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<{ status: number; body: unknown; setCookie?: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 2500);
  try {
    const response = await fetch(url, {
      method,
      // Harness 的 `/?token=` 是 303 + Set-Cookie：默认跟随重定向会把 cookie 丢掉，
      // 导致后面读插件状态时被判为 authentication_required。必须手动处理重定向。
      redirect: 'manual',
      headers: {
        ...(init.headers ?? {}),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // 非 JSON（例如 HTML 登录页）保留原文，交上层判定。
    }
    return { status: response.status, body, setCookie: readSetCookie(response.headers) };
  } finally {
    clearTimeout(timer);
  }
}

/** 供个人 QQ 探测使用：需要 `Set-Cookie`（Harness 会话 cookie）。 */
export function createNodeBridgeDeps() {
  return {
    get: (url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }) => request('GET', url, init ?? {}),
    post: (url: string, init?: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number }) =>
      request('POST', url, init ?? {}),
  };
}