import { expressionValueFromNumber as num } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { absoluteCoordinate as xyz, replaceFeature } from './createSketchDocument.js';
import { resolveSketch } from './resolveSketch.js';
import { splitLineIntersections, type SplitLineOutcome } from './splitLineIntersections.js';
import type { SketchDocument, SketchFeature, SketchLineFeature } from './types.js';
import type { Vec3 } from './vec3.js';

function line(id: string, from: Vec3, to: Vec3): SketchLineFeature {
  return { id, name: id, kind: 'line', planeId: 'xy', from: xyz(...from), to: xyz(...to), construction: false };
}
function sketch(...features: SketchFeature[]): SketchDocument { return { id: 'sketch-1', name: 'sketch', features }; }
function success(result: SplitLineOutcome) { if (!result.ok) throw new Error(result.reason); return result; }
function crossing(): SketchDocument {
  return sketch(line('line-1', [-10, 0, 0], [10, 0, 0]), line('line-2', [0, -10, 0], [0, 10, 0]));
}

describe('交点の共有点と線分分割', () => {
  it('交差した2本を4本へ分け、元文書は変更しない', () => {
    const before = crossing(); const serialized = JSON.stringify(before);
    const result = success(splitLineIntersections(before, 'line-2'));
    expect(result.pointIds).toHaveLength(1); expect(result.splitCount).toBe(2);
    const resolved = resolveSketch(result.document);
    expect(resolved.errors).toEqual([]); expect(resolved.segments).toHaveLength(4);
    expect(JSON.stringify(before)).toBe(serialized);
    expect(resolved.segments.map((segment) => [segment.from, segment.to])).toEqual([
      [[-10, 0, 0], [0, 0, 0]], [[0, 0, 0], [10, 0, 0]],
      [[0, -10, 0], [0, 0, 0]], [[0, 0, 0], [0, 10, 0]],
    ]);
  });

  it('共有点を動かすと4本が追従し、外側の端は動かない', () => {
    const result = success(splitLineIntersections(crossing(), 'line-2'));
    const point = result.document.features.find((feature) => feature.id === result.pointIds[0]);
    if (point?.kind !== 'point') throw new Error('missing junction');
    const after = resolveSketch(replaceFeature(result.document, point.id, { ...point, at: xyz(2, 3, 0) }));
    expect(after.errors).toEqual([]);
    expect(after.segments.map((segment) => [segment.from, segment.to])).toEqual([
      [[-10, 0, 0], [2, 3, 0]], [[2, 3, 0], [10, 0, 0]],
      [[0, -10, 0], [2, 3, 0]], [[2, 3, 0], [0, 10, 0]],
    ]);
  });

  it('交点が複数なら順に分け、削除した1区間だけが消える', () => {
    const document = sketch(line('line-1', [-5, -5, 0], [-5, 5, 0]),
      line('line-2', [5, -5, 0], [5, 5, 0]), line('line-3', [-10, 0, 0], [10, 0, 0]));
    const result = success(splitLineIntersections(document, 'line-3'));
    expect(result.pointIds).toHaveLength(2); expect(result.splitCount).toBe(4);
    const segments = resolveSketch(result.document).segments;
    expect(segments).toHaveLength(7);
    const middle = segments.find((segment) => segment.from[0] === -5 && segment.to[0] === 5);
    if (middle === undefined) throw new Error('missing middle');
    const after = resolveSketch({ ...result.document, features: result.document.features.filter((feature) => feature.id !== middle.featureId) });
    expect(after.errors).toEqual([]); expect(after.segments).toHaveLength(6);
  });

  it('T字の端点を共有し、長さ0の線を作らない', () => {
    const result = success(splitLineIntersections(sketch(line('line-1', [-10, 0, 0], [10, 0, 0]),
      line('line-2', [0, -10, 0], [0, 0, 0])), 'line-2'));
    expect(result.splitCount).toBe(1);
    expect(resolveSketch(result.document).segments).toHaveLength(3);
    expect(resolveSketch(result.document).errors).toEqual([]);
  });

  it('同じ交点を後から通る線は既存の共有点を使う', () => {
    const first = success(splitLineIntersections(crossing(), 'line-2'));
    const document = { ...first.document, features: [...first.document.features, line('line-99', [-5, -5, 0], [5, 5, 0])] };
    const result = success(splitLineIntersections(document, 'line-99'));
    expect(result.pointIds).toEqual(first.pointIds);
    expect(resolveSketch(result.document).segments).toHaveLength(6);
    expect(resolveSketch(result.document).points).toHaveLength(7);
    for (const original of first.document.features) {
      expect(result.document.features.find((feature) => feature.id === original.id)).toEqual(original);
    }
  });

  it('共有点を使うだけの既存区間の拘束は変更も削除もしない', () => {
    const first = success(splitLineIntersections(crossing(), 'line-2'));
    const document: SketchDocument = { ...first.document,
      features: [...first.document.features, line('line-99', [-5, -5, 0], [5, 5, 0])],
      constraints: [{ id: 'c1', name: 'horizontal', kind: 'horizontal', target: { kind: 'curve', element: { featureId: 'line-1' } } }],
    };
    const result = success(splitLineIntersections(document, 'line-99'));
    expect(result.document.constraints).toEqual(document.constraints);
    expect(resolveSketch(result.document).points).toHaveLength(7);
  });

  it.each([
    ['parallel', [-10, 2, 0], [10, 2, 0]], ['overlap', [-5, 0, 0], [5, 0, 0]],
    ['skew', [0, -10, 1], [0, 10, 1]], ['outside', [20, -10, 0], [20, 10, 0]],
    ['near-skew', [0, -10, 0.0005], [0, 10, 0.0005]],
    ['endpoint', [10, 0, 0], [10, 10, 0]],
  ] satisfies readonly (readonly [string, Vec3, Vec3])[])('%sでは誤分割しない', (_name, from, to) => {
    const document = sketch(line('line-1', [-10, 0, 0], [10, 0, 0]), line('line-2', from, to));
    expect(success(splitLineIntersections(document, 'line-2')).document).toBe(document);
  });

  it('構築線との交点では分割しない', () => {
    const document = sketch({ ...line('line-1', [-10, 0, 0], [10, 0, 0]), construction: true },
      line('line-2', [0, -10, 0], [0, 10, 0]));
    expect(success(splitLineIntersections(document, 'line-2')).document).toBe(document);
  });

  it('吸着距離より近い別々の交点を混ぜず、短い実区間も残す', () => {
    const document = sketch(line('line-1', [0, -10, 0], [0, 10, 0]),
      line('line-2', [0.0005, -10, 0], [0.0005, 10, 0]), line('line-3', [-10, 0, 0], [10, 0, 0]));
    const result = success(splitLineIntersections(document, 'line-3'));
    expect(result.pointIds).toHaveLength(2);
    const resolved = resolveSketch(result.document);
    expect(resolved.errors).toEqual([]); expect(resolved.segments).toHaveLength(7);
    expect(resolved.segments.some((segment) => Math.abs(segment.to[0] - segment.from[0] - 0.0005) < 1e-10)).toBe(true);
  });

  it('相対/極の終点の元の式と、次の線の連続始点を保つ', () => {
    const polar: SketchLineFeature = { ...line('line-1', [-10, 0, 0], [10, 0, 0]),
      to: { mode: 'polar', base: { kind: 'previous' }, distance: { ...num(20), source: '10*2' }, azimuth: num(0), elevation: num(0) } };
    const continued: SketchLineFeature = { ...line('line-2', [10, 0, 0], [10, 10, 0]),
      from: { mode: 'relative', base: { kind: 'previous' }, dx: num(0), dy: num(0), dz: num(0) } };
    const result = success(splitLineIntersections(sketch(polar, continued, line('line-3', [0, -5, 0], [0, 5, 0])), 'line-3'));
    expect(resolveSketch(result.document).segments.find((segment) => segment.featureId === 'line-2')?.from).toEqual([10, 0, 0]);
    expect(result.document.features.some((feature) => feature.kind === 'point' && feature.at.mode === 'polar'
      && feature.at.distance.source === '10*2')).toBe(true);
  });

  it('閉じた面の境界を全区間へ付け替え、端点への参照を保つ', () => {
    const document = sketch(line('line-1', [0, 0, 0], [20, 0, 0]), line('line-2', [20, 0, 0], [20, 20, 0]),
      line('line-3', [20, 20, 0], [0, 20, 0]), line('line-4', [0, 20, 0], [0, 0, 0]),
      { id: 'face-1', name: 'face', kind: 'face', planeId: 'xy', color: '#ffffff',
        boundary: [1, 2, 3, 4].map((n) => ({ featureId: `line-${String(n)}` })) },
      { id: 'point-1', name: 'reference', kind: 'point', planeId: 'xy',
        at: { mode: 'relative', base: { kind: 'vertex', featureId: 'line-1', vertex: 'start' }, dx: num(0), dy: num(0), dz: num(0) } },
      line('line-5', [10, -5, 0], [10, 5, 0]));
    const result = success(splitLineIntersections(document, 'line-5'));
    const resolved = resolveSketch(result.document);
    expect(resolved.errors).toEqual([]); expect(resolved.faces[0].curves).toHaveLength(5);
    expect(resolved.points.find((point) => point.id === 'point-1')?.position).toEqual([0, 0, 0]);
  });

  it('拘束の意味を部分線分へ黙って変更せず理由を返す', () => {
    const document: SketchDocument = { ...crossing(), constraints: [{ id: 'c1', name: 'horizontal', kind: 'horizontal',
      target: { kind: 'curve', element: { featureId: 'line-1' } } }] };
    expect(splitLineIntersections(document, 'line-2')).toEqual({ ok: false, reason: 'constrainedLine' });
  });
});
