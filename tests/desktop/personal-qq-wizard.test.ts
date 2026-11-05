import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('个人 QQ 引导', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('默认展示安装，四步依次为安装、环境检测、登录和连接', async () => {
    vi.stubGlobal('window', { dda: {} });
    const { PersonalQqPanel } = await import('../../apps/desktop/src/renderer/src/components/PersonalQqPanel');
    const html = renderToStaticMarkup(createElement(PersonalQqPanel));
    const positions = ['安装 SnowLuma', '环境检测', 'QQ 登录', '连接 Harness'].map((label) => html.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('第一步：下载与安装 SnowLuma');
    expect(html).not.toContain('第五步：消息测试');
    expect(html).toContain('选择文件夹');
  });
});
