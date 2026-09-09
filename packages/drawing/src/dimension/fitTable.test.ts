import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitTolerance, formatFit, FIT_SYMBOLS } from './fitTable.js';
import { FIT_ROWS } from './fitTableData.js';

describe('供給されたはめあい表の単位・境界・大文字小文字', () => {
  it('13区分14種類の全182組が供給JSONと一致する', () => {
    const source = JSON.parse(readFileSync(
      new URL('../../../../docs/standards/jis-drawing/fits-jis-b-0401.json', import.meta.url), 'utf8',
    )) as { unit: string; rows: Record<string, unknown>[] };
    expect(source.unit).toBe('μm');
    expect(FIT_ROWS).toHaveLength(13);
    expect(FIT_SYMBOLS).toHaveLength(14);
    expect(FIT_ROWS.length).toBe(source.rows.length);
    for (const [index, row] of source.rows.entries()) {
      for (const symbol of FIT_SYMBOLS) {
        const cell = row[symbol];
        if (typeof cell !== 'object' || cell === null) throw new Error('表のクラスがない');
        const upper = symbol.startsWith('H') ? ('ES' in cell ? cell.ES : undefined) : ('es' in cell ? cell.es : undefined);
        const lower = symbol.startsWith('H') ? ('EI' in cell ? cell.EI : undefined) : ('ei' in cell ? cell.ei : undefined);
        if (typeof upper !== 'number' || typeof lower !== 'number') throw new Error('上下の値がない');
        expect(fitTolerance(FIT_ROWS[index].upTo, symbol)).toEqual({ upper: upper / 1000, lower: lower / 1000 });
      }
    }
  });
  it('φ10H7は上+0.015mm、下0mm', () => {
    expect(fitTolerance(10, 'H7')).toEqual({ upper: 0.015, lower: 0 });
    expect(formatFit(10, 'H7')).toBe('φ10H7');
    expect(formatFit(10, 'H7', true)).toBe('φ10H7(+0.015 / 0)');
  });
  it('h7は軸なので上0、下が負', () => {
    expect(fitTolerance(10, 'h7')).toEqual({ upper: 0, lower: -0.015 });
  });
  it('区分の上限値は下側の行、超えると次の行を使う', () => {
    expect(fitTolerance(3, 'H7')?.upper).toBe(0.01);
    expect(fitTolerance(3.00001, 'H7')?.upper).toBe(0.012);
    expect(fitTolerance(10, 'H7')?.upper).toBe(0.015);
    expect(fitTolerance(10.00001, 'H7')?.upper).toBe(0.018);
  });
  it('承認範囲の1mmと500mmを両方受ける', () => {
    expect(fitTolerance(1, 'H7')).not.toBeNull();
    expect(fitTolerance(500, 'p6')).not.toBeNull();
  });
  it.each([0, 0.9999, 500.0001, NaN, Infinity])('範囲外・非有限%sを断る', (size) => {
    expect(fitTolerance(size, 'H7')).toBeNull();
  });
  it.each(['JS6', 'H5', 'P6', 'h7 ', ''])('未知の記号%sを別クラスへ推測しない', (symbol) => {
    expect(fitTolerance(10, symbol)).toBeNull();
    expect(formatFit(10, symbol)).toBeNull();
  });
  it('js6の半µmを表示で消さない', () => {
    expect(fitTolerance(10, 'js6')).toEqual({ upper: 0.0045, lower: -0.0045 });
    expect(formatFit(10, 'js6', true)).toBe('φ10js6(+0.0045 / −0.0045)');
  });
  it('全区分・全記号で上限が下限以上', () => {
    for (const row of FIT_ROWS) for (const symbol of FIT_SYMBOLS) {
      const result = fitTolerance(row.upTo, symbol);
      expect(result?.upper).toBeGreaterThanOrEqual(result?.lower ?? Infinity);
    }
  });
});
