import { describe, expect, it } from 'vitest';
import { crossVec3, dotVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { createCircularWeldPath, type CircularWeldPathDefinition, type CircularWeldPathEvidence } from './curvedWeldPath.js';

function circle(): CircularWeldPathEvidence {
  return { kind: 'circle-edge', source: { documentId: 'assembly-1', ownerId: 'owner-1', occurrencePath: ['subassembly', 'part'],
    sourceKey: 'part-revision-3', placementKey: 'placement-2', bodyFeatureId: 'extrude-1', bodyKey: 'body-key-9', edgeIndex: 4 },
  centerMm: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1], radiusMm: 2,
  parameterRange: [0, 2 * Math.PI], orientation: 1 };
}
function definition(evidence = circle()): CircularWeldPathDefinition {
  const [lo, hi] = evidence.parameterRange;
  return { kind: 'circular-weld-path', evidence, intervals: [{ beadId: 'weld-7-segment-0', beadSourceKey: 'bead-revision-1',
    fromParameter: evidence.orientation === 1 ? lo : hi, toParameter: evidence.orientation === 1 ? hi : lo }] };
}
function admitted(value = definition()) {
  const path = createCircularWeldPath(value, structuredClone(value.evidence), structuredClone(value.intervals));
  if (path === null) throw new Error('Independent circular fixture was refused');
  return path;
}
function close(actual: Vec3 | undefined, expected: Vec3) {
  expect(actual).toBeDefined();
  expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, 12));
}

describe('circular weld path geometry proposal (no CAD/native or strength certification)', () => {
  it('keeps a full circle, analytic length, common endpoints, tangent and a continuous right-handed frame', () => {
    const path = admitted();
    expect(path.lengthMm).toBeCloseTo(4 * Math.PI, 12);
    expect(path.occupiedLengthMm).toBe(path.lengthMm); expect(path.gaps).toEqual([]);
    close(path.frameAt(0)?.positionMm, [2, 0, 0]); close(path.frameAt(2 * Math.PI)?.positionMm, [2, 0, 0]);
    close(path.frameAt(0)?.tangent, [0, 1, 0]); close(path.frameAt(2 * Math.PI)?.tangent, [0, 1, 0]);
    close(path.frameAt(Math.PI / 2)?.positionMm, [0, 2, 0]); close(path.frameAt(Math.PI / 2)?.tangent, [-1, 0, 0]);
    close(path.frameAt(Math.PI)?.radial, [-1, 0, 0]); close(path.frameAt(Math.PI)?.binormal, [0, 0, 1]);
    const before = path.frameAt(Math.PI - 1e-8), after = path.frameAt(Math.PI + 1e-8);
    expect(before && after && dotVec3(before.tangent, after.tangent)).toBeCloseTo(1, 12);
  });
  it('preserves an original partial parameter interval without modulo or origin replacement', () => {
    const path = admitted(definition({ ...circle(), parameterRange: [Math.PI / 2, Math.PI] }));
    expect(path.lengthMm).toBeCloseTo(Math.PI, 12);
    expect(path.definition.evidence.parameterRange).toEqual([Math.PI / 2, Math.PI]);
    close(path.frameAt(Math.PI / 2)?.positionMm, [0, 2, 0]); close(path.frameAt(Math.PI)?.positionMm, [-2, 0, 0]);
    expect(path.frameAt(0)).toBeNull(); expect(path.frameAt(3 * Math.PI)).toBeNull();
  });
  it('reverses traversal and tangent/binormal without changing the geometric world point or raw range', () => {
    const path = admitted(definition({ ...circle(), orientation: -1, parameterRange: [0, Math.PI / 2] }));
    expect(path.definition.intervals[0]?.fromParameter).toBe(Math.PI / 2);
    expect(path.definition.intervals[0]?.toParameter).toBe(0);
    close(path.frameAt(Math.PI / 2)?.positionMm, [0, 2, 0]); close(path.frameAt(Math.PI / 2)?.tangent, [1, 0, 0]);
    close(path.frameAt(Math.PI / 2)?.radial, [0, 1, 0]); close(path.frameAt(Math.PI / 2)?.binormal, [0, 0, -1]);
  });
  it('is covariant under a proper rotation and translation, with independent transformed coordinates', () => {
    // R(x,y,z)=(z,x,y), c=(10,-3,5), determinant +1.
    const path = admitted(definition({ ...circle(), centerMm: [10, -3, 5], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0] }));
    close(path.frameAt(0)?.positionMm, [10, -1, 5]); close(path.frameAt(Math.PI / 2)?.positionMm, [10, -3, 7]);
    close(path.frameAt(Math.PI / 2)?.tangent, [0, -1, 0]); close(path.frameAt(0)?.binormal, [1, 0, 0]);
    expect(path.lengthMm).toBeCloseTo(4 * Math.PI, 12);
  });
  it.each([1, -1] as const)('accounts for every irregular interval and leading/interior/trailing gap, direction %s', orientation => {
    const base = definition({ ...circle(), parameterRange: [0, 2], orientation });
    const forward = [{ beadId: 'a', beadSourceKey: 'ka', fromParameter: .1, toParameter: .4 },
      { beadId: 'b', beadSourceKey: 'kb', fromParameter: .8, toParameter: 1.5 }];
    const intervals = orientation === 1 ? forward : [...forward].reverse().map(row => ({ ...row, fromParameter: row.toParameter, toParameter: row.fromParameter }));
    const path = admitted({ ...base, intervals });
    expect(path.lengthMm).toBe(4); expect(path.occupiedLengthMm).toBeCloseTo(2, 12);
    expect(path.gaps.map(gap => gap.lengthMm)).toEqual(orientation === 1 ? [.2, .8, 1] : [1, .8, .2]);
    expect(path.gaps.reduce((sum, gap) => sum + gap.lengthMm, path.occupiedLengthMm)).toBeCloseTo(4, 12);
    expect(path.beadFrameAt('a', .2)).not.toBeNull(); expect(path.beadFrameAt('a', .6)).toBeNull();
    expect(path.beadFrameAt('missing', .2)).toBeNull(); expect(path.frameAt(.6)).not.toBeNull();
  });
  it('keeps touching beads separate, without a gap or duplicated positive-length region', () => {
    const base = definition({ ...circle(), parameterRange: [0, 1] });
    const path = admitted({ ...base, intervals: [{ beadId: 'a', beadSourceKey: 'a1', fromParameter: 0, toParameter: .5 },
      { beadId: 'b', beadSourceKey: 'b1', fromParameter: .5, toParameter: 1 }] });
    expect(path.gaps).toEqual([]); expect(path.definition.intervals).toHaveLength(2); expect(path.occupiedLengthMm).toBe(2);
    close(path.beadFrameAt('a', .5)?.positionMm, path.beadFrameAt('b', .5)?.positionMm ?? [NaN, NaN, NaN]);
  });
  it('uses one common world point for force/moment transfer and virtual work (not a curved stiffness solver)', () => {
    const path = admitted(definition({ ...circle(), centerMm: [0, 1, 3] }));
    const x = path.frameAt(0)?.positionMm;
    if (x === undefined) throw new Error('Missing point');
    // Contract independent point x=(2,1,3), pA=(0,0,0), pB=(4,-1,2), F=(5,-2,7).
    const pA: Vec3 = [0, 0, 0], pB: Vec3 = [4, -1, 2], force: Vec3 = [5, -2, 7], opposite: Vec3 = [-5, 2, -7];
    const mA = crossVec3(subVec3(x, pA), force), mB = crossVec3(subVec3(x, pB), opposite);
    close(mA, [13, 1, -9]); close(mB, [-16, -19, 6]);
    const aboutB = crossVec3(pB, opposite);
    close([mA[0] + mB[0] + aboutB[0], mA[1] + mB[1] + aboutB[1], mA[2] + mB[2] + aboutB[2]], [0, 0, 0]);
    // delta uB=(.01,.02,.03), thetaB=(.001,.002,.003), A fixed:
    // point displacement (.006,.013,.036), point work -.030+.026-.252=-.256.
    const work = dotVec3(opposite, [.01, .02, .03]) + dotVec3(mB, [.001, .002, .003]);
    expect(work).toBeCloseTo(-.256, 12);
    expect(dotVec3(opposite, [.01, .02, .03])).toBeCloseTo(-.220, 12);
  });
  it.each([
    ['zero radius', { radiusMm: 0 }], ['negative radius', { radiusMm: -2 }], ['infinite radius', { radiusMm: Infinity }],
    ['NaN center', { centerMm: [NaN, 0, 0] }], ['nonunit basis', { xAxis: [2, 0, 0] }], ['parallel basis', { yAxis: [1, 0, 0] }],
    ['left handed', { normal: [0, 0, -1] }], ['zero basis', { xAxis: [0, 0, 0] }],
    ['zero range', { parameterRange: [0, 0] }], ['decreasing raw range', { parameterRange: [1, 0] }],
    ['two turns', { parameterRange: [0, 4 * Math.PI] }], ['nonfinite range', { parameterRange: [0, Infinity] }],
    ['missing orientation', { orientation: undefined }], ['ellipse', { kind: 'ellipse-edge' }],
    ['missing source', { source: undefined }], ['invalid source', { source: {} }],
  ])('rejects %s without normalizing/clamping/filling it', (_name, change) => {
    const bad = { ...circle(), ...change };
    expect(createCircularWeldPath({ ...definition(), evidence: bad }, bad, definition().intervals)).toBeNull();
  });
  it.each(['documentId', 'ownerId', 'sourceKey', 'placementKey', 'bodyFeatureId', 'bodyKey', 'edgeIndex', 'occurrencePath'])('rejects stale %s', key => {
    const value = definition(), current = { ...value.evidence, source: { ...value.evidence.source,
      [key]: key === 'edgeIndex' ? 5 : key === 'occurrencePath' ? ['another', 'part'] : 'changed' } };
    expect(createCircularWeldPath(value, current, value.intervals)).toBeNull();
  });
  it('rejects a changed geometry under the same identity and refuses native metadata missing its parameter basis', () => {
    const value = definition();
    expect(createCircularWeldPath(value, { ...value.evidence, radiusMm: 3 }, value.intervals)).toBeNull();
    expect(createCircularWeldPath(value, { curveKind: 'circle', axisOrigin: [0, 0, 0], axis: [0, 0, 1], radius: 2 }, value.intervals)).toBeNull();
    expect(createCircularWeldPath({ cylindricalRadius: 2, station: 0, length: 10 }, value.evidence, value.intervals)).toBeNull();
  });
  it.each([
    ['outside', [{ beadId: 'a', beadSourceKey: 'a1', fromParameter: -1e-12, toParameter: 1 }]],
    ['zero interval', [{ beadId: 'a', beadSourceKey: 'a1', fromParameter: 1, toParameter: 1 }]],
    ['reverse interval', [{ beadId: 'a', beadSourceKey: 'a1', fromParameter: 1, toParameter: 0 }]],
    ['NaN interval', [{ beadId: 'a', beadSourceKey: 'a1', fromParameter: NaN, toParameter: 1 }]],
    ['overlap', [{ beadId: 'a', beadSourceKey: 'a1', fromParameter: 0, toParameter: 1 }, { beadId: 'b', beadSourceKey: 'b1', fromParameter: .9, toParameter: 2 }]],
    ['unordered', [{ beadId: 'a', beadSourceKey: 'a1', fromParameter: 2, toParameter: 3 }, { beadId: 'b', beadSourceKey: 'b1', fromParameter: 0, toParameter: 1 }]],
    ['duplicate bead', [{ beadId: 'a', beadSourceKey: 'a1', fromParameter: 0, toParameter: 1 }, { beadId: 'a', beadSourceKey: 'a1', fromParameter: 2, toParameter: 3 }]],
  ])('rejects %s', (_name, intervals) => {
    expect(createCircularWeldPath({ ...definition(), intervals }, circle(), intervals)).toBeNull();
  });
  it('refuses missing/extra/changed actual beads and the current 64-patch limit', () => {
    const value = definition();
    expect(createCircularWeldPath(value, circle(), [])).toBeNull();
    expect(createCircularWeldPath(value, circle(), [{ ...value.intervals[0], beadSourceKey: 'old' }])).toBeNull();
    expect(createCircularWeldPath(value, circle(), [{ ...value.intervals[0], toParameter: 1 }])).toBeNull();
    expect(createCircularWeldPath(value, circle(), [...value.intervals, { beadId: 'extra', beadSourceKey: 'e', fromParameter: 0, toParameter: 1 }])).toBeNull();
    const intervals = Array.from({ length: 65 }, (_, i) => ({ beadId: String(i), beadSourceKey: 'x', fromParameter: i / 100, toParameter: (i + 1) / 100 }));
    expect(createCircularWeldPath({ ...value, intervals }, circle(), intervals)).toBeNull();
  });
  it('owns an immutable snapshot; external mutation and nonfinite/outside samples cannot become evidence', () => {
    const input = structuredClone(definition()), before = JSON.stringify(input), path = admitted(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(path.definition.evidence.centerMm)).toBe(true);
    expect(Object.isFrozen(path.definition.intervals)).toBe(true); expect(Object.isFrozen(path.gaps)).toBe(true);
    Object.assign(input.evidence, { radiusMm: 100 });
    expect(path.lengthMm).toBeCloseTo(4 * Math.PI, 12);
    for (const parameter of [NaN, Infinity, -Infinity, -1e-12, 2 * Math.PI + 1e-12]) {
      expect(path.frameAt(parameter)).toBeNull(); expect(path.beadFrameAt('weld-7-segment-0', parameter)).toBeNull();
    }
  });
});
