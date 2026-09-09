import { describe, expect, it } from 'vitest';
import { drawingSymbol } from '../annotation/symbols.js';
import {
  DEFAULT_TITLE_BLOCK_FIELDS,
  createTitleBlock,
  formatDrawingScale,
} from './titleBlock.js';

describe('表題欄', () => {
  it('A3横の内枠右下へ180×56で置く', () => {
    expect(createTitleBlock({ paper: 'A3-landscape' })).toMatchObject({
      left: 230, bottom: 10, right: 410, top: 66, width: 180, height: 56,
    });
  });
  it('A4縦にも幅180のまま入る', () => {
    expect(createTitleBlock({ paper: 'A4-portrait' })).toMatchObject({ left: 20, right: 200, width: 180 });
  });
  it('既定の項目は10個', () => expect(DEFAULT_TITLE_BLOCK_FIELDS).toHaveLength(10));
  it('項目を差し替えられる', () => {
    const fields = [{ key: 'custom', label: '任意', fixedText: '固定' }];
    expect(createTitleBlock({ paper: 'A3-landscape', fields })?.fields[0]?.field).toBe(fields[0]);
  });
  it.each([[1, '1:1'], [0.5, '1:2'], [2, '2:1']] as const)('縮尺%sを%sと書く', (scale, text) => {
    expect(formatDrawingScale(scale)).toBe(text);
  });
  it('第三角法記号は共通定義の二重円と円錐台を使う', () => {
    const symbol = createTitleBlock({ paper: 'A3-landscape' })?.symbol;
    expect(symbol).toEqual(drawingSymbol('thirdAngle', 3.5, [392, 38]));
    expect(symbol?.lines).toHaveLength(4);
    expect(symbol?.arcs).toHaveLength(4);
    expect(symbol?.centerLines).toHaveLength(2);
  });
  it('入らない幅はnull', () => expect(createTitleBlock({ paper: 'A4-portrait', widthMm: 191 })).toBeNull());
  it('不正な縮尺は疑問符', () => expect(formatDrawingScale(0)).toBe('？'));
});
