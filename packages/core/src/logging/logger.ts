import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|appSecret["'\s:=]+[A-Za-z0-9]{8,}|QQBOT_SECRET=["']?[^"'\s]+)/g;

export function redact(input: string): string {
  return input.replace(SECRET_PATTERN, '[redacted]');
}

/** Append-only line logger. Never writes secrets: every line passes through `redact`. */
export class Logger {
  constructor(readonly filePath: string) {}

  static async create(dir: string, name: string): Promise<Logger> {
    const filePath = join(dir, name);
    await mkdir(dirname(filePath), { recursive: true });
    return new Logger(filePath);
  }

  info(scope: string, message: string): Promise<void> {
    return this.write('INFO', scope, message);
  }

  warn(scope: string, message: string): Promise<void> {
    return this.write('WARN', scope, message);
  }

  error(scope: string, message: string): Promise<void> {
    return this.write('ERROR', scope, message);
  }

  private async write(level: string, scope: string, message: string): Promise<void> {
    const line = `${new Date().toISOString()} ${level} [${scope}] ${redact(message)}\n`;
    await appendFile(this.filePath, line, 'utf8');
  }
}
