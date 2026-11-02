import { DIAGNOSTICS, type ErrorCode } from '@dda/spec';

export interface DiagnosisRule {
  id: string;
  symptom: RegExp;
  code: ErrorCode;
}

/** Symptom text -> error code -> cause/action (see DIAGNOSTICS). */
export const RULES: DiagnosisRule[] = [
  { id: 'net-timeout', symptom: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i, code: 'E_DOWNLOAD_NETWORK' },
  { id: 'http-404', symptom: /HTTP 40[34]/i, code: 'E_DOWNLOAD_HTTP' },
  { id: 'hash', symptom: /sha256 mismatch/i, code: 'E_HASH_MISMATCH' },
  { id: 'zip-slip', symptom: /path traversal|absolute path in archive|符号链接/i, code: 'E_EXTRACT_UNSAFE_PATH' },
  { id: 'disk', symptom: /ENOSPC|no space left/i, code: 'E_DISK_FULL' },
  { id: 'spawn', symptom: /not in the command allowlist/i, code: 'E_SPAWN_DENIED' },
  { id: 'unsupported', symptom: /未列入白名单|不允许安装/i, code: 'E_VERSION_UNSUPPORTED' },
];

export interface Diagnosis {
  code: ErrorCode;
  cause: string;
  action: string;
  ruleId: string;
}

export function diagnose(message: string): Diagnosis | undefined {
  for (const rule of RULES) {
    if (rule.symptom.test(message)) {
      return { code: rule.code, ruleId: rule.id, ...DIAGNOSTICS[rule.code] };
    }
  }
  return undefined;
}
