import { Socket } from 'node:net';

/** 只判断"能否建立 TCP 连接"。端口可连 ≠ 服务正常 ≠ 已联通（见 PRD §10.4 五段证据）。 */
export interface TcpProbeDeps {
  connect(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

export interface TcpProbeResult {
  reachable: boolean;
  /** 面向用户的证据行（不含任何凭据）。 */
  line: string;
}

export function tcpConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export const defaultTcpProbeDeps: TcpProbeDeps = { connect: tcpConnect };

export async function probeTcp(
  deps: TcpProbeDeps,
  target: { host?: string; port: number; label: string; timeoutMs?: number },
): Promise<TcpProbeResult> {
  const host = target.host ?? '127.0.0.1';
  const reachable = await deps.connect(host, target.port, target.timeoutMs ?? 1500).catch(() => false);
  return {
    reachable,
    line: `端口检测：${target.label} ${host}:${target.port} ${reachable ? '可连接' : '不可连接'}`,
  };
}
