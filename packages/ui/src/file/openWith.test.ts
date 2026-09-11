import { describe, expect, it, vi } from 'vitest';
import { CAM_TOOL_URLS, isAllowedCamUrl, isCamFormat, openCamWebsite, openWith } from './openWith.js';
import { HELP_LOADERS } from '../help/helpContent.js';
describe('保存済みファイルの形式に合う加工先だけを案内する', () => {
  it('加工手順の全Webリンクは固定許可表にあり、余分な情報を足したURLは拒否する', async () => {
    const markdown = await HELP_LOADERS['cam']();
    const urls = [...markdown.matchAll(/\]\((https:[^)]+)\)/gu)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThanOrEqual(8);
    for (const url of urls) {
      expect(isAllowedCamUrl(url), url).toBe(true);
      expect(isAllowedCamUrl(`${url}#part-data`)).toBe(false);
      expect(isAllowedCamUrl(`${url}&name=private`)).toBe(false);
    }
    expect(isAllowedCamUrl('file:///tmp/part.stl')).toBe(false);
    expect(isAllowedCamUrl('https://grid.space.evil.example/kiri/')).toBe(false);
  });
  it('STEPは同梱手順からFreeCAD/Fusionへ案内し、Kiriへ渡さない', () => {
    expect(openWith('step', false)).toEqual(['help']);
    expect(openWith('step', true)).toEqual(['default', 'help']);
  });
  it.each(['stl', '3mf'])('%sではKiriとスライサーの公式サイトを案内する', (format) => {
    expect(openWith(format, false)).toEqual(['kiri', 'prusa', 'help']);
    expect(openWith(format, true)).toEqual(['default', 'kiri', 'prusa', 'help']);
  });
  it.each(['obj', 'glb', 'dxf', 'pcad', 'dwg'])('%sには入口を出さない', (format) => {
    expect(isCamFormat(format)).toBe(false);
    expect(openWith(format, true)).toEqual([]); expect(openWith(format, false)).toEqual([]);
  });
  it('明示クリックで固定HTTPSの新しいタブだけを開き、ファイル名やデータを送らない', () => {
    const open = vi.fn<(url: string, target: string, features: string) => void>();
    expect(open).not.toHaveBeenCalled();
    openCamWebsite('kiri', open);
    expect(open).toHaveBeenCalledExactlyOnceWith('https://grid.space/kiri/', '_blank', 'noopener,noreferrer');
    for (const url of Object.values(CAM_TOOL_URLS)) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:'); expect(parsed.search).toBe(''); expect(parsed.hash).toBe('');
    }
  });
});
