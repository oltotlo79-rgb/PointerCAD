import { describe, expect, it } from 'vitest';
import { autoDimension, type AutoDimensionCircle, type AutoDimensionInput, type AutoDimensionPoint } from './autoDimension.js';
import type { Dimension } from './types.js';

function point(id: string, x: number, y: number, scale = 1): AutoDimensionPoint {
  const modelPoint = [x, y, 0] as const, paperPoint = [100 + x * scale, 100 + y * scale] as const;
  return { id, modelPoint, paperPoint, target: { kind: 'point', viewId: 'front', modelPoint, paperPoint } };
}
function circle(id: string, x: number, y: number, radius = 4, full = true): AutoDimensionCircle {
  return { ...point(id, x, y), radius, full };
}
function input(patch: Partial<AutoDimensionInput> = {}): AutoDimensionInput {
  return { viewId: 'front', direction: [0, 0, -1], xDir: [1, 0, 0], layerId: 'layer-4',
    boundary: [point('a', 0, 0), point('b', 100, 0), point('c', 100, 60), point('d', 0, 60)], circles: [], existing: [],
    measureText: () => ({ inkBounds: { left: 0, bottom: 0, right: 7, top: 3.5 }, advanceMm: 7 }), ...patch };
}
function result(patch: Partial<AutoDimensionInput> = {}) {
  const value = autoDimension(input(patch));
  if (value === null) throw new Error('自動寸法が作られなかった');
  return value;
}
const role = (dimensions: readonly Dimension[], name: string) => dimensions.filter((dimension) => dimension.id.includes(`:${name}:`));
const span = (dimension: Dimension, axis: 0 | 1): number => {
  const points = dimension.targets.map((target) => target.kind === 'point' ? target.modelPoint : undefined);
  if (points.length !== 2 || points[0] === undefined || points[1] === undefined) throw new Error('2点の対象がない');
  return Math.abs(points[1][axis] - points[0][axis]);
};

describe('モデル参照を持つ自動寸法(P8-38)', () => {
  it('100×60の板に全体幅と高さ2本を作る', () => {
    const { dimensions } = result();
    expect(dimensions).toHaveLength(2);
    expect(span(role(dimensions, 'width')[0], 0)).toBe(100);
    expect(span(role(dimensions, 'height')[0], 1)).toBe(60);
  });
  it('同径の4穴を4×の付いた直径1本にまとめる', () => {
    const circles = [circle('h1', 20, 20), circle('h2', 40, 20), circle('h3', 60, 20), circle('h4', 80, 20)];
    expect(role(result({ circles }).dimensions, 'diameter')).toMatchObject([{ prefix: '4×', kind: 'diameter', targets: [circles[0].target] }]);
  });
  it('φ8が2個、φ12が1個なら直径2本', () => {
    const dimensions = role(result({ circles: [circle('h1', 20, 20), circle('h2', 40, 20), circle('h3', 60, 20, 6)] }).dimensions, 'diameter');
    expect(dimensions).toHaveLength(2);
    expect(dimensions[0].prefix).toBe('2×');
    expect(dimensions[1].prefix).toBeUndefined();
  });
  it('穴1個の位置に水平と垂直1本ずつを作る', () => {
    const { dimensions } = result({ circles: [circle('h1', 20, 15)] });
    expect(role(dimensions, 'holeX')).toHaveLength(1);
    expect(role(dimensions, 'holeY')).toHaveLength(1);
    expect(span(role(dimensions, 'holeX')[0], 0)).toBe(20);
    expect(span(role(dimensions, 'holeY')[0], 1)).toBe(15);
  });
  it('同じ行の3穴は端から1本と直列2本、垂直は1本', () => {
    const { dimensions } = result({ circles: [circle('h1', 20, 15), circle('h2', 50, 15), circle('h3', 90, 15)] });
    expect(role(dimensions, 'holeX').map((dimension) => span(dimension, 0))).toEqual([20, 30, 40]);
    expect(role(dimensions, 'holeY')).toHaveLength(1);
  });
  it('2行の穴は行ごとに垂直寸法を1本持つ', () => {
    expect(role(result({ circles: [circle('h1', 20, 15), circle('h2', 50, 15), circle('h3', 20, 40)] }).dimensions, 'holeY')).toHaveLength(2);
  });
  it('円弧は半径を付け、穴の位置寸法に混ぜない', () => {
    const { dimensions } = result({ circles: [circle('round', 20, 15, 4, false)] });
    expect(role(dimensions, 'radius')).toHaveLength(1);
    expect(role(dimensions, 'holeX')).toHaveLength(0);
  });
  it('全て自動として保存し、導出した値は保存しない', () => {
    for (const dimension of result().dimensions) {
      expect(dimension.origin).toBe('auto');
      expect(dimension).not.toHaveProperty('value');
    }
  });
  it('手動寸法は同じオブジェクトのまま保持する', () => {
    const manual: Dimension = { ...result().dimensions[0], id: 'manual', origin: 'manual',
      placement: { commonNormalCoordinate: 123, textPosition: [45, 67] } };
    expect(result({ existing: [manual] }).dimensions[0]).toBe(manual);
  });
  it('自動寸法を再実行しても数もIDも増えない', () => {
    const first = result();
    expect(result({ existing: first.dimensions })).toEqual(first);
  });
  it('描画と同じ下端基準の字体囲みで既存文字との接触を避ける', () => {
    const first = result().dimensions[0];
    const position = first.placement.textPosition;
    if (position === null) throw new Error('文字位置なし');
    // 中央基準の仮の矩形では見逃す、文字の上端付近だけの重なり。
    const next = result({ existingTextBoxes: [{ ownerId: 'manual', bounds: {
      left: position[0] - 1, right: position[0] + 1, bottom: position[1] + 3, top: position[1] + 4,
    } }] });
    expect(next.dimensions[0].placement.commonNormalCoordinate).toBe(first.placement.commonNormalCoordinate - 8);
    expect(next.unresolvedOverlapIds).toEqual([]);
  });
  it('別の図の自動寸法を消さない', () => {
    const original = result().dimensions[0];
    const other: Dimension = { ...original, id: 'other', targets: original.targets.map((target) => ({ ...target, viewId: 'top' })) };
    expect(result({ existing: [other] }).dimensions[0]).toBe(other);
  });
  it('紙上縮尺を変えても3Dの幅高さを保持する', () => {
    const { dimensions } = result({ boundary: [point('a', 0, 0, 0.5), point('b', 100, 0, 0.5), point('c', 100, 60, 0.5), point('d', 0, 60, 0.5)] });
    expect(span(role(dimensions, 'width')[0], 0)).toBe(100);
    expect(span(role(dimensions, 'height')[0], 1)).toBe(60);
  });
  it('重なる文字は外側へ押し出す', () => {
    const { dimensions, unresolvedOverlapIds } = result({ circles: [circle('h1', 20, 15), circle('h2', 21, 15)],
      measureText: () => ({ inkBounds: { left: 0, bottom: 0, right: 20, top: 3.5 }, advanceMm: 20 }) });
    expect(unresolvedOverlapIds).toEqual([]);
    const x = role(dimensions, 'holeX').map((dimension) => dimension.placement.commonNormalCoordinate);
    expect(x[0]).not.toBe(x[1]);
  });
  it('字体の実測が得られなければ推測幅で確定しない', () => expect(autoDimension(input({ measureText: () => null }))).toBeNull());
  it('紙上の点だけをモデル参照として保存しない', () => {
    expect(autoDimension(input({ boundary: [{ ...point('a', 0, 0), target: { kind: 'point', viewId: 'front', paperPoint: [0, 0] } }] }))).toBeNull();
  });
  it('対象がない図と不正な半径を断る', () => {
    expect(autoDimension(input({ boundary: [] }))).toBeNull();
    expect(autoDimension(input({ circles: [circle('bad', 20, 20, -1)] }))).toBeNull();
  });
  it('境界と穴の入力順によらず決定的に出力する', () => {
    const circles = [circle('h1', 20, 15), circle('h2', 40, 15), circle('h3', 60, 15)];
    const first = input({ circles }); const snapshot = JSON.stringify(first);
    expect(autoDimension(first)).toEqual(autoDimension({ ...first, boundary: [...first.boundary].reverse(), circles: [...circles].reverse() }));
    expect(JSON.stringify(first)).toBe(snapshot);
  });
});
