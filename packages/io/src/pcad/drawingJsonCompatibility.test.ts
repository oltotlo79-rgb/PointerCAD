import { describe, expect, it } from 'vitest';
import { hasOnlyFiniteJsonNumbers, preserveDrawingJsonFields } from './drawingJsonCompatibility.js';

describe('図面の前方互換と有限値(P8-64、R09)', () => {
  it('入れ子の未知の指定を保存し、元のオブジェクトと共有しない', () => {
    const source = { sheet: { scale: 1, future: { choices: [1, 2] } }, future: { enabled: true } };
    const result = preserveDrawingJsonFields(source, { sheet: { scale: 1 } });
    expect(result).toEqual(source);
    expect(Object.getOwnPropertyDescriptor(result.sheet, 'future')?.value).not.toBe(source.sheet.future);
  });
  it('検査済みの既知欄を未検査値で上書きしない', () => {
    expect(preserveDrawingJsonFields({ id: 12, future: 'yes' }, { id: 'checked' })).toEqual({ id: 'checked', future: 'yes' });
  });
  it('配列内の図と寸法に付いた未知欄も保持する', () => {
    const source = { views: [{ id: 'v1', future: 'view' }], dimensions: [{ id: 'd1', future: 'dimension' }] };
    expect(preserveDrawingJsonFields(source, { views: [{ id: 'v1' }], dimensions: [{ id: 'd1' }] })).toEqual(source);
  });
  it('投影線と寸法の計算結果は保存しない', () => {
    const source = { views: [{ id: 'v', visible: [[0, 0]], hidden: [], curves: [] }],
      dimensions: [{ id: 'd', value: 42, measuredValue: 42, geometry: {} }], mesh: {}, renderItems: [] };
    expect(preserveDrawingJsonFields(source, { views: [{ id: 'v' }], dimensions: [{ id: 'd' }] })).toEqual({ views: [{ id: 'v' }], dimensions: [{ id: 'd' }] });
  });
  it('公差の計算済み字幅は引き続き落とす', () => {
    expect(preserveDrawingJsonFields({ tolerance: { value: { source: 'x', value: 1, display: '1', derivedWidth: 999, future: true } } },
      { tolerance: { value: { source: 'x', value: 1, display: '1' } } })).toEqual({ tolerance: { value: { source: 'x', value: 1, display: '1', future: true } } });
  });
  it('特殊名の未知欄でprototypeを変えない', () => {
    const raw: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    const result = preserveDrawingJsonFields(raw, { id: 'drawing' });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual({ polluted: true });
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
  it('1e999を入れ子の未知欄でも断る', () => {
    const raw: unknown = JSON.parse('{"future":[{"number":1e999}]}');
    expect(hasOnlyFiniteJsonNumbers(raw)).toBe(false);
  });
  it('有限の大きな数は通し、負の無限大とNaNを断る', () => {
    expect(hasOnlyFiniteJsonNumbers({ a: [1e308, -1e308, 0] })).toBe(true);
    expect(hasOnlyFiniteJsonNumbers({ a: [NaN] })).toBe(false);
    expect(hasOnlyFiniteJsonNumbers({ a: [-Infinity] })).toBe(false);
  });
  it('大きな配列を引数展開せず、末尾の無限大まで確かめる', () => {
    const coordinates = Array<number>(200_000).fill(0);
    expect(hasOnlyFiniteJsonNumbers(coordinates)).toBe(true);
    coordinates[199_999] = Infinity;
    expect(hasOnlyFiniteJsonNumbers(coordinates)).toBe(false);
  });
});
