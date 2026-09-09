import { describe, expect, it } from 'vitest';
import { tableLayout, type TableLayoutInput } from './tableLayout.js';

const input: TableLayoutInput = {
  position: [20, 200], columns: Array.from({ length: 5 }, (_, index) => ({ heading: String(index), widthMm: 20 })),
  rows: Array.from({ length: 10 }, () => ['a', 'b', 'c', 'd', 'e']),
  bounds: { left: 10, bottom: 10, right: 287, top: 410 },
  measureText: (text, sizeMm) => ({ fontId: 'fixture', sizeMm, advanceMm: text.length * 2,
    inkBounds: { left: 0, bottom: 0, right: text.length * 2, top: sizeMm } }),
};
describe('実文字幅と用紙境界を使う表', () => {
  it('5列10行に見出しを加え、横12本・縦6本を描く', () => {
    const result = tableLayout(input);
    expect(result?.lines.filter((line) => line.from[1] === line.to[1])).toHaveLength(12);
    expect(result?.lines.filter((line) => line.from[0] === line.to[0])).toHaveLength(6);
    expect(result?.heightMm).toBe(88); expect(result?.widthMm).toBe(100);
  });
  it('外枠4本だけが0.5mm、内側14本は0.25mm', () => {
    expect(tableLayout(input)?.lines.filter((line) => line.widthMm === 0.5)).toHaveLength(4);
    expect(tableLayout(input)?.lines.filter((line) => line.widthMm === 0.25)).toHaveLength(14);
  });
  it('左端から1mm、行の中央に文字を置く', () => { expect(tableLayout(input)?.texts[0].position).toEqual([21, 196]); });
  it('右揃えの墨の右端を枠から1mm空ける', () => {
    const result = tableLayout({ ...input, columns: [{ heading: '123', widthMm: 20, align: 'end' }], rows: [] });
    expect(result?.texts[0]).toMatchObject({ anchor: 'end', position: [39, 196] });
  });
  it('字数で縮小せず列幅の中で折り返す', () => {
    const result = tableLayout({ ...input, columns: [{ heading: 'abcdef', widthMm: 8 }], rows: [] });
    expect(result?.texts.map((text) => text.text)).toEqual(['abc', 'def']);
    expect(result?.heightMm).toBeCloseTo(10.4, 10);
    expect(result?.texts.every((text) => text.sizeMm === 3.5)).toBe(true);
  });
  it('高い字体の実際の墨が枠へ接触しない行高になる', () => {
    const result = tableLayout({ ...input, rows: [], measureText: (text, sizeMm) => ({ fontId: 'tall', sizeMm, advanceMm: text.length,
      inkBounds: { left: 0, bottom: -5, right: text.length, top: 6 } }) });
    expect(result?.heightMm).toBe(13);
  });
  it('行が0でも見出しの8mmを残す', () => { expect(tableLayout({ ...input, rows: [] })?.heightMm).toBe(8); });
  it('下端が用紙の境界と一致する表は入る', () => { expect(tableLayout({ ...input, position: [20, 98] })?.heightMm).toBe(88); });
  it('下へ0.1mmはみ出す表は断る', () => { expect(tableLayout({ ...input, position: [20, 97.9] })).toBeNull(); });
  it('右へはみ出す表は断る', () => { expect(tableLayout({ ...input, position: [200, 200] })).toBeNull(); });
  it('列数の異なる行を切り捨てない', () => { expect(tableLayout({ ...input, rows: [['a']] })).toBeNull(); });
  it('字体未読込を無幅の表にしない', () => { expect(tableLayout({ ...input, measureText: () => null })).toBeNull(); });
  it('1文字が列幅を超えたら欠落させず断る', () => { expect(tableLayout({ ...input, columns: [{ heading: 'a', widthMm: 3 }], rows: [] })).toBeNull(); });
  it('同じ入力は同じ配置で、入力の行を変えない', () => { const before = input.rows.map((row) => [...row]); expect(tableLayout(input)).toEqual(tableLayout(input)); expect(input.rows).toEqual(before); });
});
