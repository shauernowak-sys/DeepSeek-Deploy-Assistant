import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { redact } from '@dda/core';

/** Milliseconds-safe, redacted one-liner: safe for a dialog, a log line and a diagnostic report. */
export function describeStartupError(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? String(error);
            } catch {
              return String(error);
            }
          })();
  const single = redact(raw).replace(/\s+/g, ' ').trim();
  return single.length > 600 ? `${single.slice(0, 600)}…` : single;
}

export interface StartupFailureRecord {
  /** Redacted summary shown to the user. */
  summary: string;
  /** Absolute path of the appended log entry, or undefined when even that failed. */
  logPath?: string;
}

/**
 * Appends a redacted failure record *before* the service container exists.
 * It must never throw: a startup failure has to end in a dialog, not in a second exception.
 */
export async function recordStartupFailure(
  dataDir: string,
  error: unknown,
  phase = 'startup',
): Promise<StartupFailureRecord> {
  const summary = describeStartupError(error);
  const logPath = join(dataDir, 'startup-error.log');
  const detail = error instanceof Error && error.stack ? error.stack : String(error);
  const line = `${new Date().toISOString()} [${phase}] ${redact(detail).replace(/\r?\n/g, ' | ')}\n`;
  try {
    await mkdir(dataDir, { recursive: true });
    await appendFile(logPath, line, 'utf8');
    return { summary, logPath };
  } catch {
    return { summary };
  }
}
