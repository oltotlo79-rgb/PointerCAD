import { describe, expect, it } from 'vitest';

import type { StandardPartSource } from '../resolveAssembly.js';
import { buildStandardPart, buildStandardPartFromSource, standardPartNominalVolume } from '../standard/buildStandardPart.js';
import { resolvePart } from '../../part/resolvePart.js';
import { applyPlacementToPoint } from '../placementMath.js';
import { buildCircularFilletWeldGeometry } from './circularFilletWeldGeometry.js';
import { createCircularFilletWeldSource, readCircularFilletWeldSource, type CircularFilletWeldSavedOptions, type CircularWeldSavedParent } from './circularFilletWeldSource.js';
import { createCircularWeldPath, readCircularWeldPathSnapshot } from './curvedWeldPath.js';
import { buildFilletWeldPart, createFilletWeldSource, filletWeldSegmentOptions } from './filletWeldPart.js';

function payload(): CircularFilletWeldSavedOptions {
  const base = { documentId: 'assembly-1', ownerId: 'cylinder', occurrencePath: ['child', 'cylinder'], sourceKey: 'part:c@3',
    placementKey: 'pose-2', bodyFeatureId: 'primitive-1', bodyKey: 'body-c' };
  const cylinder: CircularWeldSavedParent = { ...base, role: 'cylinder', reference: { bodyFeatureId: 'primitive-1', index: 2,
    fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 200 * Math.PI, position: [0, 0, 5], axis: [0, 0, 1], radius: 10 },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'cylinder-face', featureId: 'primitive-1', role: 'side' } } } };
  const plane: CircularWeldSavedParent = { ...base, role: 'plane', ownerId: 'plate', occurrencePath: ['child', 'plate'],
    sourceKey: 'part:p@4', bodyKey: 'body-p', reference: { bodyFeatureId: 'primitive-1', index: 1,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1600, position: [0, 0, 0], axis: [0, 0, 1], radius: null },
      origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'primitive-1', role: 'top' } } } };
  return { weldId: 'weld-1', beadId: 'bead-1', radialDirection: 1, normalDirection: 1, parents: [plane, cylinder],
    path: { kind: 'circular-weld-path', evidence: { kind: 'circle-edge', source: { ...base, edgeIndex: 0 },
      centerMm: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1], radiusMm: 10,
      parameterRange: [0, Math.PI / 2], orientation: 1 },
    intervals: [{ beadId: 'bead-1', beadSourceKey: 'draft-input-epoch-7', fromParameter: 0, toParameter: Math.PI / 2 }] } };
}
function source(value = payload()): StandardPartSource {
  const result = createCircularFilletWeldSource(3, 4, value);
  if (result === null) throw new Error('Independent saved circular fixture refused');
  return result;
}
function plan(s: StandardPartSource) {
  const part = buildStandardPartFromSource(s);
  if (part === null) throw new Error('Saved part missing');
  const resolved = resolvePart(part), result = resolved.steps[0]?.plan;
  expect(resolved.errors).toEqual([]);
  if (result?.kind !== 'revolve') throw new Error('Expected existing revolve');
  return result;
}
function volume(s: StandardPartSource): number {
  const p = plan(s), points = p.profile.map(row => { if (row.kind !== 'segment') throw new Error('Triangle expected'); return row.from; });
  expect(points).toHaveLength(3);
  const [a, b, c] = points;
  return Math.abs(p.angle) * Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2 * (a[0] + b[0] + c[0]) / 3;
}
function patch(s: StandardPartSource, value: unknown): StandardPartSource {
  return { ...s, options: { weldCircular: JSON.stringify(value) } };
}

describe('saved circular v5: geometry restoration is not current admission', () => {
  it('writes one canonical option, exact legs and historical full provenance without a self-source key', () => {
    const input = payload(), before = JSON.stringify(input), s = source(input), saved = readCircularFilletWeldSource(s);
    expect(s).toMatchObject({ kind: 'standardPart', catalog: 'filletWeld', catalogRevision: 'weld-1', generatorRevision: 'fillet-weld-5', size: '3x4' });
    expect(Object.keys(s.options)).toEqual(['weldCircular']);
    expect(saved?.options).toEqual(input);
    expect(saved?.section).toEqual({ beadId: 'bead-1', radialLegMm: 3, normalLegMm: 4, radialDirection: 1, normalDirection: 1 });
    expect(saved?.options.path.intervals[0]?.beadSourceKey).toBe('draft-input-epoch-7');
    expect(JSON.stringify(input)).toBe(before);
    expect(createCircularFilletWeldSource(3, 4, saved?.options)).toEqual(s);
    expect(Object.isFrozen(saved?.options.parents[0].reference.fingerprint.position)).toBe(true);
    Reflect.set(input.path.evidence.centerMm, '0', 999);
    expect(saved?.options.path.evidence.centerMm).toEqual([0, 0, 0]);
  });
  it.each([[1, 33], [-1, 27]] as const)('reconstructs radial side %s using independent triangle/Pappus volume %spi', (radialDirection, coefficient) => {
    expect(volume(source({ ...payload(), radialDirection }))).toBeCloseTo(coefficient * Math.PI, 11);
    expect(plan(source({ ...payload(), radialDirection })).profile.map(row => row.kind === 'segment' ? row.from : null))
      .toEqual([[10, 0, 0], [radialDirection === 1 ? 13 : 7, 0, 0], [10, 0, 4]]);
  });
  it('keeps a full turn and two separated quarter-quarter intervals without filling the gap', () => {
    const input = payload(), e = input.path.evidence;
    const full = { ...input, path: { ...input.path, evidence: { ...e, parameterRange: [0, 2 * Math.PI] as const },
      intervals: [{ ...input.path.intervals[0], toParameter: 2 * Math.PI }] } };
    expect(volume(source(full))).toBeCloseTo(132 * Math.PI, 11);
    const intervals = [{ beadId: 'bead-1', beadSourceKey: 'draft-a', fromParameter: 0, toParameter: Math.PI / 4 },
      { beadId: 'bead-2', beadSourceKey: 'draft-b', fromParameter: Math.PI / 2, toParameter: 3 * Math.PI / 4 }];
    const split = { ...input, path: { ...input.path, evidence: { ...e, parameterRange: [0, 3 * Math.PI / 4] as const }, intervals } };
    const first = source(split), second = source({ ...split, beadId: 'bead-2' });
    expect(volume(first) + volume(second)).toBeCloseTo(33 * Math.PI, 11);
    expect(readCircularFilletWeldSource(first)?.options.path.intervals).toEqual(intervals);
    expect(readCircularWeldPathSnapshot(split.path)?.gaps).toEqual([{ fromParameter: Math.PI / 4, toParameter: Math.PI / 2, lengthMm: 10 * Math.PI / 4 }]);
  });
  it.each([1, -1] as const)('retains original partial interval and world placement once with orientation %s', orientation => {
    const input = payload(), e = input.path.evidence;
    const path = { ...input.path, evidence: { ...e, orientation, centerMm: [11, 13, 17] as const, xAxis: [0, 1, 0] as const,
      yAxis: [0, 0, 1] as const, normal: [1, 0, 0] as const, parameterRange: [Math.PI / 2, Math.PI] as const },
    intervals: [{ ...input.path.intervals[0], fromParameter: orientation === 1 ? Math.PI / 2 : Math.PI, toParameter: orientation === 1 ? Math.PI : Math.PI / 2 }] };
    const s = source({ ...input, path }), saved = readCircularFilletWeldSource(s);
    if (saved === null) throw new Error('Saved fixture missing');
    const current = buildCircularFilletWeldGeometry(path, structuredClone(path.evidence), structuredClone(path.intervals), saved.section);
    if (current === null) throw new Error('Independent current fixture missing');
    expect(buildStandardPartFromSource(s)).toEqual(current.part);
    expect(current.placement.position).toEqual([11, 13, 17]);
    const point = applyPlacementToPoint(current.placement, [10, 0, 0]);
    const expected = orientation === 1 ? [11, 13, 27] : [11, 3, 17];
    expected.forEach((value, i) => expect(point[i]).toBeCloseTo(value, 11));
    expect(saved.options.path.evidence.parameterRange).toEqual([Math.PI / 2, Math.PI]);
    expect(volume(s)).toBeCloseTo(33 * Math.PI, 11);
  });
  it.each(['documentId', 'ownerId', 'sourceKey', 'placementKey', 'bodyFeatureId', 'bodyKey'] as const)('restores historical geometry while current %s change is rejected', key => {
    const p = payload(), saved = readCircularFilletWeldSource(source(p));
    if (saved === null) throw new Error('Missing saved fixture');
    expect(buildStandardPartFromSource(source(p))).not.toBeNull();
    const current = { ...p.path.evidence, source: { ...p.path.evidence.source, [key]: 'changed' } };
    expect(createCircularWeldPath(p.path, current, p.path.intervals)).toBeNull();
    expect(buildCircularFilletWeldGeometry(p.path, current, p.path.intervals, saved.section)).toBeNull();
  });
  it('rejects missing/changed current beads despite successful snapshot reconstruction', () => {
    const p = payload(); expect(readCircularWeldPathSnapshot(p.path)).not.toBeNull();
    expect(createCircularWeldPath(p.path, p.path.evidence, [])).toBeNull();
    expect(createCircularWeldPath(p.path, p.path.evidence, [{ ...p.path.intervals[0], beadSourceKey: 'later' }])).toBeNull();
  });
  it.each([0, -0, -1, NaN, Infinity, 10])('rejects invalid or axis-touching inward radial leg %s', leg => {
    expect(createCircularFilletWeldSource(leg, 4, { ...payload(), radialDirection: -1 })).toBeNull();
  });
  it.each(['fillet-weld-1', 'fillet-weld-2', 'fillet-weld-3', 'fillet-weld-4', 'fillet-weld-6'])('never reconstructs circular options as generator %s', generatorRevision => {
    const s = { ...source(), generatorRevision };
    expect(readCircularFilletWeldSource(s)).toBeNull();
    expect(buildStandardPartFromSource(s)).toBeNull();
  });
  it('keeps legacy source bytes/shape and rejects the circular marker in every old entry', () => {
    const old = createFilletWeldSource(3, 4, { weldId: 'old', segment: 0, station: 0, length: 5, contactLength: 10, parts: ['a', 'b'] });
    const before = JSON.stringify(old), shape = buildFilletWeldPart(old);
    expect(buildStandardPartFromSource(old)).toEqual(shape); expect(JSON.stringify(old)).toBe(before);
    const mixed = { ...old, options: { ...old.options, weldCircular: source().options.weldCircular ?? '' } };
    expect(filletWeldSegmentOptions(mixed.options)).toBeNull(); expect(buildFilletWeldPart(mixed)).toBeNull();
    expect(buildStandardPart('filletWeld', mixed.size, mixed.options)).toBeNull();
    expect(standardPartNominalVolume('filletWeld', mixed.size, mixed.options)).toBeNull();
  });
  it.each(['length', 'weldParts', 'weldCylinderRadius', 'extra'])('rejects extra option %s', key => {
    const s = source(); expect(readCircularFilletWeldSource({ ...s, options: { ...s.options, [key]: '1' } })).toBeNull();
  });
  it('rejects extra/duplicate JSON keys and noncanonical text without changing original bytes', () => {
    const s = source(), raw = s.options.weldCircular ?? '', before = JSON.stringify(s);
    for (const weldCircular of [raw + ' ', raw.replace('{', '{"beadId":"bead-1",'), raw.replace('{', '{"extra":1,'), '{', raw.replace('"radiusMm":10', '"radiusMm":-0')]) {
      expect(readCircularFilletWeldSource({ ...s, options: { weldCircular } })).toBeNull();
    }
    expect(JSON.stringify(s)).toBe(before);
  });
  it('rejects wrong owner/face/parent role, extra fields, nonfinite/negative-zero input and source aliases', () => {
    const p = payload();
    const bad: unknown[] = [
      { ...p, extra: true }, { ...p, beadId: 'missing' }, { ...p, parents: [p.parents[1], p.parents[0]] },
      { ...p, parents: [p.parents[0], { ...p.parents[1], occurrencePath: p.parents[0].occurrencePath }] },
      { ...p, parents: [p.parents[0], { ...p.parents[1], sourceKey: 'stale' }] },
      { ...p, parents: [{ ...p.parents[0], reference: { ...p.parents[0].reference, index: -1 } }, p.parents[1]] },
      { ...p, parents: [{ ...p.parents[0], reference: { ...p.parents[0].reference, origin: { version: 1, shapeKind: 'face', identity: { kind: 'unknown' } } } }, p.parents[1]] },
      { ...p, path: { ...p.path, evidence: { ...p.path.evidence, radiusMm: NaN } } },
      { ...p, path: { ...p.path, evidence: { ...p.path.evidence, centerMm: [-0, 0, 0] } } },
    ];
    for (const value of bad) expect(createCircularFilletWeldSource(3, 4, value)).toBeNull();
    expect(readCircularFilletWeldSource(patch(source(), { ...p, extra: 1 }))).toBeNull();
  });
  it('rejects duplicate/overlapping/reversed/out-of-range intervals without silently fixing them', () => {
    const p = payload(), first = p.path.intervals[0];
    for (const intervals of [[], [first, first], [first, { ...first, beadId: 'other' }],
      [{ ...first, fromParameter: -0.1 }], [{ ...first, toParameter: 2 }], [{ ...first, fromParameter: Math.PI / 2, toParameter: 0 }]]) {
      expect(createCircularFilletWeldSource(3, 4, { ...p, path: { ...p.path, intervals } })).toBeNull();
    }
  });
});
