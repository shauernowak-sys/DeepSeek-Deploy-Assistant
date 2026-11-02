/**
 * Writes the Windows version resource (FileVersion / ProductVersion and the version strings) into
 * the packaged executable.
 *
 * Electron Builder would do this itself when `win.signAndEditExecutable` is enabled, but enabling
 * that also pulls in the winCodeSign toolchain, whose archive cannot be extracted without
 * administrator rights (it contains symlinks). Editing the resource with `resedit` (pure JS, MIT)
 * keeps the build unprivileged and deterministic while producing the same version information.
 *
 * Usage: node scripts/set-win-version.mjs   (after `electron-builder --dir`)
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

const root = process.cwd();
const PRODUCT_NAME = 'DeepSeek Deploy Assistant';

/** Windows wants "a.b.c.d" (Electron Builder applies the same transformation). */
export function windowsVersion(version) {
  const parts = version
    .split('-')[0]
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const exePath = join(root, 'release', 'win-unpacked', `${PRODUCT_NAME}.exe`);
if (!existsSync(exePath)) throw new Error(`packaged executable not found: ${exePath}`);

const version = pkg.version;
const productVersion = windowsVersion(version);

const exe = NtExecutable.from(await readFile(exePath));
const resources = NtExecutableResource.from(exe);
const infos = Resource.VersionInfo.fromEntries(resources.entries);
if (infos.length !== 1) throw new Error(`expected exactly one version resource, found ${infos.length}`);
const info = infos[0];

const languages = info.getAllLanguagesForStringValues();
if (languages.length !== 1) throw new Error('expected exactly one version language');
const language = languages[0];

info.setFileVersion(version);
info.setProductVersion(productVersion);
info.setStringValues(language, {
  CompanyName: pkg.author ?? '',
  FileDescription: pkg.description ?? PRODUCT_NAME,
  FileVersion: version,
  InternalName: PRODUCT_NAME,
  LegalCopyright: pkg.copyright ?? '',
  OriginalFilename: `${PRODUCT_NAME}.exe`,
  ProductName: PRODUCT_NAME,
  ProductVersion: productVersion,
});

info.outputToResourceEntries(resources.entries);
resources.outputResource(exe);
await writeFile(exePath, Buffer.from(exe.generate()));

console.log(`[set-win-version] ${exePath} -> FileVersion=${version} ProductVersion=${productVersion}`);