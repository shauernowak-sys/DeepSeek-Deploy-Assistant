import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import type { PluginState, TaskSummary } from '@dda/spec';

import { redact } from '../logging/logger';
import { fileExists } from '../transfer/fs-utils';

export interface DiagnosticInputs {
  generatedAt: string;
  appVersion: string;
  os: { caption: string; arch: string; admin: boolean };
  runtime: {
    node?: string;
    pnpm?: string;
    dsh?: string;
    profile?: string;
    profileExists: boolean;
  };
  plugins: PluginState[];
  task?: TaskSummary;
  network: NetworkSummary;
  /** Absolute paths of log files to tail (newest first). */
  logFiles: string[];
  homeDir: string;
  dataDir: string;
}

export interface NetworkSummary {
  items: { target: string; url: string; ok: boolean; status?: number; millis?: number; error?: string }[];
  generatedAt: string;
}

export interface DiagnosticSection {
  name: string;
  description: string;
  content: string;
}

const USER_PLACEHOLDER = '<user>';
const REDACTED = '[redacted]';

/**
 * Aggressive sanitisation: secrets, tokens, app ids, QQ ids, home path. Runs before anything is
 * zipped and again in the preview, so both surfaces show identical bytes.
 *
 * An empty/short `homeDir` must be tolerated: `replaceAll('')` would interleave the placeholder
 * between every character and destroy the whole report, so path redaction is skipped instead.
 */
export function sanitize(text: string, homeDir: string): string {
  let out = redact(text);

  const home = homeDir.trim().replace(/[\\/]+$/, '');
  if (home.length >= 3) {
    const user = home.split(/[\\/]/).pop() ?? '';
    const variants = new Set([
      home,
      home.replace(/\\/g, '/'),
      home.replace(/\//g, '\\'),
      // JSON sections serialise a Windows path with doubled backslashes.
      home.replace(/\\/g, '\\\\'),
    ]);
    for (const variant of variants) {
      if (variant.length >= 3) out = out.split(variant).join(USER_PLACEHOLDER);
    }
    if (user.length >= 3) out = out.split(user).join(USER_PLACEHOLDER);
  }

  // QQ bot appId (6-10 digits) — the value identifies the tenant, so only the name survives.
  out = out.replace(/\b(app[_-]?id)\b\s*[:=]\s*["']?\d{4,}["']?/gi, `$1=${REDACTED}`);
  // QQ account / group / channel identifiers, including the 5-8 digit ranges the old
  // "9+ digits" rule used to miss.
  out = out.replace(
    /\b(qq|uin|openid|unionid|group[_-]?id|group[_-]?code|guild[_-]?id|channel[_-]?id|user[_-]?id|member[_-]?openid)\b\s*[:：=]?\s*["']?([0-9A-Za-z_-]{4,})/gi,
    `$1=${REDACTED}`,
  );
  out = out.replace(/\b\d{9,}\b/g, '<digits>');
  return out;
}

async function tail(path: string, bytes = 32 * 1024): Promise<string> {
  const info = await stat(path);
  const start = Math.max(0, info.size - bytes);
  const buf = await readFile(path);
  return buf.subarray(start).toString('utf8');
}

export async function listDirSafe(dir: string, depth = 2): Promise<string[]> {
  if (!(await fileExists(dir))) return [];
  const out: string[] = [];
  const walk = async (current: string, level: number): Promise<void> => {
    if (level > depth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      out.push(relative(dir, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await walk(full, level + 1);
    }
  };
  await walk(dir, 1);
  return out.sort();
}

/**
 * Builds the human-readable sections that will be zipped. The same list is shown to the user
 * for confirmation before export, so it must never contain secrets at this stage.
 */
export async function buildDiagnosticSections(input: DiagnosticInputs): Promise<DiagnosticSection[]> {
  const sanitizeAll = (s: string) => sanitize(s, input.homeDir);
  const profileDir = input.runtime.profile ?? '';
  const sections: DiagnosticSection[] = [];

  sections.push({
    name: '01-system.txt',
    description: '系统与软件版本',
    content: sanitizeAll(
      [
        `生成时间: ${input.generatedAt}`,
        `软件版本: ${input.appVersion}`,
        `操作系统: ${input.os.caption}`,
        `架构: ${input.os.arch}`,
        `管理员: ${input.os.admin ? 'yes' : 'no'}`,
        `数据目录: ${input.dataDir}`,
      ].join('\n'),
    ),
  });

  sections.push({
    name: '02-runtime.txt',
    description: '运行时与 Harness 版本',
    content: sanitizeAll(
      [
        `Node.js: ${input.runtime.node ?? '未安装'}`,
        `pnpm: ${input.runtime.pnpm ?? '未安装'}`,
        `Harness(dsh): ${input.runtime.dsh ?? '未安装'}`,
        `Profile: ${profileDir || 'n/a'} (${input.runtime.profileExists ? '存在' : '不存在'})`,
      ].join('\n'),
    ),
  });

  const profileFiles = await listDirSafe(profileDir, 2);
  sections.push({
    name: '03-profile.txt',
    description: 'Profile 目录结构（不含文件内容）',
    content: sanitizeAll(
      [`目录: ${profileDir}`, `条目数: ${profileFiles.length}`, ...profileFiles.slice(0, 200)].join('\n'),
    ),
  });

  sections.push({
    name: '04-plugins.json',
    description: '插件安装状态',
    content: sanitizeAll(JSON.stringify(input.plugins, null, 2)),
  });

  sections.push({
    name: '05-task.json',
    description: '最近部署任务状态',
    content: sanitizeAll(JSON.stringify(input.task ?? { note: '无任务记录' }, null, 2)),
  });

  sections.push({
    name: '06-network.txt',
    description: '网络检测摘要（不含任何凭据）',
    content: sanitizeAll(
      [
        `检测时间: ${input.network.generatedAt}`,
        ...input.network.items.map(
          (i) =>
            `${i.ok ? 'OK ' : 'FAIL'} ${i.target}  status=${i.status ?? '-'}  ${i.millis ?? '-'}ms  ${i.error ?? ''}  ${i.url}`,
        ),
      ].join('\n'),
    ),
  });

  const logParts: string[] = [];
  const homeForHeader = input.homeDir.trim();
  for (const file of input.logFiles.slice(0, 3)) {
    try {
      const label = homeForHeader ? relative(homeForHeader, file) : basename(file);
      logParts.push(`===== ${label} =====\n${await tail(file)}`);
    } catch {
      logParts.push(`===== ${basename(file)} (读取失败) =====`);
    }
  }
  sections.push({
    name: '07-logs.txt',
    description: '最近日志（最多 3 个文件，各取末尾 32 KB，已脱敏）',
    content: sanitizeAll(logParts.join('\n\n') || '无日志'),
  });

  return sections;
}

export function previewLines(sections: DiagnosticSection[]): string[] {
  return sections.map((s) => `${s.name} — ${s.description}（${Buffer.byteLength(s.content, 'utf8')} 字节）`);
}
