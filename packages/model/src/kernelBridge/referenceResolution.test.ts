import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { CurrentOriginIndex, SubShapeOrigin } from '../geometry/subShapeOrigin.js';
import type { SolidBody, SolidEdgeEntry, SolidFaceEntry } from './solidContracts.js';
import { createSubShapeReferenceResolver, resolveReplacementSubShapeReference, resolveSubShapeReference, SUB_SHAPE_AMBIGUITY_MARGIN } from './referenceResolution.js';
import { scoreSubShapeMatch } from './subShapeMatching.js';

const reference: SubShapeRef = { bodyFeatureId: 'body', index: 99, fingerprint: {
  kind: 'edge', curveKind: 'line', length: 20, position: [0, 0, 0], axis: [1, 0, 0], radius: null,
} };
function edge(index: number, length: number, y = 0): SolidEdgeEntry {
  return { index, curveKind: 'line', length, midpoint: [0, y, 0], axis: [1, 0, 0], radius: null,
    start: [-length / 2, y, 0], end: [length / 2, y, 0], segmentOffset: 0, segmentCount: 1 };
}
function body(edges: readonly SolidEdgeEntry[], patch: Partial<SolidBody> = {}): SolidBody {
  return { featureId: 'body', mesh: { positions: new Float32Array([-50, -50, -50, 50, 50, 50]),
    normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
    volume: 1, isValid: true, edges, faces: [], vertices: [], threadMarks: [], ...patch };
}

describe('部分形状の共通参照解決', () => {
  const semantic: SubShapeOrigin = { version: 1, shapeKind: 'edge', identity: {
    kind: 'box-edge', featureId: 'body', role: 'top-front',
  } };
  it('意味uniqueは幾何scoreが0.6未満でも現addressを選び、同形の別featureへ移らない', () => {
    const saved: SubShapeRef = { ...reference, origin: semantic };
    const origins: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [{
      origin: semantic, state: 'unique', current: { kind: 'edge', index: 7 },
    }] };
    const current = body([edge(2, 20), { ...edge(7, 200, 20), axis: [-1, 0, 0] }], { origins });
    const result = resolveSubShapeReference(current, saved);
    expect(result.status).toBe('matched');
    if (result.status !== 'matched') return;
    expect(result.match.reference).toMatchObject({ bodyFeatureId: 'body', index: 7, origin: semantic });
    expect(result.match.score).toBeLessThan(0.6);
    expect(result.match.basis).toBe('semantic');
    expect(result.originalReference).toBe(saved);
    expect(resolveSubShapeReference(body(current.edges, { ...current, featureId: 'other' }), saved).status).toBe('missing');
    expect(resolveReplacementSubShapeReference([body(current.edges, { ...current, featureId: 'other' })], saved).status).toBe('missing');
  });
  it('split/merged/missing/untracked/表なしは旧指紋候補が一致しても採用しない', () => {
    const saved: SubShapeRef = { ...reference, origin: semantic };
    const states: readonly (CurrentOriginIndex | undefined)[] = [undefined,
      { version: 1, state: 'tracked', bindings: [{ origin: semantic, state: 'split', candidates: [
        { kind: 'edge', index: 2 }, { kind: 'edge', index: 7 },
      ] }] },
      { version: 1, state: 'tracked', bindings: [{ origin: semantic, state: 'merged',
        current: { kind: 'edge', index: 2 }, coOrigins: [semantic, semantic] }] },
      { version: 1, state: 'tracked', bindings: [{ origin: semantic, state: 'missing', reason: 'deleted' }] },
      { version: 1, state: 'untracked', reason: 'unsupported-producer' },
    ];
    const results = states.map(origins => resolveSubShapeReference(body([edge(2, 20), edge(7, 20)], { origins }), saved));
    expect(results.map(result => result.status)).toEqual(['missing', 'ambiguous', 'ambiguous', 'missing', 'missing']);
    expect(results.map(result => result.candidates.length)).toEqual([0, 2, 1, 0, 0]);
    expect(results.map(result => result.status === 'matched' ? null : result.reason))
      .toEqual(['origin-index-missing', 'split', 'merged', 'deleted', 'unsupported-producer']);
  });
  it('5000候補は1回の解決内で共有し、別の再計算へ持ち越さない', () => {
    const current = body(Array.from({ length: 5000 }, (_, index) => edge(index, 20)));
    const resolve = createSubShapeReferenceResolver(), saved = { ...reference, index: 2345 };
    const first = resolve(current, saved), started = performance.now();
    expect(first.status).toBe('matched');
    expect(first.candidates).toHaveLength(5000);
    for (let index = 0; index < 100; index++) {
      const copy = { ...saved }, result = resolve(current, copy);
      expect(result.originalReference).toBe(copy);
      expect(result.candidates).toBe(first.candidates);
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(createSubShapeReferenceResolver()(current, saved).candidates).not.toBe(first.candidates);
  });

  it('差替えだけが異なるfeatureIdのbody群を集約し、一致IDが存在すれば他へ逃がさない', () => {
    const preferred = body([]), other = body([edge(7, 20)], { featureId: 'replacement' });
    expect(resolveReplacementSubShapeReference([other, preferred], reference)).toMatchObject({ status: 'missing', originalReference: reference });
    expect(resolveReplacementSubShapeReference([other], reference)).toMatchObject({ status: 'matched',
      originalReference: reference, match: { reference: { bodyFeatureId: 'replacement', index: 7 } } });
    expect(resolveSubShapeReference(other, reference).status).toBe('missing');
  });

  it.each([[0, 1, false], [1, 0, false], [0, 1, true], [1, 0, true]] as const)(
    '差替えの近点候補もbody順・番号%s/%s・逆順%sで確定しない', (a, b, reverse) => {
      const bodies = [body([edge(a, 20)], { featureId: 'new-a' }), body([edge(b, 16.000001)], { featureId: 'new-b' })];
      const result = resolveReplacementSubShapeReference(reverse ? [...bodies].reverse() : bodies, reference);
      expect(result.status).toBe('ambiguous');
      expect(result.originalReference).toBe(reference);
      expect(result.candidates.map((candidate) => candidate.reference.bodyFeatureId).sort()).toEqual(['new-a', 'new-b']);
    });

  it.each([[0, 1, false], [1, 0, false], [0, 1, true], [1, 0, true]] as const)(
    'F01の同点候補は番号%s/%s・逆順%sでも元参照と両候補を保ち曖昧と返す', (shortIndex, longIndex, reverse) => {
      const edges = [edge(shortIndex, 10, -2), edge(longIndex, 40, 2)];
      const current = body(reverse ? [...edges].reverse() : edges);
      const saved = JSON.stringify(reference), originalOrder = current.edges.map(value => value.index);
      const result = resolveSubShapeReference(current, reference);
      expect(result.status).toBe('ambiguous');
      expect(result.originalReference).toBe(reference);
      expect(result.candidates).toHaveLength(2);
      for (const candidate of result.candidates) expect(candidate.score).toBeCloseTo(0.670381197846483, 15);
      expect(result.candidates.map(value => value.reference.fingerprint).map(value => value.kind === 'edge' ? value.length : null).sort((a, b) => (a ?? 0) - (b ?? 0)))
        .toEqual([10, 40]);
      expect(JSON.stringify(reference)).toBe(saved);
      expect(current.edges.map(value => value.index)).toEqual(originalOrder);
    });
  it.each([[16.000001, 'ambiguous'], [16, 'matched'], [15.999999, 'matched']] as const)(
    '次点の長さ%sでは0.05境界を保ち%sと返す', (length, status) => {
      const current = body([edge(1, 20), edge(2, length)]);
      const scores = scoreSubShapeMatch(current, reference);
      expect(scores?.score).toBeCloseTo(0.8, 15);
      const gap = (scores?.score ?? 0) - (scores?.runnerUpScore ?? 0);
      if (length === 16) expect(gap).toBeCloseTo(SUB_SHAPE_AMBIGUITY_MARGIN, 15);
      else if (length > 16) expect(gap).toBeLessThan(SUB_SHAPE_AMBIGUITY_MARGIN);
      else expect(gap).toBeGreaterThan(SUB_SHAPE_AMBIGUITY_MARGIN);
      expect(resolveSubShapeReference(current, reference).status).toBe(status);
    });
  it('一意な辺は番号変更後も現在の参照と幾何を返し、元参照は保存したままにする', () => {
    const result = resolveSubShapeReference(body([edge(7, 25)]), reference);
    expect(result).toMatchObject({ status: 'matched', match: { reference: { index: 7, fingerprint: { length: 25 } }, geometry: { kind: 'edge', length: 25 } } });
    expect(result.originalReference).toBe(reference);
    expect(reference.index).toBe(99);
    expect(reference.fingerprint).toMatchObject({ length: 20 });
  });
  it('旧ファイルの解析中心を持たない面も一意なら解決する', () => {
    const face: SolidFaceEntry = { index: 4, surfaceKind: 'plane', area: 20, centroid: [0, 0, 0], axis: [0, 0, 1],
      radius: null, triangleOffset: 0, triangleCount: 0 };
    const saved: SubShapeRef = { bodyFeatureId: 'body', index: 99, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 20,
      position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
    expect(resolveSubShapeReference(body([], { faces: [face] }), saved)).toMatchObject({ status: 'matched', match: { geometry: { kind: 'face', area: 20 } } });
  });
  it('別のボディ・候補消失・種類違い・しきい値未満は欠落となる', () => {
    for (const current of [body([edge(0, 20)], { featureId: 'other' }), body([]),
      body([{ ...edge(0, 20), curveKind: 'circle' }]), body([{ ...edge(0, 20), axis: [-1, 0, 0] }])]) {
      const result = resolveSubShapeReference(current, reference);
      expect(result).toEqual({ status: 'missing', originalReference: reference, candidates: [] });
    }
  });
  it('頂点は既存のしきい値を維持し、番号が失われた2候補から推測しない', () => {
    const saved: SubShapeRef = { bodyFeatureId: 'body', index: 99, fingerprint: { kind: 'vertex', position: [0, 0, 0] } };
    const current = body([], { vertices: [{ index: 0, position: [0, -2, 0] }, { index: 1, position: [0, 2, 0] }] });
    expect(resolveSubShapeReference(current, saved).status).toBe('missing');
    expect(resolveSubShapeReference(current, { ...saved, index: 0 }).status).toBe('matched');
  });
  it('頂点番号の重複した同点候補を列挙順で決めず曖昧とする', () => {
    const saved: SubShapeRef = { bodyFeatureId: 'body', index: 0, fingerprint: { kind: 'vertex', position: [0, 0, 0] } };
    for (const positions of [[-2, 2], [2, -2]]) {
      const current = body([], { vertices: positions.map(y => ({ index: 0, position: [0, y, 0] })) });
      expect(resolveSubShapeReference(current, saved)).toMatchObject({ status: 'ambiguous', candidates: [{ reference: { index: 0 } }, { reference: { index: 0 } }] });
    }
  });
});
