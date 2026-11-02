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

describe('circle runtime basis matching', () => {
  function circleEdge(): SolidEdgeEntry {
    return { index: 7, curveKind: 'circle', length: Math.PI, midpoint: [-4 / Math.PI, 4 / Math.PI, 0],
      start: [0, 2, 0], end: [-2, 0, 0], axis: [0, 0, 1], axisOrigin: [0, 0, 0], radius: 2,
      segmentOffset: 0, segmentCount: 1 };
  }
  const saved: SubShapeRef = { bodyFeatureId: 'body', index: 7, fingerprint: { kind: 'edge', curveKind: 'circle',
    length: Math.PI, position: [-4 / Math.PI, 4 / Math.PI, 0], axis: [0, 0, 1], radius: 2 } };
  it.each([1, -1] as const)('carries current orientation %s to both lookup paths, without saving it or changing the score', orientation => {
    const circleBasis: NonNullable<SolidEdgeEntry['circleBasis']> = { origin: [0, 0, 0], xAxis: [1, 0, 0],
      yAxis: [0, 1, 0], normal: [0, 0, 1], parameterRange: [Math.PI / 2, Math.PI], orientation };
    const legacy = body([circleEdge()]), current = body([{ ...circleEdge(), circleBasis }]), before = JSON.stringify(saved);
    expect(selectMateTargetGeometry(current, saved)).toMatchObject({ circleBasis });
    const [candidate] = subShapeMatchCandidates(current, saved);
    expect(candidate.geometry).toEqual(selectMateTargetGeometry(current, saved));
    expect(candidate.reference).toEqual(saved); expect(candidate.reference.fingerprint).not.toHaveProperty('circleBasis');
    expect(scoreSubShapeMatch(current, saved)).toEqual(scoreSubShapeMatch(legacy, saved));
    expect(rematchSubShapeRef([current], saved)).toEqual(rematchSubShapeRef([legacy], saved));
    const resolved = resolveSubShapeReference(current, saved);
    expect(resolved.status).toBe('matched');
    if (resolved.status !== 'matched') throw new Error('Expected a uniquely matched current circle');
    expect(resolved.match.geometry).toMatchObject({ circleBasis }); expect(JSON.stringify(saved)).toBe(before);
  });
  it('omits absent legacy metadata and cannot leak circle evidence from a non-circle fixture', () => {
    const current = body([circleEdge()]);
    expect(selectMateTargetGeometry(current, saved)).not.toHaveProperty('circleBasis');
    expect(subShapeMatchCandidates(current, saved)[0].geometry).not.toHaveProperty('circleBasis');
    const circleBasis: NonNullable<SolidEdgeEntry['circleBasis']> = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0],
      normal: [0, 0, 1], parameterRange: [0, 1], orientation: 1 };
    const line = body([{ ...edge(0, 20, 0), circleBasis }]);
    expect(selectMateTargetGeometry(line, reference)).not.toHaveProperty('circleBasis');
    expect(subShapeMatchCandidates(line, reference)[0].geometry).not.toHaveProperty('circleBasis');
  });
});

describe('complete face boundary runtime evidence', () => {
  function current(boundaryEdgeIndices?: readonly number[]) {
    const face: SolidFaceEntry = { index: 0, surfaceKind: 'plane', area: 4,
      centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 0,
      ...(boundaryEdgeIndices === undefined ? {} : { boundaryEdgeIndices }) };
    const saved: SubShapeRef = { bodyFeatureId: 'body', index: 0, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 4, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
    return { body: { ...body([edge(3, 2, 0), edge(7, 2, 2)]), faces: [face] }, saved };
  }
  it('owns the complete current set in both paths and matched geometry without saving it', () => {
    const indices = [3, 7], fixture = current(indices), before = JSON.stringify(fixture.saved);
    const selected = selectMateTargetGeometry(fixture.body, fixture.saved);
    const [candidate] = subShapeMatchCandidates(fixture.body, fixture.saved);
    const resolved = resolveSubShapeReference(fixture.body, fixture.saved);
    expect(selected?.boundaryEdgeIndices).toEqual([3, 7]);
    expect(candidate.geometry.boundaryEdgeIndices).toEqual([3, 7]);
    expect(resolved.status).toBe('matched');
    if (resolved.status !== 'matched') throw new Error('Expected current face');
    expect(resolved.match.geometry.boundaryEdgeIndices).toEqual([3, 7]);
    expect(selected?.boundaryEdgeIndices).not.toBe(indices);
    expect(Object.isFrozen(selected?.boundaryEdgeIndices)).toBe(true);
    indices[0] = 99;
    expect(selected?.boundaryEdgeIndices).toEqual([3, 7]);
    expect(candidate.geometry.boundaryEdgeIndices).toEqual([3, 7]);
    expect(candidate.reference.fingerprint).not.toHaveProperty('boundaryEdgeIndices');
    expect(JSON.stringify(fixture.saved)).toBe(before);
  });
  it.each([undefined, [], [3, 3], [-1], [0.5], [Number.NaN], [Number.POSITIVE_INFINITY], [3, 99]])(
    'does not promote absent or invalid boundary evidence %s', boundary => {
      const fixture = current(boundary);
      expect(selectMateTargetGeometry(fixture.body, fixture.saved)).not.toHaveProperty('boundaryEdgeIndices');
      expect(subShapeMatchCandidates(fixture.body, fixture.saved)[0].geometry).not.toHaveProperty('boundaryEdgeIndices');
    });
  it('rejects an ambiguous actual edge table without changing face matching or the saved reference', () => {
    const fixture = current([3, 7]);
    const ambiguous = { ...fixture.body, edges: [...fixture.body.edges, edge(3, 2, 9)] };
    expect(selectMateTargetGeometry(ambiguous, fixture.saved)).not.toHaveProperty('boundaryEdgeIndices');
    expect(resolveSubShapeReference(ambiguous, fixture.saved).status).toBe('matched');
    expect(rematchSubShapeRef([ambiguous], fixture.saved)).toEqual(fixture.saved);
  });
});
