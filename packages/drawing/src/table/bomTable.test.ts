import { describe, expect, it } from 'vitest';
import { bomTable, type BomTableInput } from './bomTable.js';

const input: BomTableInput = {
  position: [20, 200], bounds: { left: 10, bottom: 10, right: 287, top: 410 },
  headings: { number: 'No', name: 'Name', quantity: 'Qty', material: 'Material', mass: 'Mass', configuration: 'Configuration' },
  rows: [{ rowKey: 'a', number: 1, name: 'Part A', quantity: 2, materialName: 'Al', massEach: 10 },
    { rowKey: 'b', number: 2, name: 'Part B', quantity: 3, materialName: 'Fe', massEach: 20 }],
  formatMass: (value) => value.toFixed(1), unknownMassText: '?',
  measureText: (text, sizeMm) => ({ fontId: 'fixture', sizeMm, advanceMm: text.length * 2,
    inkBounds: { left: 0, bottom: 0, right: text.length * 2, top: sizeMm } }),
};
describe('P7の部品表行を図面へ並べる', () => {
  it('既定5列を使う', () => { expect(bomTable(input)?.columnIds).toEqual(['number', 'name', 'quantity', 'material', 'mass']); });
  it('指定した3列と順序を保つ', () => { expect(bomTable({ ...input, columns: ['name', 'number', 'mass'] })?.columnIds).toEqual(['name', 'number', 'mass']); });
  it('下から上では番号1を最下行へ置く', () => { expect(bomTable(input)?.rowKeys).toEqual(['b', 'a']); });
  it('上から下では番号1を先頭へ置く', () => { expect(bomTable({ ...input, direction: 'topToBottom' })?.rowKeys).toEqual(['a', 'b']); });
  it('数量を含めて質量を合計する', () => { expect(bomTable(input)?.totalMass).toBe(80); });
  it('部品追加と数量変更を次の入力から反映する', () => {
    const result = bomTable({ ...input, rows: [{ ...input.rows[0], quantity: 4 }, input.rows[1], { ...input.rows[0], rowKey: 'c', number: 3, quantity: 1 }] });
    expect(result?.rowKeys).toHaveLength(3); expect(result?.totalMass).toBe(110);
  });
  it('空の部品表は見出しだけ、質量0', () => { const result = bomTable({ ...input, rows: [] }); expect(result?.heightMm).toBe(8); expect(result?.totalMass).toBe(0); });
  it('質量不明の行を0gと表示しない', () => {
    const result = bomTable({ ...input, rows: [{ ...input.rows[0], massEach: null }] });
    expect(result?.totalMass).toBeNull(); expect(result?.texts.some((text) => text.text === '?')).toBe(true);
  });
  it('数量列と質量列を右揃えにする', () => {
    const result = bomTable({ ...input, direction: 'topToBottom' });
    expect(result?.texts[7].anchor).toBe('end'); expect(result?.texts[9].anchor).toBe('end');
  });
  it('並べ替えても部品番号そのものは採番し直さない', () => {
    const result = bomTable({ ...input, direction: 'topToBottom', sortBy: 'name', sortDescending: true });
    expect(result?.rowKeys).toEqual(['b', 'a']); expect(result?.texts[5].text).toBe('2');
  });
  it('同じ番号を複数の部品へ割り当てない', () => { expect(bomTable({ ...input, rows: [input.rows[0], { ...input.rows[1], number: 1 }] })).toBeNull(); });
  it('重複列を断る', () => { expect(bomTable({ ...input, columns: ['number', 'number'] })).toBeNull(); });
  it('入らない大きさの表を断る', () => { expect(bomTable({ ...input, position: [250, 200] })).toBeNull(); });
  it('入力を変えず同じ結果を返す', () => { const rows = [...input.rows]; expect(bomTable(input)).toEqual(bomTable(input)); expect(input.rows).toEqual(rows); });
});
