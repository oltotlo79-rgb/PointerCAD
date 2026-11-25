import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber as num } from '@pointercad/expression';
import { absoluteCoordinate } from './createSketchDocument.js';
import { resolveSketch } from './resolveSketch.js';
import type { SketchFeature } from './types.js';

function circle(id: string, x: number, radius = 5, z = 0): SketchFeature {
  return { id, name: id, kind: 'arc', planeId: 'free', center: absoluteCoordinate(x, 20, z),
    freeOrientation: { normal: absoluteCoordinate(0, 0, 1), xAxis: absoluteCoordinate(1, 0, 0) },
    radius: num(radius), startAngle: num(0), endAngle: num(360), construction: false };
}

function resolveHoles(...inner: SketchFeature[]) {
  return resolveFace(inner.map(feature => [feature]), 60, 40);
}

function resolveFace(loops: readonly (readonly SketchFeature[])[], width: number, height: number) {
  const outer: SketchFeature = { id: 'outer', name: 'outer', kind: 'rectangle', planeId: 'xy',
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(width, height, 0), construction: false };
  const face = { id: 'face', name: 'face', kind: 'face' as const, planeId: 'xy',
    boundary: [{ featureId: 'outer' }], color: '#eeeeee', holes: loops.map(loop => loop.map(feature => ({ featureId: feature.id }))) };
  return resolveSketch({ id: 'sketch', name: 'sketch', features: [outer, ...loops.flat(), face] });
}

function diagonalHole(index: number): SketchFeature[] {
  const y = 10 + 2 * index;
  const points = [absoluteCoordinate(10, y, 0), absoluteCoordinate(210, y + 200, 0),
    absoluteCoordinate(210, y + 201, 0), absoluteCoordinate(10, y + 1, 0)];
  return points.map((from, edge) => {
    const id = `diagonal-${String(index)}-${String(edge)}`;
    return { id, name: id, kind: 'line', planeId: 'xy', from, to: points[(edge + 1) % points.length], construction: false };
  });
}

describe('穴つきの面の解決', () => {
  it('外周と穴を別々の輪として解決する', () => {
    const result = resolveHoles(circle('inner', 30));
    expect(result.errors).toEqual([]);
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].curves).toHaveLength(4);
    expect(result.faces[0].holes).toMatchObject([[{ kind: 'arc', radius: 5 }]]);
  });

  it.each([181, 182])('離れた穴%d個を件数積の境界の両側で解決する', count => {
    const holes = Array.from({ length: count }, (_, index) => [circle(`hole-${String(index)}`, 3 + index * 3, 1)]);
    const result = resolveFace(holes, 550, 40);
    expect(result.errors).toEqual([]);
    expect(result.faces[0]?.holes).toHaveLength(count);
  });

  it('同じ円を重ねた穴を接触として拒否する', () => {
    const result = resolveHoles(circle('first', 25), circle('second', 25));
    expect(result.faces).toEqual([]);
    expect(result.errors.find(error => error.featureId === 'face')?.text).toEqual({
      key: 'partError.sketchFaceHole.touchesHole', parameters: { label: '穴2' },
    });
  });

  it('斜めの細い穴は境界箱が重なっても少数では解決する', () => {
    const result = resolveFace(Array.from({ length: 32 }, (_, index) => diagonalHole(index)), 230, 380);
    expect(result.errors).toEqual([]);
    expect(result.faces[0]?.holes).toHaveLength(32);
  });

  it('実際の候補が多い時は面を採用せず計算上限を伝える', () => {
    const result = resolveFace(Array.from({ length: 80 }, (_, index) => diagonalHole(index)), 230, 380);
    expect(result.faces).toEqual([]);
    expect(result.errors.find(error => error.featureId === 'face')?.text).toEqual({
      key: 'partError.sketchFaceHole.checkBudget', parameters: {},
    });
  });

  it.each([
    ['外周の外', [circle('inner', 70)], 'invalidValue', 'partError.sketchFaceHole.outsideOuter', '穴1'],
    ['外周に接する', [circle('inner', 5)], 'invalidValue', 'partError.sketchFaceHole.touchesOuter', '穴1'],
    ['外周を横切る', [circle('inner', 2)], 'invalidValue', 'partError.sketchFaceHole.touchesOuter', '穴1'],
    ['穴どうしが重なる', [circle('inner', 25), circle('other', 30)], 'invalidValue', 'partError.sketchFaceHole.touchesHole', '穴2'],
    ['穴どうしが接する', [circle('inner', 25), circle('other', 35)], 'invalidValue', 'partError.sketchFaceHole.touchesHole', '穴2'],
    ['穴が入れ子', [circle('inner', 30, 10), circle('other', 30)], 'invalidValue', 'partError.sketchFaceHole.nested', '穴2'],
    ['別の平面', [circle('inner', 30, 5, 1)], 'notPlanar', 'partError.sketchFaceHole.notSamePlane', '穴1'],
  ] as const)('%sの穴は理由を示して断る', (_, inner, code, key, label) => {
    const result = resolveHoles(...inner);
    expect(result.faces).toEqual([]);
    const error = result.errors.find(item => item.featureId === 'face');
    expect(error?.code).toBe(code);
    expect(error?.text).toEqual({ key, parameters: { label } });
  });

  it('開いた穴は面を作らない', () => {
    const line: SketchFeature = { id: 'inner', name: 'inner', kind: 'line', planeId: 'xy',
      from: absoluteCoordinate(20, 20, 0), to: absoluteCoordinate(30, 20, 0), construction: false };
    const result = resolveHoles(line);
    expect(result.faces).toEqual([]);
    expect(result.errors).toContainEqual(expect.objectContaining({ featureId: 'face', code: 'notClosed' }));
    const text = result.errors.find(error => error.featureId === 'face')?.text;
    expect(text).toMatchObject({ key: 'partError.numberedHole', parameters: { index: '1' } });
    expect(text?.parameters.text).toMatchObject({ key: 'partError.plainText' });
  });

  it('穴の参照先が消えたらmissingBaseになる', () => {
    const face = { id: 'face', name: 'face', kind: 'face' as const, planeId: 'xy',
      boundary: [{ featureId: 'outer' }], color: '#eeeeee', holes: [[{ featureId: 'missing' }]] };
    const outer = circle('outer', 30, 20);
    const result = resolveSketch({ id: 'sketch', name: 'sketch', features: [outer, face] });
    expect(result.faces).toEqual([]);
    expect(result.errors).toContainEqual(expect.objectContaining({ featureId: 'face', code: 'missingBase' }));
  });
});
