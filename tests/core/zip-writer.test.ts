import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';

import { buildZip, crc32, writeZip } from '@dda/core';

function readZip(file: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const out: Record<string, string> = {};
    yauzl.open(file, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('open failed'));
        return;
      }
      zipfile.on('entry', (entry: yauzl.Entry) => {
        zipfile.openReadStream(entry, (e, stream) => {
          if (e || !stream) {
            reject(e ?? new Error('stream failed'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out[entry.fileName] = Buffer.concat(chunks).toString('utf8');
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => resolve(out));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

describe('ZIP 写入器（无外部依赖）', () => {
  it('生成的 zip 可被 yauzl 正确读回（含中文与多级目录）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-zip-'));
    const file = join(dir, 'out.zip');
    await writeZip(file, [
      { name: '01-system.txt', content: '系统信息\nHello' },
      { name: 'nested/02-runtime.txt', content: 'dsh 0.2.0-rc.2' },
      { name: 'empty.txt', content: '' },
    ]);

    const entries = await readZip(file);
    expect(Object.keys(entries).sort()).toEqual(['01-system.txt', 'empty.txt', 'nested/02-runtime.txt']);
    expect(entries['01-system.txt']).toContain('系统信息');
    expect(entries['nested/02-runtime.txt']).toBe('dsh 0.2.0-rc.2');
    expect(entries['empty.txt']).toBe('');
  });

  it('CRC32 与已知值一致', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('空条目列表也产出合法 zip（仅 EOCD）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dda-zip-empty-'));
    const file = join(dir, 'empty.zip');
    const { bytes } = await writeZip(file, []);
    expect(bytes).toBe(22);
    const buf = await readFile(file);
    expect(buf.readUInt32LE(0)).toBe(0x06054b50);
    expect(await readZip(file)).toEqual({});
  });

  it('单个 zip 的字节数可预测（STORE 无压缩）', () => {
    const zip = buildZip([{ name: 'a.txt', content: 'abc' }]);
    // 30 (local) + 5 (name) + 3 (data) + 46 (central) + 5 (name) + 22 (EOCD)
    expect(zip.length).toBe(111);
  });
});
