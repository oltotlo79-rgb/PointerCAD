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
  const outer: SketchFeature = { id: 'outer', name: 'outer', kind: 'rectangle', planeId: 'xy',
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(60, 40, 0), construction: false };
  const face = { id: 'face', name: 'face', kind: 'face' as const, planeId: 'xy',
    boundary: [{ featureId: 'outer' }], color: '#eeeeee', holes: inner.map(feature => [{ featureId: feature.id }]) };
  return resolveSketch({ id: 'sketch', name: 'sketch', features: [outer, ...inner, face] });
}

describe('穴つきの面の解決', () => {
  it('外周と穴を別々の輪として解決する', () => {
    const result = resolveHoles(circle('inner', 30));
    expect(result.errors).toEqual([]);
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].curves).toHaveLength(4);
    expect(result.faces[0].holes).toMatchObject([[{ kind: 'arc', radius: 5 }]]);
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
