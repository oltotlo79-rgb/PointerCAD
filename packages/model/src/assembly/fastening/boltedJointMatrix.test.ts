import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { AssemblyDocument, Placement } from '../types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { planBoltedJoint } from './planBoltedJoint.js';
import { globalUnverifiedLengthAvailability } from './selectFastener.js';
import type {
  BoltedJointPlan, BoltedJointPlanResult, BoltedJointRequest, BoltLengthAvailability, FasteningHoleSelection,
  FasteningHoleSpec,
} from './types.js';

/*
 * EX-06 bolt matrix beyond the existing planBoltedJoint.test.ts (which covers M8 without washers on both sides).
 * Expectations are hand-derived from plate thicknesses and the pinned runtime table values quoted in each case,
 * never from the planner's helpers. Length candidates marked 'test fixture' are inputs, not JIS values.
 * Fixture helpers are a private copy of planBoltedJoint.test.ts (same plates: A z -10..0, B z 0..12).
 */

const M8_BOLT_KEY = 'JIS-B-1180:2014:M8:P1.25:annexJA';
const REVISIONS = new Map([['plateA', 'rev-a'], ['plateB', 'rev-b']]);

function fixtureLengths(boltRowKey: string, lengths: readonly number[]): BoltLengthAvailability[] {
  return [{ boltRowKey, lengths, basis: 'perDiameterEvidence', verified: true, source: 'test fixture (not a JIS value)' }];
}

function placement(position: Vec3, rotation: readonly [number, number, number, number] = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation };
}

function assembly(a: Placement, b: Placement): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: a, partName: '板A' }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateB' }, { placement: b, partName: '板B' }));
}

function selection(componentId: string, hole: FasteningHoleSpec, origin: Vec3, into: Vec3): FasteningHoleSelection {
  const partRef = componentId === 'component-1' ? 'plateA' : 'plateB';
  return {
    componentId, sourceKey: `part:${partRef}@${REVISIONS.get(partRef) ?? ''}`, holeFeatureId: 'hole-1',
    matingFace: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 100, position: origin, axis: into, radius: null } },
    hole, axisOrigin: origin, axisDirection: into, matingFaceNormal: [-into[0], -into[1], -into[2]],
  };
}

const DOC = assembly(placement([0, 0, 0]), placement([0, 0, 0]));

function through(a: FasteningHoleSpec, b: FasteningHoleSpec, overrides: Partial<BoltedJointRequest> = {}): BoltedJointRequest {
  return {
    first: selection('component-1', a, [0, 0, 0], [0, 0, -1]),
    second: selection('component-2', b, [0, 0, 0], [0, 0, 1]),
    dimensionSeries: 'annexJA', explicitBolt: { nominal: 'M8', threadSeries: 'coarse' },
    minimumProtrusion: 0, headWashers: [], nutWashers: [], lengthAvailability: fixtureLengths(M8_BOLT_KEY, [20, 25, 30, 35, 40]),
    ...overrides,
  };
}

function planned(result: BoltedJointPlanResult): BoltedJointPlan {
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

function codes(result: BoltedJointPlanResult): string[] {
  return result.ok ? [] : result.rejections.map((rejection) => rejection.code);
}

function z(plan: BoltedJointPlan): number[] {
  return plan.operations.map((operation) => operation.placement.position[2]?.value ?? NaN);
}

describe('EX-06 clearance + clearance: washer stack and rendered part count', () => {
  it('M8 annexJA with a plain washer under the head and under the nut: 4 parts, grip and length from the stack', () => {
    const plan = planned(planBoltedJoint(DOC, through(
      { kind: 'clearance', diameter: 9, length: 10 }, { kind: 'clearance', diameter: 9, length: 12 },
      { headWashers: ['plainWasher'], nutWashers: ['plainWasher'] }), REVISIONS));
    // Plain washer M8 t = 1.6 (the value the existing tapped case already relies on). Grip 10 + 1.6 + 12 + 1.6 = 25.2.
    // AnnexJA M8 nut mMax 6.5 (existing through case): minimum 25.2 + 6.5 + 0 = 31.7 -> 35 from [20..40].
    // Shank 35 - b1 22 = 13 <= 25.2. Protrusion 35 - 25.2 - 6.5 = 3.3.
    expect(plan.operations.map((operation) => operation.role)).toEqual(['headWasher', 'bolt', 'nutWasher', 'nut']);
    expect(plan.gripLength).toBeCloseTo(25.2, 9);
    expect(plan.boltLength).toBe(35);
    expect(plan.protrusion).toBeCloseTo(3.3, 9);
    // Head washer on A's outer face z -10, bolt bearing under it at -11.6; nut washer on B's outer face z 12, nut at 13.6.
    z(plan).forEach((value, index) => expect(value).toBeCloseTo([-10, -11.6, 12, 13.6][index] ?? NaN, 9));
    expect(plan.operations.map((operation) => operation.size)).toEqual(['M8', 'M8', 'M8', 'M8']);
  });

  it('two verified clearance rows that both fit the holes are ambiguous and are not resolved by guessing', () => {
    const result = planBoltedJoint(DOC, through(
      { kind: 'clearance', diameter: 9, length: 10 }, { kind: 'clearance', diameter: 9, length: 12 },
      { explicitBolt: undefined, clearanceEvidence: [
        { nominal: 'M8', minimumHoleDiameter: 8.4, maximumHoleDiameter: 10, verified: true, source: 'test fixture' },
        // Deliberately overlapping fixture range (not a published clearance row) so that both rows accept 9 mm.
        { nominal: 'M10', minimumHoleDiameter: 8.9, maximumHoleDiameter: 11, verified: true, source: 'test fixture, overlapping' }] }), REVISIONS);
    expect(codes(result)).toEqual(['boltSizeUnspecified']);
    expect(result.ok ? null : result.rejections[0]?.detail).toEqual({ matches: 2, first: 9, second: 9 });
  });

  /*
   * Every annexJA size of the runtime table (fasteners.ts 5bd7b6fc), the real all-diameter length list
   * HEX_BOLT_NOMINAL_LENGTHS (12, 16, 20, 25, 30, 35, 40, ...), plates 10 + 12, no washers, protrusion 0:
   * minimum = 22 + nut mMax; the first listed length >= minimum whose shank (length - min(b1, length)) <= 22.
   */
  it.each([
    // nominal, hole, nut mMax, b1, length, protrusion
    ['M6', 6.6, 5, 18, 30, 3], // 27 -> 30; shank 12
    ['M10', 11, 8, 26, 30, 0], // 30 -> 30; shank 4
    ['M12', 13.5, 10, 30, 35, 3], // 32 -> 35; shank 5
    ['M16', 17.5, 13, 38, 35, 0], // 35 -> 35; b1 38 > 35, shank 0
    ['M20', 22, 16, 46, 40, 2], // 38 -> 40; shank 0
  ] as const)('annexJA %s through bolt with nut in %s mm holes', (nominal, hole, mMax, b1, length, protrusion) => {
    const key = `JIS-B-1180:2014:${nominal}:P${{ M6: 1, M10: 1.5, M12: 1.75, M16: 2, M20: 2.5 }[nominal]}:annexJA`;
    const plan = planned(planBoltedJoint(DOC, through(
      { kind: 'clearance', diameter: hole, length: 10 }, { kind: 'clearance', diameter: hole, length: 12 },
      { explicitBolt: { nominal, threadSeries: 'coarse' }, lengthAvailability: [globalUnverifiedLengthAvailability(key)] }), REVISIONS));
    expect(plan.operations.map((operation) => [operation.role, operation.size])).toEqual([['bolt', nominal], ['nut', nominal]]);
    expect([plan.gripLength, plan.boltLength]).toEqual([22, length]);
    expect(plan.protrusion).toBeCloseTo(protrusion, 9);
    expect(length - Math.min(b1, length)).toBeLessThanOrEqual(22);
    expect(plan.boltLength - plan.gripLength - mMax).toBeCloseTo(protrusion, 9);
    expect(plan.operations[0]?.options.length).toBe(String(length));
    z(plan).forEach((value, index) => expect(value).toBeCloseTo([-10, 12][index] ?? NaN, 9));
    // The global list is usable but not per-diameter evidence; annexJA heads/nuts have no verified bearing diameter.
    expect([plan.lengthBasis, plan.lengthVerified]).toEqual(['globalUnverifiedList', false]);
    expect(plan.missingFacts).toEqual(['bearingFaceDiameter', 'perDiameterLengthAvailability']);
  });

  it('M10 spring washer under the nut: 3 parts, the washer adds to the grip and lifts the nut', () => {
    // Spring washer M10 (JIS B 1251): inside 10.2 > d 10, outside 18.4 > hole 11, t 2.5. Grip 22 + 2.5 = 24.5,
    // minimum 24.5 + 8 = 32.5 -> 35, protrusion 35 - 24.5 - 8 = 2.5. Spring washer rows are verified: no washer fact.
    const plan = planned(planBoltedJoint(DOC, through(
      { kind: 'clearance', diameter: 11, length: 10 }, { kind: 'clearance', diameter: 11, length: 12 },
      { explicitBolt: { nominal: 'M10', threadSeries: 'coarse' }, nutWashers: ['springWasher'],
        lengthAvailability: [globalUnverifiedLengthAvailability('JIS-B-1180:2014:M10:P1.5:annexJA')] }), REVISIONS));
    expect(plan.operations.map((operation) => [operation.role, operation.catalog])).toEqual([
      ['bolt', 'hexBolt'], ['nutWasher', 'springWasher'], ['nut', 'hexNut']]);
    expect(plan.gripLength).toBeCloseTo(24.5, 9);
    expect(plan.boltLength).toBe(35);
    expect(plan.protrusion).toBeCloseTo(2.5, 9);
    z(plan).forEach((value, index) => expect(value).toBeCloseTo([-10, 12, 14.5][index] ?? NaN, 9));
    expect(plan.missingFacts).not.toContain('washerTableUnverified');
  });

  it('a plain washer keeps the unverified washer table visible as a missing fact', () => {
    // Every plain washer row of the runtime table is verified: false.
    const plan = planned(planBoltedJoint(DOC, through(
      { kind: 'clearance', diameter: 9, length: 10 }, { kind: 'clearance', diameter: 9, length: 12 },
      { headWashers: ['plainWasher'] }), REVISIONS));
    expect(plan.missingFacts).toContain('washerTableUnverified');
  });

  it('a size without a row in the chosen dimension series is refused, not substituted', () => {
    // The runtime table has M14 only in the main series (bolt verified: false); annexJA has no M14 row.
    const annex = planBoltedJoint(DOC, through(
      { kind: 'clearance', diameter: 15.5, length: 10 }, { kind: 'clearance', diameter: 15.5, length: 12 },
      { explicitBolt: { nominal: 'M14', threadSeries: 'coarse' } }), REVISIONS);
    expect(codes(annex)).toEqual(['boltRowMissing']);
    expect(annex.ok ? null : annex.rejections[0]?.detail).toEqual({ nominal: 'M14', dimensionSeries: 'annexJA' });
    // Main M14: nut mMax 12.8 -> minimum 34.8 -> 35 (b1 34, shank 1). The unverified bolt row stays a missing fact.
    const main = planned(planBoltedJoint(DOC, through(
      { kind: 'clearance', diameter: 15.5, length: 10 }, { kind: 'clearance', diameter: 15.5, length: 12 },
      { dimensionSeries: 'main', explicitBolt: { nominal: 'M14', threadSeries: 'coarse' },
        lengthAvailability: [globalUnverifiedLengthAvailability('JIS-B-1180:2014:M14:P2:main')] }), REVISIONS));
    expect(main.boltLength).toBe(35);
    expect(main.missingFacts).toContain('catalogRowUnverified');
  });

  it('tapped holes: nominal and pitch come from the hole, engagement and depth bound the listed length', () => {
    // Head plate A 10 mm with a clearance hole (11 for M10, 13.5 for M12); the bolt nominal comes only from the hole.
    const M10 = { headHole: 11, rowKey: 'JIS-B-1180:2014:M10:P1.5:annexJA' } as const;
    const M12 = { headHole: 13.5, rowKey: 'JIS-B-1180:2014:M12:P1.75:annexJA' } as const;
    const tapped = (size: typeof M10 | typeof M12, hole: FasteningHoleSpec, overrides: Partial<BoltedJointRequest> = {}): BoltedJointRequest =>
      through({ kind: 'clearance', diameter: size.headHole, length: 10 }, hole, { explicitBolt: undefined, minimumProtrusion: undefined,
        lengthAvailability: [globalUnverifiedLengthAvailability(size.rowKey)], ...overrides });
    const blind: FasteningHoleSpec = { kind: 'blindThreaded', nominal: 'M10', pitch: 1.5, usableThreadDepth: 20, drillDepth: 24 };
    // Grip 10 (head plate only). Engagement 15, bottom clearance 2: 25 <= length <= 10 + 18 = 28 -> 25 (b = 25, shank 0).
    // Tip 15 mm into the hole, thread on the bolt spans [15 - 25, 15], hole thread [0, 20] -> engaged 15.
    const blindPlan = planned(planBoltedJoint(DOC, tapped(M10, blind,{ engagement: 15, blindBottomClearance: 2 }), REVISIONS));
    expect([blindPlan.configuration, blindPlan.nominal, blindPlan.pitch, blindPlan.threadSeries])
      .toEqual(['tappedBlind', 'M10', 1.5, 'coarse']);
    expect([blindPlan.gripLength, blindPlan.boltLength, blindPlan.engagedLength, blindPlan.penetration, blindPlan.protrusion])
      .toEqual([10, 25, 15, 15, null]);
    expect(blindPlan.operations.map((operation) => operation.role)).toEqual(['bolt']);
    z(blindPlan).forEach((value) => expect(value).toBeCloseTo(-10, 9));
    // Engagement 19 > usable 20 - 2 = 18: refused before any length is chosen.
    const bottoming = planBoltedJoint(DOC, tapped(M10, blind,{ engagement: 19, blindBottomClearance: 2 }), REVISIONS);
    expect(codes(bottoming)).toEqual(['blindBottoming']);
    expect(bottoming.ok ? null : bottoming.rejections[0]?.detail).toEqual({ engagement: 19, usable: 18 });
    // An explicit bolt of another nominal conflicts with the tapped hole.
    const conflict = planBoltedJoint(DOC, tapped(M10, blind,{ engagement: 15, blindBottomClearance: 2,
      explicitBolt: { nominal: 'M12', threadSeries: 'coarse' } }), REVISIONS);
    expect(conflict.ok ? null : conflict.rejections[0]).toEqual({ code: 'nominalMismatch', detail: { hole: 'M10', bolt: 'M12' } });

    // Through-threaded M12, thread over the full 15 mm, engagement 12: minimum 22 -> 25 (20 is too short; b = 25).
    // Tip 15, engaged = [15 - 25, 15] with [0, 15] = 15, nothing sticks out of the far face.
    const full: FasteningHoleSpec = { kind: 'throughThreaded', nominal: 'M12', pitch: 1.75, threadStart: 0, threadLength: 15, length: 15 };
    const fullPlan = planned(planBoltedJoint(DOC, tapped(M12, full,{ engagement: 12 }), REVISIONS));
    expect([fullPlan.configuration, fullPlan.boltLength, fullPlan.engagedLength, fullPlan.protrusion]).toEqual(['tappedThrough', 25, 15, 0]);
    // The same hole with its thread starting 3 mm in (12 mm of thread): minimum 10 + 3 + 12 = 25, engaged [3, 15] = 12.
    const recessed: FasteningHoleSpec = { ...full, threadStart: 3, threadLength: 12 };
    const recessedPlan = planned(planBoltedJoint(DOC, tapped(M12, recessed,{ engagement: 12 }), REVISIONS));
    expect([recessedPlan.boltLength, recessedPlan.engagedLength]).toEqual([25, 12]);
    expect(codes(planBoltedJoint(DOC, tapped(M12, recessed,{ engagement: 13 }), REVISIONS))).toEqual(['engagementExceedsThread']);
  });

  it('holes of different diameters must both fit the single matching row', () => {
    // 9 fits [8.4, 10]; 11 does not, so no row fits both.
    const result = planBoltedJoint(DOC, through(
      { kind: 'clearance', diameter: 9, length: 10 }, { kind: 'clearance', diameter: 11, length: 12 },
      { explicitBolt: undefined, clearanceEvidence: [
        { nominal: 'M8', minimumHoleDiameter: 8.4, maximumHoleDiameter: 10, verified: true, source: 'test fixture' }] }), REVISIONS);
    expect(codes(result)).toEqual(['boltSizeUnspecified']);
  });
});
