import { describe, expect, it } from 'vitest';
import { parameterTable } from './parameterTable.js';

const input: Parameters<typeof parameterTable>[0] = {
  position: [20, 120],
  bounds: { left: 10, bottom: 10, right: 190, top: 140 },
  headings: { name: '名前', value: '値', unit: '単位', description: '説明' },
  rows: Object.freeze([
    { name: '板厚', value: '2.50', unit: 'mm', description: '板の厚さ' },
    { name: 'a', value: '0', unit: '', description: '' },
    { name: '傾き', value: '-12', unit: '°', description: '基準角' },
  ]),
  rowHeightMm: 9,
  textHeightMm: 3,
  measureText: (text, sizeMm) => ({
    fontId: 'fixture', sizeMm, advanceMm: text.length * 2,
    inkBounds: { left: 0, bottom: 0, right: text.length * 2, top: sizeMm },
  }),
};

describe('係数の表', () => {
  it('名前順に四つの欄を置き、値の表記と元の行順を保つ', () => {
    const geometry = parameterTable(input);
    expect(geometry?.texts.map((item) => item.text)).toEqual([
      '名前', '値', '単位', '説明',
      'a', '0', '', '',
      '傾き', '-12', '°', '基準角',
      '板厚', '2.50', 'mm', '板の厚さ',
    ]);
    expect(input.rows.map((row) => row.name)).toEqual(['板厚', 'a', '傾き']);
  });

  it('空の表でも指定位置から見出し一行を描き、値は右、単位は中央に揃える', () => {
    const geometry = parameterTable({ ...input, rows: [] });
    expect(geometry?.rowHeights).toEqual([9]);
    expect(geometry?.texts.map(({ text, anchor, position, sizeMm }) => [text, anchor, position, sizeMm])).toEqual([
      ['名前', 'start', [21, 115.5], 3], ['値', 'end', [79, 115.5], 3],
      ['単位', 'middle', [89, 115.5], 3], ['説明', 'start', [99, 115.5], 3],
    ]);
  });

  it('共通の表配置で説明の改行を測り、用紙の下端を越えると断る', () => {
    const rows = [{ name: 'a', value: '1', unit: 'mm', description: '一行目\n二行目\n三行目' }];
    const geometry = parameterTable({ ...input, rows });
    expect(geometry?.texts.slice(-3).map((item) => item.text)).toEqual(['一行目', '二行目', '三行目']);
    // 文字高さ3が3行、行間は4.2、上下の余白の合計は2。
    expect(geometry?.rowHeights[1]).toBeCloseTo(13.4, 12);
    expect(parameterTable({ ...input, rows, position: [20, 32] })).toBeNull();
    expect(parameterTable({ ...input, measureText: () => null })).toBeNull();
  });
});
