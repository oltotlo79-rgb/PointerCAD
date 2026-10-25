import { stdout } from 'node:process';
import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { collectMateVariables } from '../constraints/mateVariables.js';
import { applyMateIncrements, prepareMateDrag, solveDrivenJoint } from '../constraints/solveMates.js';
import { applyPlacementToDirection, applyPlacementToPoint, composePlacement, IDENTITY_PLACEMENT, quaternionFromAxisAngle,
  type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument, Joint, MechanismCamCoupling } from '../types.js';
import type { JointFrame, JointFramePair } from './jointFrames.js';
import { camFollowerRows, prepareCamFollowers, type CamFollowerCoupling } from './camFollower.js';
import { CYCLE_TRANSFORM, createCamCycleFixture, oracleCamErrors, oraclePoseError, requireCyclePlacement } from './mechanismCycleFixture.js';

const R = 20, E = 5, ROLLER = 4;
const camFrame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const sliderFrame: JointFrame = { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
const origin = (componentId: string) => ({ kind: 'origin', componentId, element: 'origin' }) as const;
const TRANSFORM: RigidPlacement = { position: [10, -20, 5], rotation: quaternionFromAxisAngle([1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14)], 0.7) };

interface Layout {
  readonly camOnA: boolean;
  readonly followerOnA: boolean;
  readonly phaseDeg?: number;
  /** Support-side slider frame origin (the guide point), in the support's local coordinates. */
  readonly guide?: readonly [number, number, number];
  readonly followerX?: number;
  readonly transform?: RigidPlacement;
  readonly groundFixed?: boolean;
  readonly camWorldDeg?: number;
  readonly suppressed?: boolean;
}

function fixture(layout: Layout) {
  const components: AssemblyComponent[] = ['ground', 'cam', 'follower'].map(id => ({ id, name: id,
    source: { kind: 'part', partRef: 'part' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: id === 'ground' && (layout.groundFixed ?? true), visible: true, suppressed: false }));
  const [camA, camB] = layout.camOnA ? ['cam', 'ground'] : ['ground', 'cam'];
  const [sliderA, sliderB] = layout.followerOnA ? ['follower', 'ground'] : ['ground', 'follower'];
  const joints: Joint[] = [
    { id: 'jc', name: 'cam', kind: 'revolute', a: origin(camA), b: origin(camB), minValue: null, maxValue: null, suppressed: false },
    { id: 'jf', name: 'follower', kind: 'slider', a: origin(sliderA), b: origin(sliderB), minValue: null, maxValue: null, suppressed: false },
  ];
  const g = layout.guide ?? [0, 0, 0];
  const guideFrame: JointFrame = { ...sliderFrame, origin: [g[0], g[1], g[2]] };
  const frames = new Map<string, JointFramePair>([['jc', { a: camFrame, b: camFrame }],
    ['jf', layout.followerOnA ? { a: sliderFrame, b: guideFrame } : { a: guideFrame, b: sliderFrame }]]);
  const transform = layout.transform ?? IDENTITY_PLACEMENT;
  const camLocal: RigidPlacement = { ...IDENTITY_PLACEMENT, rotation: quaternionFromAxisAngle([0, 0, 1], (layout.camWorldDeg ?? 0) * Math.PI / 180) };
  const placements = new Map<string, RigidPlacement>([['ground', transform], ['cam', composePlacement(transform, camLocal)],
    ['follower', composePlacement(transform, { ...IDENTITY_PLACEMENT, position: [layout.followerX ?? 29, 0, 0] })]]);
  const coupling: MechanismCamCoupling = { id: 'cam-1', kind: 'cam', camJointId: 'jc', followerJointId: 'jf',
    discRadiusMm: expressionValueFromNumber(R), eccentricityMm: expressionValueFromNumber(E),
    rollerRadiusMm: expressionValueFromNumber(ROLLER), phaseDeg: expressionValueFromNumber(layout.phaseDeg ?? 0),
    referenceAngleCam: 0, suppressed: layout.suppressed ?? false };
  const assembly: AssemblyDocument = { ...createAssemblyDocument('cam guide'), components, joints, camCouplings: [coupling] };
  const numeric: CamFollowerCoupling = { id: 'cam-1', kind: 'cam', camJointId: 'jc', followerJointId: 'jf', discRadiusMm: R,
    eccentricityMm: E, rollerRadiusMm: ROLLER, phaseDeg: layout.phaseDeg ?? 0, referenceAngleCam: 0, suppressed: layout.suppressed ?? false };
  return { assembly, joints, frames, placements, numeric, transform };
}

/**
 * Independent contact check from body-fixed geometry, not from the closed form. jointValue measures the angle from a.x to
 * b.x about b.z, so a world cam turn psi reads theta = -psi with the cam on side a and +psi on side b. The eccentric disc
 * centre is the cam-body point that points along the guide toward the follower when theta equals the phase.
 */
function contactGap(layout: Layout, placements: ReadonlyMap<string, RigidPlacement>): { gap: number; offGuide: number } {
  const phase = (layout.phaseDeg ?? 0) * Math.PI / 180, psiAtPhase = layout.camOnA ? -phase : phase;
  const eccentric: [number, number, number] = [E * Math.cos(-psiAtPhase), E * Math.sin(-psiAtPhase), 0];
  const cam = placements.get('cam'), follower = placements.get('follower'), ground = placements.get('ground');
  if (cam === undefined || follower === undefined || ground === undefined) throw new Error('fixture placement absent');
  const centre = applyPlacementToPoint(cam, eccentric), roller = applyPlacementToPoint(follower, [0, 0, 0]);
  const g = layout.guide ?? [0, 0, 0];
  const guidePoint = applyPlacementToPoint(ground, [g[0], g[1], g[2]]), guideAxis = applyPlacementToDirection(ground, [1, 0, 0]);
  const span = roller.map((v, i) => v - guidePoint[i]), along = span[0] * guideAxis[0] + span[1] * guideAxis[1] + span[2] * guideAxis[2];
  return { gap: Math.hypot(...roller.map((v, i) => v - centre[i])) - (R + ROLLER),
    offGuide: Math.hypot(...span.map((v, i) => v - along * guideAxis[i])) };
}

describe('cam admission uses the support-fixed guide (review r1 blocker 1)', () => {
  it.each([true, false])('refuses a support guide offset off the cam axis while the roller sits on it (follower on a=%s)', followerOnA => {
    const f = fixture({ camOnA: true, followerOnA, guide: [0, 3, 0] });
    expect(prepareCamFollowers({ ...f, couplings: [f.numeric], drivenJointIds: new Set() }))
      .toMatchObject({ ok: false, reason: 'notInLine' });
  });

  it.each([true, false])('derives the offset from a guide point shifted along the guide (follower on a=%s)', followerOnA => {
    const f = fixture({ camOnA: true, followerOnA, guide: [-7, 0, 0] });
    const result = prepareCamFollowers({ ...f, couplings: [f.numeric], drivenJointIds: new Set() });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const variableSet = collectMateVariables(f.assembly);
    const rows = camFollowerRows({ ...f, variableSet, prepared: result.prepared, references: new Map() });
    expect(rows.ok).toBe(true); if (!rows.ok) return;
    // Roller at 29 on the guide, eccentricity toward it at theta 0: in contact.
    expect(rows.rows[0].value).toBeCloseTo(0, 14);
  });
});

describe('solved cam contact against body-fixed reconstruction (nonzero phase, both orderings, rigid transform)', () => {
  const layouts: Layout[] = [];
  for (const camOnA of [true, false]) for (const followerOnA of [true, false]) for (const transform of [IDENTITY_PLACEMENT, TRANSFORM])
    layouts.push({ camOnA, followerOnA, phaseDeg: 40, transform });
  it.each(layouts)('cam on a=$camOnA, follower on a=$followerOnA', layout => {
    const f = fixture(layout);
    let placements: ReadonlyMap<string, RigidPlacement> = f.placements, reference = 0;
    for (let target = 45; target <= 360; target += 45) {
      const result = solveDrivenJoint(f.assembly, new Map(), placements,
        { jointId: 'jc', coordinate: 'angle', value: target, referenceAngle: reference }, { jointFrames: f.frames });
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
      const { gap, offGuide } = contactGap(layout, result.placements);
      expect(Math.abs(gap)).toBeLessThan(1e-6);
      expect(offGuide).toBeLessThan(1e-6);
      placements = result.placements; reference = result.actual;
    }
  });
});

describe('cam row gradient against central differences (nonzero angle and phase, moving support)', () => {
  it.each([100, 7])('characteristic length %s', length => {
    const layout: Layout = { camOnA: true, followerOnA: false, phaseDeg: 25, camWorldDeg: -30, followerX: 27.5,
      groundFixed: false, transform: TRANSFORM };
    const f = fixture(layout), numeric = { ...f.numeric, referenceAngleCam: 30 };
    const prepared = prepareCamFollowers({ ...f, couplings: [numeric], drivenJointIds: new Set() });
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    const variableSet = collectMateVariables(f.assembly);
    const value = (placements: ReadonlyMap<string, RigidPlacement>) => {
      const rows = camFollowerRows({ placements, variableSet, characteristicLength: length,
        prepared: prepared.prepared, references: new Map([['jc', 30]]) });
      if (!rows.ok) throw new Error(rows.reason);
      return rows.rows[0];
    };
    const base = value(f.placements), h = 1e-6;
    expect(variableSet.variables.length).toBeGreaterThan(6);
    for (let column = 0; column < variableSet.variables.length; column += 1) {
      const step = (sign: number) => variableSet.variables.map((_, i) => i === column ? sign * h : 0);
      const difference = (value(applyMateIncrements(f.placements, variableSet, step(1))).value
        - value(applyMateIncrements(f.placements, variableSet, step(-1))).value) / (2 * h);
      expect(base.gradient.get(column) ?? 0).toBeCloseTo(difference, 6);
    }
  });
});

describe('prepared dragging refuses active cams (review r1 blocker 2)', () => {
  it('refuses an active cam before any pose change and keeps a suppressed cam eligible', () => {
    const active = fixture({ camOnA: true, followerOnA: true }), before = structuredClone(active.placements);
    expect(prepareMateDrag(active.assembly, new Map(), active.placements, 'follower', { jointFrames: active.frames }))
      .toEqual({ ok: false, reason: 'unresolvedConstraint' });
    expect(active.placements).toEqual(before);
    const suppressed = fixture({ camOnA: true, followerOnA: true, suppressed: true });
    expect(prepareMateDrag(suppressed.assembly, new Map(), suppressed.placements, 'follower', { jointFrames: suppressed.frames }).ok)
      .toBe(true);
  });
});

describe('W07 independent eccentric-disc cycle oracle at five-degree intervals', () => {
  for (const dimensions of [
    { radiusMm: 20, eccentricityMm: 5, rollerRadiusMm: 4, phaseDeg: 37 },
    { radiusMm: 13, eccentricityMm: 3, rollerRadiusMm: 2, phaseDeg: 37 },
  ]) {
    it.each([
      { side: 1, camOnA: true, followerOnA: true, transform: IDENTITY_PLACEMENT },
      { side: -1, camOnA: false, followerOnA: false, transform: CYCLE_TRANSFORM },
    ] as const)(`R=${dimensions.radiusMm}, e=${dimensions.eccentricityMm}, r=${dimensions.rollerRadiusMm}, side=$side closes a full turn`, layout => {
      const f = createCamCycleFixture(dimensions, layout), before = structuredClone(f);
      let placements: ReadonlyMap<string, RigidPlacement> = f.placements;
      let first: ReadonlyMap<string, RigidPlacement> | undefined;
      let reference = 0, samples = 0;
      const maximum = { positionMm: 0, contactGapMm: 0, guideMm: 0, angleDeg: 0, followerOrientationDeg: 0,
        closurePositionMm: 0, closureOrientationDeg: 0 };
      for (let target = 0; target <= 360; target += 5) {
        const outcome = solveDrivenJoint(f.assembly, new Map(), placements,
          { jointId: 'jc', coordinate: 'angle', value: target, referenceAngle: reference }, { jointFrames: f.frames });
        expect(outcome.ok, `drive at ${target} degrees`).toBe(true);
        if (!outcome.ok) throw new Error(outcome.reason);
        expect(outcome.outcome.converged).toBe(true);
        const errors = oracleCamErrors(f.geometry, outcome.placements, target);
        for (const key of Object.keys(errors) as (keyof typeof errors)[]) {
          maximum[key] = Math.max(maximum[key], errors[key]);
          expect(errors[key], JSON.stringify({ target, key, errors, dimensions, layout })).toBeLessThanOrEqual(1e-6);
        }
        first ??= outcome.placements;
        placements = outcome.placements;
        reference = target;
        samples += 1;
      }
      expect(samples).toBe(73);
      if (first === undefined) throw new Error('No cycle samples');
      for (const id of ['ground', 'cam', 'follower']) {
        const error = oraclePoseError(requireCyclePlacement(first, id), requireCyclePlacement(placements, id));
        maximum.closurePositionMm = Math.max(maximum.closurePositionMm, error.positionMm);
        maximum.closureOrientationDeg = Math.max(maximum.closureOrientationDeg, error.orientationDeg);
        expect(error.positionMm, id).toBeLessThanOrEqual(1e-6);
        expect(error.orientationDeg, id).toBeLessThanOrEqual(1e-6);
      }
      expect(f).toEqual(before);
      stdout.write(`[W07] ${JSON.stringify({ kind: 'cam-cycle', dimensions, side: layout.side, samples, maximum })}${String.fromCharCode(10)}`);
    });
  }
});
