import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { SolidBody, SolidEdgeEntry, SolidFaceEntry } from './solidContracts.js';
import { rematchSubShapeRef, scoreSubShapeMatch, selectMateTargetGeometry, selectSubShape, subShapeMatchCandidates } from './subShapeMatching.js';
import { resolveSubShapeReference } from './referenceResolution.js';
import { toSubShapeQuery } from './subShapeQuery.js';

const reference: SubShapeRef = { bodyFeatureId: 'body', index: 99, fingerprint: {
  kind: 'edge', curveKind: 'line', length: 20, position: [0, 0, 0], axis: [1, 0, 0], radius: null,
} };
const edge = (index: number, length: number, y: number): SolidEdgeEntry => ({ index, curveKind: 'line', length,
  midpoint: [0, y, 0], start: [-length / 2, y, 0], end: [length / 2, y, 0], axis: [1, 0, 0], radius: null, segmentCount: 1, segmentOffset: 0 });
function body(edges: readonly SolidEdgeEntry[]): SolidBody {
  return { featureId: 'body', mesh: { positions: new Float32Array([-50, -50, -50, 50, 50, 50]),
    normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
    isValid: true, volume: 1, faces: [], edges, vertices: [], threadMarks: [] };
}

describe('既存の部分形状選択APIと共通判定の境界', () => {
  it.each([true, false, undefined])('keeps current cylinder material side %s out of saved identity', exterior => {
    const face: SolidFaceEntry = { index: 0, surfaceKind: 'cylinder', area: 100 * Math.PI,
      centroid: [0, 0, 5], axis: [0, 0, 1], axisOrigin: [0, 0, 0], cylinderSpan: [0, 10],
      radius: 5, triangleOffset: 0, triangleCount: 0,
      ...(exterior === undefined ? {} : { cylinderExterior: exterior }) };
    const saved: SubShapeRef = { bodyFeatureId: 'body', index: 0, fingerprint: { kind: 'face',
      surfaceKind: 'cylinder', area: face.area, position: face.centroid, axis: face.axis, radius: 5 } };
    const current: SolidBody = { ...body([]), faces: [face] };
    const before = JSON.stringify(saved);
    const geometry = selectMateTargetGeometry(current, saved);
    const [candidate] = subShapeMatchCandidates(current, saved);
    expect(candidate.geometry).toEqual(geometry);
    if (exterior === undefined) expect(geometry).not.toHaveProperty('cylinderExterior');
    else expect(geometry).toHaveProperty('cylinderExterior', exterior);
    expect(candidate.reference.fingerprint).not.toHaveProperty('cylinderExterior');
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('全周の範囲と解析点は現在幾何の二経路へ届き、保存指紋へは入らない', () => {
    const face: SolidFaceEntry = { index: 0, surfaceKind: 'cylinder', area: 100 * Math.PI,
      centroid: [0, 0, 5], axis: [0, 0, 1], axisOrigin: [0, 0, 0], cylinderSpan: [0, 10],
      radius: 5, triangleOffset: 0, triangleCount: 0 };
    const saved: SubShapeRef = { bodyFeatureId: 'body', index: 0, fingerprint: { kind: 'face',
      surfaceKind: 'cylinder', area: face.area, position: face.centroid, axis: face.axis, radius: 5 } };
    const current: SolidBody = { ...body([]), faces: [face] };
    const before = JSON.stringify(saved);
    expect(selectMateTargetGeometry(current, saved)).toMatchObject({ axisOrigin: [0, 0, 0], cylinderSpan: [0, 10] });
    const [candidate] = subShapeMatchCandidates(current, saved);
    expect(candidate.geometry).toEqual(selectMateTargetGeometry(current, saved));
    expect(candidate.reference.fingerprint).toEqual(saved.fingerprint);
    expect(candidate.reference.fingerprint).not.toHaveProperty('cylinderSpan');
    expect(JSON.stringify(saved)).toBe(before);
    const partial: SolidBody = { ...current, faces: [{ ...face, cylinderSpan: null }] };
    expect(selectMateTargetGeometry(partial, saved)).not.toHaveProperty('cylinderSpan');
    expect(subShapeMatchCandidates(partial, saved)[0].geometry).not.toHaveProperty('cylinderSpan');
  });
  it('部分の円筒面の今の軸方向範囲は現在幾何の二経路へ届き、保存指紋へは入らず、全周の範囲とは別に扱う', () => {
    const face: SolidFaceEntry = { index: 0, surfaceKind: 'cylinder', area: 40 * Math.PI,
      centroid: [0, 0, 5], axis: [0, 0, 1], axisOrigin: [0, 0, 0], cylinderSpan: null, cylinderAxialExtent: [2, 6],
      radius: 5, triangleOffset: 0, triangleCount: 0 };
    const saved: SubShapeRef = { bodyFeatureId: 'body', index: 0, fingerprint: { kind: 'face',
      surfaceKind: 'cylinder', area: 40 * Math.PI, position: [0, 0, 5], axis: [0, 0, 1], radius: 5 } };
    const current: SolidBody = { ...body([]), faces: [face] };
    const before = JSON.stringify(saved);
    const selected = selectMateTargetGeometry(current, saved);
    expect(selected).toMatchObject({ axisOrigin: [0, 0, 0], cylinderAxialExtent: [2, 6] });
    expect(selected).not.toHaveProperty('cylinderSpan');
    const [candidate] = subShapeMatchCandidates(current, saved);
    expect(candidate.geometry).toEqual(selected);
    expect(candidate.reference.fingerprint).toEqual(saved.fingerprint);
    expect(candidate.reference.fingerprint).not.toHaveProperty('cylinderAxialExtent');
    expect(JSON.stringify(saved)).toBe(before);
    const absent: SolidBody = { ...current, faces: [{ ...face, cylinderAxialExtent: null }] };
    expect(selectMateTargetGeometry(absent, saved)).not.toHaveProperty('cylinderAxialExtent');
    expect(subShapeMatchCandidates(absent, saved)[0].geometry).not.toHaveProperty('cylinderAxialExtent');
  });
  it('native queryへ保存 origin-v1 をそのまま渡し、別の feature ID を混ぜない', () => {
    const origin = { version: 1 as const, shapeKind: 'edge' as const, identity: {
      kind: 'box-edge' as const, featureId: 'source-box', role: 'top-front' as const,
    } };
    const saved: SubShapeRef = { ...reference, bodyFeatureId: 'current-body', origin };
    expect(toSubShapeQuery(saved)).toMatchObject({ kind: 'edge', index: 99, origin });
    expect(saved.bodyFeatureId).toBe('current-body');
    expect(origin.identity.featureId).toBe('source-box');
  });
  it.each([[0, 1, 10], [1, 0, 40]])('番号%s/%sの既存API互換を維持し、採用判定だけが同点を拒否する', (first, second, legacyLength) => {
    const current = body([edge(first, 10, -2), edge(second, 40, 2)]);
    const saved = JSON.stringify(reference);
    expect(rematchSubShapeRef([current], reference)?.fingerprint).toMatchObject({ kind: 'edge', length: legacyLength });
    expect(selectMateTargetGeometry(current, reference)).toMatchObject({ kind: 'edge', length: legacyLength });
    expect(selectSubShape(current, reference)?.position).toEqual([0, legacyLength === 10 ? -2 : 2, 0]);
    const candidates = subShapeMatchCandidates(current, reference), scores = scoreSubShapeMatch(current, reference);
    expect(scores).toEqual({ index: candidates[0].reference.index, score: candidates[0].score, runnerUpScore: candidates[1].score });
    expect(resolveSubShapeReference(current, reference).status).toBe('ambiguous');
    expect(JSON.stringify(reference)).toBe(saved);
  });
  it('一意な候補の既存選択と共通結果が同じ現在の幾何を返す', () => {
    const current = body([edge(8, 25, 1)]), result = resolveSubShapeReference(current, reference);
    expect(result.status).toBe('matched');
    if (result.status !== 'matched') throw new Error('一意な辺が必要です');
    expect(result.match.reference).toEqual(rematchSubShapeRef([current], reference));
    expect(result.match.geometry).toEqual(selectMateTargetGeometry(current, reference));
    expect(result.match.geometry.position).toEqual(selectSubShape(current, reference)?.position);
    expect(result.candidates).toHaveLength(1);
    expect(scoreSubShapeMatch(current, reference)?.runnerUpScore).toBeNull();
  });
});
