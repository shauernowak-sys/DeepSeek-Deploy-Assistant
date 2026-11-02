/**
 * License gate (CI + pre-package).
 *
 * Rule (PRD §12/§14, 01 §11.6): anything UNLICENSED, without a license field and without a
 * bundled LICENSE file, or on the deny list must not be redistributed by us.
 *
 * Production dependency closure is taken from `pnpm list --prod --depth Infinity --json`,
 * then each package's license is resolved from its own package.json / LICENSE file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Python-2.0',
  'Unicode-3.0',
]);

const DENY = [/^UNLICENSED$/i, /^SEE LICENSE IN/i, /^NOASSERTION$/i];

function pnpmCmd() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function productionClosure() {
  // `.cmd` shims cannot be spawned without a shell on Windows; the command string is fixed
  // and contains no external input, so this is safe for a build script.
  const isWin = process.platform === 'win32';
  const raw = isWin
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm list --prod --depth Infinity --json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  const roots = JSON.parse(raw);
  const found = new Map();
  const walk = (node) => {
    if (!node || !node.dependencies) return;
    for (const [name, info] of Object.entries(node.dependencies)) {
      const key = `${name}@${info.version ?? '?'}`;
      if (!found.has(key)) found.set(key, { name, version: info.version });
      walk(info);
    }
  };
  for (const root of roots) walk(root);
  return [...found.values()];
}

function findPackageDir(name, version) {
  const candidates = [
    join('node_modules', name),
    ...safeReaddir('node_modules/.pnpm')
      .filter((entry) => entry.startsWith(`${name.replace('/', '+')}@`) || entry.startsWith(`${name}@`))
      .map((entry) => join('node_modules', '.pnpm', entry, 'node_modules', name)),
  ];
  for (const dir of candidates) {
    const pkg = join(dir, 'package.json');
    if (!existsSync(pkg)) continue;
    if (!version) return dir;
    try {
      if (JSON.parse(readFileSync(pkg, 'utf8')).version === version) return dir;
    } catch {
      /* ignore */
    }
  }
  return candidates.find((dir) => existsSync(join(dir, 'package.json')));
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function detectLicense(dir) {
  if (!dir) return { license: undefined, source: 'missing-package' };
  let license;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
    if (license) return { license, source: 'package.json' };
  } catch {
    /* fall through to LICENSE files */
  }
  const files = safeReaddir(dir).filter((f) => /^(LICEN[CS]E|COPYING)/i.test(f));
  if (files.length > 0) {
    const text = readFileSync(join(dir, files[0]), 'utf8').slice(0, 4000).toLowerCase();
    if (text.includes('apache license')) return { license: 'Apache-2.0(from file)', source: files[0] };
    if (text.includes('mit license') || text.includes('permission is hereby granted')) {
      return { license: 'MIT(from file)', source: files[0] };
    }
    if (text.includes('isc license')) return { license: 'ISC(from file)', source: files[0] };
    return { license: `UNKNOWN-file:${files[0]}`, source: files[0] };
  }
  return { license: undefined, source: 'no-license' };
}

const closure = productionClosure();
const problems = [];
const summary = new Map();

for (const { name, version } of closure) {
  const dir = findPackageDir(name, version);
  const { license, source } = detectLicense(dir);
  const normalized = (license ?? '(none)').replace(/\(from file\)$/, '').trim();
  summary.set(normalized, (summary.get(normalized) ?? 0) + 1);

  if (!license) {
    problems.push({ name, version, reason: 'no license field and no LICENSE file', source });
    continue;
  }
  if (DENY.some((re) => re.test(license))) {
    problems.push({ name, version, reason: `denied license: ${license}`, source });
    continue;
  }
  if (!ALLOWED.has(normalized)) {
    problems.push({ name, version, reason: `review required: ${license}`, source });
  }
}

console.log(`[license-gate] production packages: ${closure.length}`);
for (const [license, count] of [...summary.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${license}`);
}

if (problems.length > 0) {
  console.error('\n[license-gate] BLOCKED packages:');
  for (const p of problems) console.error(`  - ${p.name}@${p.version}: ${p.reason} (${p.source})`);
  console.error('\nFix: replace the dependency, or add it to the reviewed allowlist with rationale.');
  process.exit(1);
}

console.log('\n[license-gate] OK');
