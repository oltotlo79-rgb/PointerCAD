import { describe, expect, it } from 'vitest';
import { holeTable, type HoleTableInput } from './holeTable.js';
import { revisionTable } from './revisionTable.js';

const input: HoleTableInput = {
  position: [20, 200], bounds: { left: 10, bottom: 10, right: 410, top: 287 },
  headings: { symbol: 'Symbol', x: 'X', y: 'Y', diameter: 'Diameter', depth: 'Depth' },
  rows: [
    { id: 'hole-a', symbol: 'A1', x: -10, y: 25.4, diameter: 5, depth: null },
    { id: 'hole-b', symbol: 'B1', x: 20, y: 0, diameter: 8, depth: 12 },
  ],
  formatLength: (value) => value.toFixed(1), throughText: 'THRU',
  measureText: (text, sizeMm) => ({ fontId: 'fixture', sizeMm, advanceMm: text.length * 1.5,
    inkBounds: { left: 0, bottom: 0, right: text.length * 1.5, top: sizeMm } }),
};

describe('穴表と改訂欄の実データ配置', () => {
  it('負の座標、直径、貫通と有限深さを区別して表示する', () => {
    const result = holeTable(input);
    expect(result?.rowIds).toEqual(['hole-a', 'hole-b']);
    expect(result?.texts.map((text) => text.text)).toEqual([
      'Symbol', 'X', 'Y', 'Diameter', 'Depth', 'A1', '-10.0', '25.4', 'φ5.0', 'THRU', 'B1', '20.0', '0.0', 'φ8.0', '12.0',
    ]);
  });
  it('行を並べ替えても引出線は行IDに対応する記号を保つ', () => {
    const result = holeTable({ ...input, rows: [...input.rows].reverse(),
      callouts: [{ rowId: 'hole-a', target: [70, 70], position: [90, 90] }] });
    expect(result?.rowIds).toEqual(['hole-b', 'hole-a']);
    expect(result?.callouts[0].rowId).toBe('hole-a');
    expect(result?.callouts[0].geometry.texts[0].text).toBe('A1');
  });
  it('消えた穴を指す引出線を別の穴へつなぎ替えない', () => {
    expect(holeTable({ ...input, rows: [input.rows[1]],
      callouts: [{ rowId: 'hole-a', target: [70, 70], position: [90, 90] }] })).toBeNull();
  });
  it('未解決の深さを貫通やゼロへ置き換えない', () => {
    expect(holeTable({ ...input, rows: [{ ...input.rows[0], depth: Number.NaN }] })).toBeNull();
  });
  it('同じ記号やIDの異なる穴は曖昧なので断る', () => {
    expect(holeTable({ ...input, rows: [input.rows[0], { ...input.rows[1], symbol: 'A1' }] })).toBeNull();
    expect(holeTable({ ...input, rows: [input.rows[0], { ...input.rows[1], id: 'hole-a' }] })).toBeNull();
  });
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])('不正な直径%sを帳票の寸法として出力しない', (diameter) => {
    expect(holeTable({ ...input, rows: [{ ...input.rows[0], diameter }] })).toBeNull();
  });
  it('元の穴データを並べ替えたり書き換えず、繰り返して同じ帳票を返す', () => {
    const before = JSON.stringify(input.rows);
    expect(holeTable(input)).toEqual(holeTable(input));
    expect(JSON.stringify(input.rows)).toBe(before);
  });
  it('改訂番号と指定日付を保ち、長い説明に合わせて行を伸ばす', () => {
    const result = revisionTable({ ...input,
      headings: { revision: 'Rev', date: 'Date', description: 'Description', approvedBy: 'Approved' },
      rows: [{ revision: 'C', date: '2026-08-01', description: 'A'.repeat(100), approvedBy: 'Design' }],
    });
    expect(result?.heightMm).toBeGreaterThan(16);
    const text = result?.texts.map((item) => item.text) ?? [];
    expect(text).toContain('C');
    expect(text).toContain('2026-08-01');
    expect(text).toContain('Design');
  });
  it('紙の外に続く改訂欄を黙って切り捨てない', () => {
    expect(revisionTable({ ...input, position: [20, 15],
      headings: { revision: 'Rev', date: 'Date', description: 'Description', approvedBy: 'Approved' },
      rows: [{ revision: 'C', date: '2026-08-01', description: 'Change', approvedBy: 'Design' }],
    })).toBeNull();
  });
});
