import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, createEmptySketchDocument, DEFAULT_FACE_COLOR,
  resolveSketch, traceCurveChain,
  type CoordinateInput, type SketchDocument, type SketchFaceFeature, type SketchFeature,
  type SketchLineFeature, type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { commitSketchChamfer, commitSketchFillet, cornerNear } from './cornerCommands.js';
import type { EditInputCommit } from './numericInput.js';

const operations = ['fillet', 'chamfer'] as const;
type Operation = typeof operations[number];
function commit(kind: Operation): EditInputCommit {
  return {
    kind: 'edit', tool: kind === 'fillet' ? 'sketchFillet' : 'sketchChamfer',
    step: kind === 'fillet' ? 'sketchFilletRadius' : 'sketchChamferSize',
    values: { cornerRadius: expressionValueFromNumber(5),
      cornerDistance1: expressionValueFromNumber(3), cornerDistance2: expressionValueFromNumber(4) },
    flags: {}, choices: { chamferMode: 'twoDistances' },
  };
}
function run(kind: Operation, document: SketchDocument, selection: readonly string[]) {
  return (kind === 'fillet' ? commitSketchFillet : commitSketchChamfer)(document, selection, commit(kind));
}
function face(id: string, ids: readonly string[]): SketchFaceFeature {
  return { id, name: id, planeId: 'xy', kind: 'face', color: DEFAULT_FACE_COLOR,
    boundary: ids.map((featureId) => ({ featureId })) };
}
function rectangle(): SketchDocument {
  return appendFeature(appendFeature(createEmptySketchDocument(), {
    id: 'rect', name: '矩形1', planeId: 'xy', kind: 'rectangle', construction: false,
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
  }), face('face', ['rect']));
}
function line(id: string, from: Vec3, to: Vec3): SketchLineFeature {
  return { id, name: id, planeId: 'xy', kind: 'line', construction: false,
    from: absoluteCoordinate(...from), to: absoluteCoordinate(...to) };
}
function previousCoordinate(): CoordinateInput {
  return { mode: 'relative', base: { kind: 'previous' }, dx: expressionValueFromNumber(10),
    dy: expressionValueFromNumber(10), dz: expressionValueFromNumber(0) };
}
const independentFeatures: readonly SketchFeature[] = [
  { ...line('local', [80, 90, 0], [90, 100, 0]), to: previousCoordinate() },
  { id: 'local', name: 'local', planeId: 'xy', kind: 'rectangle', construction: false,
    corner1: absoluteCoordinate(80, 90, 0), corner2: previousCoordinate() },
  { id: 'local', name: 'local', planeId: 'xy', kind: 'slot', construction: false,
    center1: absoluteCoordinate(80, 90, 0), center2: previousCoordinate(),
    width: expressionValueFromNumber(5) },
  { id: 'local', name: 'local', planeId: 'xy', kind: 'spline', construction: false,
    mode: 'control', closed: false,
    points: [absoluteCoordinate(80, 90, 0), previousCoordinate(), previousCoordinate()] },
];
function closedFace(document: SketchDocument, id: string, count: number): void {
  const resolved = resolveSketch(document);
  expect(resolved.errors).toEqual([]);
  const found = resolved.faces.find((candidate) => candidate.featureId === id);
  expect(found).toBeDefined();
  if (found === undefined) throw new Error('Missing face');
  expect(found.curves).toHaveLength(count);
  expect(traceCurveChain(found.curves)).toMatchObject({ ok: true, chain: { closed: true } });
}

describe.each(operations)('%s: 面の境界も同じ確定で更新する(F07)', (kind) => {
  it.each([0, 1, 2, 3])('矩形の角 %i を両方の選択順で加工し、面より前へ曲線を置く', (edge) => {
    for (const selection of [
      [`rect#${String(edge)}`, `rect#${String((edge + 1) % 4)}`],
      [`rect#${String((edge + 1) % 4)}`, `rect#${String(edge)}`],
    ]) {
      const before = rectangle(), snapshot = structuredClone(before);
      const outcome = run(kind, before, selection);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.reasonKey);
      expect(outcome.boundaryUpdated).toBe(true);
      const changedFace = outcome.document.features.find((feature) => feature.id === 'face');
      expect(changedFace).toMatchObject({ id: 'face', name: 'face', color: DEFAULT_FACE_COLOR });
      if (changedFace?.kind !== 'face') throw new Error('Missing face');
      expect(changedFace.boundary.filter((reference) => reference.featureId === outcome.featureId)).toHaveLength(1);
      expect(outcome.document.features.findIndex((feature) => feature.id === outcome.featureId))
        .toBeLessThan(outcome.document.features.findIndex((feature) => feature.id === 'face'));
      closedFace(outcome.document, 'face', 5);
      expect(before).toEqual(snapshot);
    }
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    '線分の向きが反転しても閉じる(1本目 %s / 2本目 %s)', (reverseFirst, reverseSecond) => {
      const firstFrom: Vec3 = [0, 0, 0], corner: Vec3 = [40, 0, 0], secondTo: Vec3 = [40, 30, 0];
      const document: SketchDocument = { ...createEmptySketchDocument(), features: [
        line('a', reverseFirst ? corner : firstFrom, reverseFirst ? firstFrom : corner),
        line('b', reverseSecond ? secondTo : corner, reverseSecond ? corner : secondTo),
        line('c', secondTo, [0, 30, 0]), line('d', [0, 30, 0], firstFrom),
        // 先頭の向きは固定し、加工する2辺の4通りを独立して確かめる。
        face('face', ['c', 'd', 'a', 'b']),
      ] };
      closedFace(document, 'face', 4);
      for (const selection of [['a', 'b'], ['b', 'a']]) {
        const outcome = run(kind, document, selection);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(outcome.reasonKey);
        closedFace(outcome.document, 'face', 5);
      }
    },
  );

  it('同じ角を使う2枚の面を両方更新し、別の輪郭の面は保持する', () => {
    let document = appendFeature(rectangle(), face('face2', ['rect']));
    document = appendFeature(document, { id: 'other', name: '矩形2', planeId: 'xy', kind: 'rectangle',
      construction: false, corner1: absoluteCoordinate(10, 10, 0), corner2: absoluteCoordinate(20, 20, 0) });
    const otherFace = face('otherFace', ['other']);
    document = appendFeature(document, otherFace);
    const outcome = run(kind, document, ['rect#0', 'rect#1']);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    closedFace(outcome.document, 'face', 5);
    closedFace(outcome.document, 'face2', 5);
    closedFace(outcome.document, 'otherFace', 4);
    expect(outcome.document.features.find((feature) => feature.id === 'otherFace')).toEqual(otherFace);
  });

  it('続けて別の角を加工しても既存の面を保つ', () => {
    const first = run(kind, rectangle(), ['rect#0', 'rect#1']);
    if (!first.ok) throw new Error(first.reasonKey);
    const hit = cornerNear(first.document, resolveSketch(first.document), [0, 30, 0], 1);
    if (hit === null) throw new Error('Missing second corner');
    const second = run(kind, first.document, [hit.firstElementId, hit.secondElementId]);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reasonKey);
    closedFace(second.document, 'face', 6);
  });

  it('片方の辺だけを使う別の面があれば、全体を変更前に拒否する', () => {
    const original = rectangle();
    let document = appendFeature(original, line('diagonal', [40, 0, 0], [0, 30, 0]));
    document = appendFeature(document, { ...face('triangle', []), boundary: [
      { featureId: 'rect', index: 0 }, { featureId: 'diagonal' }, { featureId: 'rect', index: 3 },
    ] });
    closedFace(document, 'triangle', 3);
    const snapshot = structuredClone(document);
    expect(run(kind, document, ['rect#0', 'rect#1']))
      .toEqual({ ok: false, reasonKey: 'corner.error.faceBoundary' });
    expect(document).toEqual(snapshot);
  });

  it('穴の内外の2輪郭を1枚の面に並べた未対応の境界を変更しない', () => {
    const before = rectangle();
    const document: SketchDocument = { ...before, features: [before.features[0], {
      id: 'inner', name: '内周', planeId: 'xy', kind: 'rectangle', construction: false,
      corner1: absoluteCoordinate(10, 10, 0), corner2: absoluteCoordinate(20, 20, 0),
    }, face('face', ['rect', 'inner'])] };
    const snapshot = structuredClone(document);
    expect(resolveSketch(document).errors).toMatchObject([{ featureId: 'face', code: 'notClosed' }]);
    expect(run(kind, document, ['rect#0', 'rect#1']))
      .toEqual({ ok: false, reasonKey: 'corner.error.faceBoundary' });
    expect(document).toEqual(snapshot);
  });

  it('面の後の「直前の点」を挿入した曲線の端へ移してしまう操作を拒否する', () => {
    const document = appendFeature(rectangle(), { id: 'relative', name: '相対点', planeId: 'xy', kind: 'point',
      at: { mode: 'relative', base: { kind: 'previous' }, dx: expressionValueFromNumber(1),
        dy: expressionValueFromNumber(2), dz: expressionValueFromNumber(0) } });
    const snapshot = structuredClone(document);
    expect(run(kind, document, ['rect#0', 'rect#1']))
      .toEqual({ ok: false, reasonKey: 'corner.error.previousPoint' });
    expect(document).toEqual(snapshot);
  });

  it('未解決の図形を挟んだ「直前の点」も変更せず拒否する', () => {
    let document = appendFeature(rectangle(), { id: 'broken', name: '未解決の点', planeId: 'xy', kind: 'point',
      at: { mode: 'relative', base: { kind: 'point', pointId: 'missing' }, dx: expressionValueFromNumber(1),
        dy: expressionValueFromNumber(0), dz: expressionValueFromNumber(0) } });
    document = appendFeature(document, { id: 'relative', name: '相対点', planeId: 'xy', kind: 'point',
      at: { mode: 'relative', base: { kind: 'previous' }, dx: expressionValueFromNumber(1),
        dy: expressionValueFromNumber(2), dz: expressionValueFromNumber(0) } });
    expect(resolveSketch(document).errors.map((error) => error.featureId)).toEqual(['broken']);
    expect(run(kind, document, ['rect#0', 'rect#1']))
      .toEqual({ ok: false, reasonKey: 'corner.error.previousPoint' });
  });

  it('面の後の絶対座標の点を基準にした相対点は動かず、加工を妨げない', () => {
    let document = appendFeature(rectangle(), { id: 'absolute', name: '基準点', planeId: 'xy', kind: 'point',
      at: absoluteCoordinate(80, 90, 0) });
    document = appendFeature(document, { id: 'relative', name: '相対点', planeId: 'xy', kind: 'point',
      at: { mode: 'relative', base: { kind: 'previous' }, dx: expressionValueFromNumber(1),
        dy: expressionValueFromNumber(2), dz: expressionValueFromNumber(0) } });
    const beforePoints = resolveSketch(document).points;
    const outcome = run(kind, document, ['rect#0', 'rect#1']);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    closedFace(outcome.document, 'face', 5);
    expect(resolveSketch(outcome.document).points).toEqual(beforePoints);
  });

  it.each(independentFeatures)('$kind内の直前の点だけを使う図形を動かさず加工できる', (feature) => {
    let document = appendFeature(rectangle(), feature);
    document = appendFeature(document, { id: 'relative', name: 'relative', planeId: 'xy', kind: 'point',
      at: previousCoordinate() });
    const before = resolveSketch(document);
    expect(before.errors).toEqual([]);
    const outcome = run(kind, document, ['rect#0', 'rect#1']);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    closedFace(outcome.document, 'face', 5);
    const after = resolveSketch(outcome.document);
    const localGeometry = (resolved: ReturnType<typeof resolveSketch>) => [
      ...resolved.points, ...resolved.segments, ...resolved.arcs, ...resolved.splines,
    ].filter((geometry) => geometry.featureId === 'local' || geometry.featureId === 'relative');
    expect(localGeometry(after)).toEqual(localGeometry(before));
  });

  it.each(independentFeatures)('$kindの最初の点が直前の図形に依存する場合は加工を拒否する', (feature) => {
    let dependent: SketchFeature;
    switch (feature.kind) {
      case 'line': dependent = { ...feature, from: previousCoordinate() }; break;
      case 'rectangle': dependent = { ...feature, corner1: previousCoordinate() }; break;
      case 'slot': dependent = { ...feature, center1: previousCoordinate() }; break;
      case 'spline': dependent = { ...feature, points: [previousCoordinate(), ...feature.points.slice(1)] }; break;
      default: throw new Error('Unexpected feature kind');
    }
    const document = appendFeature(rectangle(), dependent), snapshot = structuredClone(document);
    expect(resolveSketch(document).errors).toEqual([]);
    expect(run(kind, document, ['rect#0', 'rect#1']))
      .toEqual({ ok: false, reasonKey: 'corner.error.previousPoint' });
    expect(document).toEqual(snapshot);
  });
});
