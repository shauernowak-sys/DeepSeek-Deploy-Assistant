import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SnowLumaManifestSchema, type SnowLumaManifest } from '@dda/spec';

/**
 * 组件清单的读取与校验。
 *
 * 清单是"我们允许装什么、从哪装、什么哈希、什么许可"的唯一出处；
 * 校验失败必须整份拒绝（对齐 PRD §10.2："坏索引被整份拒绝"）。
 */
export const SNOWLUMA_MANIFEST_FILE = 'snowluma.json';

export function parseSnowLumaManifest(raw: unknown): SnowLumaManifest {
  return SnowLumaManifestSchema.parse(raw);
}

export async function loadSnowLumaManifest(manifestsDir: string): Promise<SnowLumaManifest> {
  const text = await readFile(join(manifestsDir, SNOWLUMA_MANIFEST_FILE), 'utf8');
  return parseSnowLumaManifest(JSON.parse(text) as unknown);
}
