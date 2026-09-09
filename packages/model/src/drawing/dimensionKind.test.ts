import { describe, expect, it } from 'vitest';
import { suggestDimensionKind } from './dimensionKind.js';
import type { ResolvedDimensionTarget } from './dimensionTarget.js';
const line: ResolvedDimensionTarget = { kind: 'line', from: [0, 0, 0], to: [20, 0, 0], length: 20, paperFrom: [0, 0], paperTo: [20, 0] };
const point: ResolvedDimensionTarget = { kind: 'point', point: [0, 0, 0], paperPoint: [0, 0] };
const circle: ResolvedDimensionTarget = { kind: 'circle', center: [0, 0, 0], axis: [0, 1, 0], radius: 8, length: 16 * Math.PI,
  from: [8, 0, 0], to: [8, 0, 0], paperCenter: [0, 0], paperFrom: [8, 0], paperTo: [8, 0] };
const arc: ResolvedDimensionTarget = { ...circle, kind: 'arc', length: 8 * Math.PI, to: [-8, 0, 0], paperTo: [-8, 0] };
describe('選択からの寸法種類(P8-26)', () => {
  it('直線1本は実距離', () => expect(suggestDimensionKind([line])).toEqual({ kind: 'length', measurement: 'trueDistance' }));
  it('円1つは直径', () => expect(suggestDimensionKind([circle])).toEqual({ kind: 'diameter', measurement: 'radius' }));
  it('円弧1つは半径', () => expect(suggestDimensionKind([arc])).toEqual({ kind: 'radius', measurement: 'radius' }));
  it('点2つは実距離', () => expect(suggestDimensionKind([point, { ...point, point: [3, 4, 0] }])).toEqual({ kind: 'length', measurement: 'trueDistance' }));
  it('平行でない直線2本は角度', () => expect(suggestDimensionKind([line, { ...line, to: [0, 20, 0] }])).toEqual({ kind: 'angle', measurement: 'angle' }));
  it('平行な直線2本は間の距離', () => expect(suggestDimensionKind([line, { ...line, from: [0, 10, 0], to: [20, 10, 0] }])).toEqual({ kind: 'length', measurement: 'trueDistance' }));
  it('反対向きでも平行なら距離', () => expect(suggestDimensionKind([line, { ...line, from: [20, 10, 0], to: [0, 10, 0] }])?.kind).toBe('length'));
  it('球面1つは球直径', () => expect(suggestDimensionKind([{ kind: 'sphere', center: [0, 0, 0], radius: 8, paperCenter: [0, 0] }])).toEqual({ kind: 'sphereDiameter', measurement: 'radius' }));
  it('円弧で明示した弧長を優先する', () => expect(suggestDimensionKind([arc], 'arcLength')).toEqual({ kind: 'arcLength', measurement: 'radius' }));
  it('円の周長も弧長の指定に応じる', () => expect(suggestDimensionKind([circle], 'arcLength')?.kind).toBe('arcLength'));
  it('未選択はnull', () => expect(suggestDimensionKind([])).toBeNull());
  it('点1つや平面1つを勝手に寸法へしない', () => {
    expect(suggestDimensionKind([point])).toBeNull();
    expect(suggestDimensionKind([{ kind: 'plane', point: [0, 0, 0], normal: [0, 0, 1], paperPoint: [0, 0] }])).toBeNull();
  });
  it('選択順を逆にしても判定が同じ', () => {
    const second: ResolvedDimensionTarget = { ...line, to: [0, 20, 0] };
    expect(suggestDimensionKind([line, second])).toEqual(suggestDimensionKind([second, line]));
  });
  it('過剰な選択や種類が混ざる選択を断る', () => {
    expect(suggestDimensionKind([line, line, line])).toBeNull();
    expect(suggestDimensionKind([line, point])).toBeNull();
    expect(suggestDimensionKind([line], 'arcLength')).toBeNull();
  });
  it('長さ0の辺の組を平行と扱わない', () => expect(suggestDimensionKind([line, { ...line, to: [0, 0, 0] }])).toBeNull());
});
