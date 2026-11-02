import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Redaction runs on every log line and again on every diagnostic section. It is name-driven
 * (`apiKey=…`, `DEEPSEEK_API_KEY=…`) plus a few well-known value shapes (`sk-…`, auth headers),
 * so a credential whose field name we did not anticipate is still caught by its name.
 */
const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;)\]}"']+)`;
/**
 * Credential field names. The optional `[A-Za-z0-9]*[_-]` prefix makes `QQBOT_SECRET` and
 * `deepseek_api_key` match, while the look-behind/look-ahead keep `monkey=`, `hotkey=` and
 * `keyboard:` from being treated as credentials.
 */
const NAME = String.raw`(?<![A-Za-z0-9])(?:[A-Za-z0-9]*[_-])?(?:api[_-]?key|apikey|app[_-]?secret|appsecret|key|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|password|passwd|pwd|credential|authorization)s?(?![A-Za-z0-9])`;
const JSON_NAME = String.raw`"([^"\\]*(?:key|secret|token|password|passwd|credential)s?)"`;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  // Auth schemes keep the scheme word but lose the credential.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // name=value / name: value (env vars, .env lines, query strings, YAML)
  [new RegExp(String.raw`(${NAME})(\s*[:=]\s*)` + VALUE, 'gi'), '$1$2[redacted]'],
  // "name": "value" (JSON, which is how the plugin/task sections are serialised)
  [new RegExp(JSON_NAME + String.raw`\s*:\s*` + VALUE, 'gi'), '"$1": "[redacted]"'],
];

export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
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