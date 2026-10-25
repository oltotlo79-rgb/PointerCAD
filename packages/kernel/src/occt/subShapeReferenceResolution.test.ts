import { describe, expect, it } from 'vitest';
import type { SolidEdgeInfo, SolidFaceInfo, SubShapeQuery } from '../types.js';
import { resolveEdgeReference, resolveFaceReference, resolveSubShapeCandidates, resolveVertexReference,
  SUB_SHAPE_AMBIGUITY_MARGIN } from './matchSubShape.js';

const query: Extract<SubShapeQuery, { kind: 'edge' }> = {
  kind: 'edge', index: 99, curveKind: 'line', length: 20, position: [0, 0, 0], axis: [1, 0, 0], radius: null,
};
function edge(index: number, length: number, y = 0): SolidEdgeInfo {
  return { index, curveKind: 'line', length, midpoint: [0, y, 0], axis: [1, 0, 0], radius: null,
    start: [-length / 2, y, 0], end: [length / 2, y, 0], segmentOffset: 0, segmentCount: 1 };
}
const scale = Math.sqrt(30_000) / 2;

describe('kernelの共通参照判定', () => {
  it.each([[0, 1, false], [1, 0, false], [0, 1, true], [1, 0, true]] as const)(
    'F01の10/40候補を番号%s/%s・逆順%sでも採用しない', (a, b, reverse) => {
      const candidates = [edge(a, 10, -2), edge(b, 40, 2)];
      const before = JSON.stringify({ candidates, query });
      const result = resolveEdgeReference(reverse ? [...candidates].reverse() : candidates, query, scale);
      expect(result.status).toBe('ambiguous');
      expect(result.candidates).toHaveLength(2);
      for (const candidate of result.candidates) expect(candidate.score).toBeCloseTo(0.670381197846483, 15);
      expect(result.candidates.map((item) => item.candidate.length).sort((x, y) => x - y)).toEqual([10, 40]);
      expect(JSON.stringify({ candidates, query })).toBe(before);
    });

  it.each([[16.000001, 'ambiguous'], [16, 'matched'], [15.999999, 'matched']] as const)(
    '辺と面の次点%sで0.05境界は%s', (size, status) => {
      const edges = [edge(1, 20), edge(2, size)];
      const edgeResult = resolveEdgeReference(edges, query, scale);
      const faces: SolidFaceInfo[] = edges.map((item) => ({ index: item.index, surfaceKind: 'plane', area: item.length,
        centroid: item.midpoint, axis: item.axis, radius: null, triangleOffset: 0, triangleCount: 0 }));
      const faceResult = resolveFaceReference(faces, { kind: 'face', index: 99, surfaceKind: 'plane', area: 20,
        position: [0, 0, 0], axis: [1, 0, 0], radius: null }, scale);
      for (const result of [edgeResult, faceResult]) {
        expect(result.status).toBe(status);
        const gap = result.candidates[0].score - result.candidates[1].score;
        if (size === 16) expect(gap).toBeCloseTo(SUB_SHAPE_AMBIGUITY_MARGIN, 15);
        else if (size > 16) expect(gap).toBeLessThan(SUB_SHAPE_AMBIGUITY_MARGIN);
        else expect(gap).toBeGreaterThan(SUB_SHAPE_AMBIGUITY_MARGIN);
      }
    });

  it('頂点は番号を失えば欠落、同じ番号の等点候補なら曖昧、一意なら現在位置を返す', () => {
    const saved: Extract<SubShapeQuery, { kind: 'vertex' }> = { kind: 'vertex', index: 99, position: [0, 0, 0] };
    expect(resolveVertexReference([{ index: 1, position: [0, 0, 0] }], saved, scale).status).toBe('missing');
    for (const signs of [[-1, 1], [1, -1]]) {
      expect(resolveVertexReference(signs.map((sign) => ({ index: 99, position: [0, sign, 0] })), saved, scale).status).toBe('ambiguous');
    }
    expect(resolveVertexReference([{ index: 99, position: [0, 2, 0] }], saved, scale)).toMatchObject({ status: 'matched',
      match: { candidate: { position: [0, 2, 0] } } });
  });

  it('種類違い・しきい値未満・非有限点を採用しない', () => {
    expect(resolveEdgeReference([{ ...edge(0, 20), curveKind: 'circle' }], query, scale).status).toBe('missing');
    expect(resolveEdgeReference([{ ...edge(0, 20), axis: [-1, 0, 0] }], query, scale).status).toBe('missing');
    expect(resolveSubShapeCandidates([{ score: NaN }, { score: Infinity }, { score: 0.599999 }])).toEqual({ status: 'missing', candidates: [] });
  });

  it('5000候補を1秒以内に列挙し、一意な現在参照と元の候補配列を保持する', () => {
    const candidates = Array.from({ length: 5000 }, (_, index) => edge(index, 20));
    const selected = { ...query, index: 2345 };
    const started = performance.now();
    const result = resolveEdgeReference(candidates, selected, scale);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.candidates).toHaveLength(5000);
    expect(result).toMatchObject({ status: 'matched', match: { index: 2345, score: 1 } });
    if (result.status !== 'matched') throw new Error('一意な選択なし');
    expect(result.match.candidate).toBe(candidates[2345]);
    expect(candidates[0].index).toBe(0);
  });
});
