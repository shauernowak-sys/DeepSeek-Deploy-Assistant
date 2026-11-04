import { describe, expect, it } from 'vitest';

import {
  LICENSE_DIR,
  LICENSE_FILE_NAMES,
  licensesForClosure,
  npmLicenseFile,
  pickLicenseFile,
  renderLicenseIndex,
  requiredRuntimeFiles,
  runtimeLicenseFile,
  runtimeLicenseTargets,
} from '@dda/core';

describe('SEC-LIC 许可全文', () => {
  it('scoped 包名里的 `/` 不会进入文件名', () => {
    expect(npmLicenseFile('zod', '3.25.76')).toBe(`${LICENSE_DIR}/npm/zod@3.25.76.txt`);
    expect(npmLicenseFile('@deepseek-ai/dsh', '0.2.0-rc.2')).toBe(
      `${LICENSE_DIR}/npm/@deepseek-ai+dsh@0.2.0-rc.2.txt`,
    );
  });

  it('运行时组件的文件名与 node.json 的 textFile 口径一致', () => {
    expect(runtimeLicenseFile('node')).toBe('licenses/node-LICENSE.txt');
    expect(requiredRuntimeFiles()).toEqual([
      'licenses/dsh-LICENSE.txt',
      'licenses/node-LICENSE.txt',
      'licenses/pnpm-LICENSE.txt',
    ]);
  });

  it('按优先级挑许可文件，且不接受 NOTICE / README', () => {
    expect(pickLicenseFile(['README.md', 'LICENSE', 'NOTICE'])).toBe('LICENSE');
    expect(pickLicenseFile(['LICENSE.md', 'LICENSE'])).toBe('LICENSE');
    expect(pickLicenseFile(['NOTICE', 'README.md', 'index.js'])).toBeUndefined();
    // 变体命名（LICENSE-MIT.txt / COPYING.LESSER）仍可识别，但排在标准名之后
    expect(pickLicenseFile(['LICENSE-MIT.txt'])).toBe('LICENSE-MIT.txt');
    expect(pickLicenseFile(['COPYING.LESSER'])).toBe('COPYING.LESSER');
    expect(LICENSE_FILE_NAMES[0]).toBe('LICENSE');
  });

  it('闭包 → 全文目标：去重、排序、缺字段写 (none) 而不是静默丢包', () => {
    const targets = licensesForClosure([
      { name: 'react', version: '18.3.1', license: 'MIT' },
      { name: 'react', version: '18.3.1', license: 'MIT' },
      { name: 'argparse', version: '2.0.1', license: 'Python-2.0 ' },
      { name: 'mystery', version: '1.0.0' },
    ]);

    expect(targets.map((target) => target.file)).toEqual([
      'licenses/npm/argparse@2.0.1.txt',
      'licenses/npm/mystery@1.0.0.txt',
      'licenses/npm/react@18.3.1.txt',
    ]);
    expect(targets.every((target) => target.origin === 'product')).toBe(true);
    expect(targets.find((target) => target.package === 'mystery')?.license).toBe('(none)');
    expect(targets.find((target) => target.package === 'argparse')?.license).toBe('Python-2.0');
  });

  it('SPDX 别名归一后再进索引', () => {
    const targets = licensesForClosure([{ name: 'a', version: '1.0.0', license: 'mit license' }]);
    expect(targets[0]?.license).toBe('MIT');
  });

  it('索引是可 diff 的确定性输出，并说明被拒组件不在本目录', () => {
    const targets = [
      ...runtimeLicenseTargets([
        { id: 'node', package: 'node', version: '22.23.4', license: 'MIT' },
        { id: 'pnpm', package: 'pnpm', version: '11.28.5', license: 'MIT' },
        { id: 'harness', package: '@deepseek-ai/dsh', version: '0.2.0-rc.2', license: 'MIT' },
      ]),
      ...licensesForClosure([{ name: 'zod', version: '3.25.76', license: 'MIT' }]),
    ];

    const first = renderLicenseIndex(targets);
    const second = renderLicenseIndex([...targets].reverse());

    expect(first).toBe(second);
    expect(first).toContain('licenses:build');
    expect(first).toContain('| `node-LICENSE.txt` | node | 22.23.4 | MIT | Node.js 运行时 |');
    expect(first).toContain('| `npm/zod@3.25.76.txt` | zod | 3.25.76 | MIT | 本产品生产依赖 |');
    expect(first).toContain('UNLICENSED');
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/u); // 无时间戳，保证 CI 可 diff
  });
});
