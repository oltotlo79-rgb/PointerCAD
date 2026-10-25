import { stdout } from 'node:process';
import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { collectMateVariables } from '../constraints/mateVariables.js';
import { applyMateIncrements, diagnoseMates, prepareMateDrag, solveDrivenJoint, solveMates } from '../constraints/solveMates.js';
import { rigidRowTolerance, solveRigid } from '../constraints/solveRigid.js';
import { IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, Joint } from '../types.js';
import { driveJointRows, jointValue } from './driveJoint.js';
import type { JointFrame, JointFramePair } from './jointFrames.js';
import { buildJointResidualReport, prepareJointResiduals } from './jointResiduals.js';
import { advanceMechanismReferences, evaluateMechanismCouplings, mechanismCouplingRows, prepareMechanismCouplings,
  type GearRatioCoupling } from './mechanismCoupling.js';
import { createMechanismCycleFixture, oracleAffineCycle, oracleAngle, oracleCamErrors, oracleLinkErrors,
  oraclePoseError, requireCyclePlacement } from './mechanismCycleFixture.js';

const frame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const coupling = (patch: Partial<GearRatioCoupling> = {}): GearRatioCoupling => ({ id: 'gear-ab', kind: 'gear',
  jointAId: 'ja', jointBId: 'jb', ratio: -2, phaseDeg: 10, referenceAngleA: 0, suppressed: false, ...patch });
function fixture(angles: readonly number[] = [0, 10, 0]) {
  const components: AssemblyComponent[] = ['ground', 'a', 'b', 'c'].map(id => ({ id, name: id,
    source: { kind: 'part', partRef: 'part' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: id === 'ground', visible: true, suppressed: false }));
  const joints: Joint[] = ['a', 'b', 'c'].map(id => ({ id: `j${id}`, name: id, kind: 'revolute',
    a: { kind: 'origin', componentId: id, element: 'origin' },
    b: { kind: 'origin', componentId: 'ground', element: 'origin' },
    minValue: null, maxValue: null, suppressed: false }));
  const placements = new Map<string, RigidPlacement>([['ground', IDENTITY_PLACEMENT]]);
  const frames = new Map<string, JointFramePair>();
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    const x = index * 4 - 4;
    placements.set(id, { position: [x, 0, 0], rotation: quaternionFromAxisAngle([0, 0, 1], -angles[index] * Math.PI / 180) });
    frames.set(`j${id}`, { a: frame, b: { ...frame, origin: [x, 0, 0] } });
  }
  const assembly = { ...createAssemblyDocument('gears'), components, joints };
  const variableSet = collectMateVariables(assembly);
  return { assembly, joints, placements, frames, variableSet };
}
function prepare(f: ReturnType<typeof fixture>, couplings: readonly GearRatioCoupling[]) {
  const result = prepareMechanismCouplings({ ...f, couplings });
  if (!result.ok) throw new Error(result.reason);
  return result.prepared;
}
function solve(f: ReturnType<typeof fixture>, definitions: readonly GearRatioCoupling[], jointId: string, target: number) {
  const prepared = prepare(f, definitions);
  const joints = prepareJointResiduals(f).joints;
  const driven = joints.find(j => j.jointId === jointId);
  if (driven === undefined) throw new Error('Missing fixture driver');
  const references = new Map(prepared.references);
  if (!references.has(jointId)) references.set(jointId, 0);
  return solveRigid<{ placements: ReadonlyMap<string, RigidPlacement>; references: ReadonlyMap<string, number> }>({ initial: { placements: f.placements, references },
    variables: f.variableSet.variables.map(v => v.axis.startsWith('t') ? 'length' : 'angle'),
    options: { angleTolerance: 1e-11, lengthTolerance: 1e-9, maxIterations: 100 },
    evaluate(state, increments) {
      const input = { ...f, placements: state.placements, increments, references: state.references, prepared };
      const permanent = buildJointResidualReport({ ...input, joints });
      const coupled = mechanismCouplingRows(input);
      const driver = driveJointRows({ ...input, joint: driven, coordinate: 'angle',
        referenceAngle: state.references.get(jointId), target });
      return { rows: [...permanent.rows.map(row => ({ ...row,
        unit: row.measure === 'length' ? 'length' as const : 'angle' as const })),
        ...(coupled.ok ? coupled.rows : []), ...(driver.ok ? driver.rows : [])],
        valid: permanent.skipped.length === 0 && coupled.ok && driver.ok,
        branchViolations: permanent.branchViolations };
    },
    retract(state, increments) {
      const next = advanceMechanismReferences({ ...f, placements: state.placements, increments, prepared, references: state.references });
      if (!next.ok) throw new Error(next.reason);
      return { placements: applyMateIncrements(state.placements, f.variableSet, increments), references: next.references };
    } });
}

describe('persistent signed gear relation through real revolute residuals and solveRigid', () => {
  it.each([2, -2, 0.5, -0.5])('ratio=%s drives either actual revolute coordinate', ratio => {
    const definition = coupling({ ratio }), f = fixture(), before = structuredClone(f.placements);
    for (const [jointId, target, a, b] of [['ja', 30, 30, ratio * 30 + 10],
      ['jb', 50, 40 / ratio, 50]] as const) {
      const outcome = solve(f, [definition], jointId, target);
      expect(outcome.converged).toBe(true);
      for (const [id, expected] of [['ja', a], ['jb', b]] as const) {
        const preparedJoint = prepareJointResiduals(f).joints.find(j => j.jointId === id);
        if (preparedJoint === undefined) throw new Error('Fixture joint absent');
        const value = jointValue({ ...f, placements: outcome.base.placements, joint: preparedJoint,
          coordinate: 'angle', referenceAngle: outcome.base.references.get(id) });
        if (!value.ok) throw new Error(value.reason);
        expect(Math.abs(value.value - expected)).toBeLessThan(1e-8);
      }
      for (const id of ['a', 'b', 'c']) expect(outcome.base.placements.get(id)?.position).toEqual(before.get(id)?.position);
      expect(outcome.base.placements.get('ground')).toEqual(IDENTITY_PLACEMENT);
    }
    expect(f.placements).toEqual(before);
  });
  it('preserves accepted unwrapped angles across180 degrees in both directions', () => {
    for (const start of [179, -179]) {
      const definition = coupling({ phaseDeg: 0, referenceAngleA: start });
      const f = fixture([start, -2 * start, 0]), target = start > 0 ? 181 : -181;
      const outcome = solve(f, [definition], 'ja', target);
      expect(outcome.converged).toBe(true);
      expect(Math.abs((outcome.base.references.get('ja') ?? NaN) - target)).toBeLessThan(1e-8);
      expect(Math.abs((outcome.base.references.get('jb') ?? NaN) + 2 * target)).toBeLessThan(1e-8);
    }
  });
  it('retains uncoupled solver behavior and does not create a relation', () => {
    const f = fixture(), outcome = solve(f, [], 'ja', 30);
    expect(outcome.converged).toBe(true);
    expect(outcome.base.placements.get('b')).toEqual(f.placements.get('b'));
  });
  it('coupled analytic Jacobian matches independent central differences in every rigid column', () => {
    const f = fixture([17, -24, 0]), prepared = prepare(f, [coupling()]);
    const input = { ...f, prepared, references: prepared.references };
    const actual = mechanismCouplingRows(input); if (!actual.ok) throw new Error(actual.reason);
    const before = new Map(prepared.references), h = 1e-7;
    for (let column = 0; column < f.variableSet.variables.length; column++) {
      const plus = new Array<number>(f.variableSet.variables.length).fill(0), minus = [...plus];
      plus[column] = h; minus[column] = -h;
      const a = mechanismCouplingRows({ ...input, increments: plus });
      const b = mechanismCouplingRows({ ...input, increments: minus });
      if (!a.ok || !b.ok) throw new Error('Differential probe unexpectedly refused');
      const numeric = (a.rows[0].value - b.rows[0].value) / (2 * h);
      expect(Math.abs(numeric - (actual.rows[0].gradient.get(column) ?? 0))).toBeLessThan(4e-8);
    }
    expect(prepared.references).toEqual(before);
  });
});

describe('complete coupling validation before any document or pose change', () => {
  it.each([0, NaN, Infinity, -Infinity])('refuses invalid ratio%s', ratio => {
    expect(prepareMechanismCouplings({ ...fixture(), couplings: [coupling({ ratio })] }))
      .toMatchObject({ ok: false, reason: 'invalidRatio' });
  });
  it.each([NaN, Infinity, -Infinity])('refuses invalid phase/reference%s', value => {
    const f = fixture();
    expect(prepareMechanismCouplings({ ...f, couplings: [coupling({ phaseDeg: value })] }))
      .toMatchObject({ ok: false, reason: 'invalidPhase' });
    expect(prepareMechanismCouplings({ ...f, couplings: [coupling({ referenceAngleA: value })] }))
      .toMatchObject({ ok: false, reason: 'invalidReference' });
  });
  it('refuses missing, suppressed, duplicate and nonrevolute joint references', () => {
    const f = fixture();
    const cases = [
      { joints: f.joints.slice(1), reason: 'missingJoint' },
      { joints: f.joints.map(j => j.id === 'ja' ? { ...j, suppressed: true } : j), reason: 'suppressedJoint' },
      { joints: [...f.joints, f.joints[0]], reason: 'duplicateJoint' },
      { joints: f.joints.map(j => j.id === 'ja' ? { ...j, kind: 'slider' as const } : j), reason: 'unsupportedJoint' },
    ];
    const before = structuredClone(f.placements);
    for (const row of cases) expect(prepareMechanismCouplings({ ...f, joints: row.joints, couplings: [coupling()] }))
      .toMatchObject({ ok: false, reason: row.reason });
    expect(f.placements).toEqual(before);
  });
  it('refuses duplicate IDs, repeated unordered pairs and self references', () => {
    const f = fixture();
    for (const [definitions, reason] of [
      [[coupling(), coupling({ jointBId: 'jc' })], 'duplicateCoupling'],
      [[coupling(), coupling({ id: 'ba', jointAId: 'jb', jointBId: 'ja' })], 'duplicateReference'],
      [[coupling({ jointBId: 'ja' })], 'duplicateReference'],
    ] as const) expect(prepareMechanismCouplings({ ...f, couplings: definitions })).toMatchObject({ ok: false, reason });
  });
  it('accepts a consistent affine loop and refuses a contradictory phase loop', () => {
    const f = fixture([0, 0, 0]);
    const ab = coupling({ ratio: 2, phaseDeg: 0 });
    const bc = coupling({ id: 'bc', jointAId: 'jb', jointBId: 'jc', ratio: 3, phaseDeg: 0 });
    const ac = coupling({ id: 'ac', jointBId: 'jc', ratio: 6, phaseDeg: 0 });
    expect(prepareMechanismCouplings({ ...f, couplings: [ab, bc, ac] }).ok).toBe(true);
    expect(prepareMechanismCouplings({ ...f, couplings: [ab, bc, { ...ac, phaseDeg: 1 }] }))
      .toMatchObject({ ok: false, reason: 'contradictoryLoop' });
    expect(prepareMechanismCouplings({ ...f, couplings: [ab, bc, { ...ac, ratio: 5 }] }).ok).toBe(true);
  });
  it('refuses missing unwrap references and rejects a trial half-turn without changing accepted references', () => {
    const f = fixture(), prepared = prepare(f, [coupling()]), before = new Map(prepared.references);
    expect(mechanismCouplingRows({ ...f, prepared, references: new Map() }))
      .toMatchObject({ ok: false, reason: 'invalidReference' });
    const increments = new Array<number>(f.variableSet.variables.length).fill(0);
    const column = f.variableSet.columnOf('a', 'rz'); if (column === null) throw new Error('Fixture variable absent');
    increments[column] = Math.PI;
    expect(mechanismCouplingRows({ ...f, prepared, references: prepared.references, increments }))
      .toMatchObject({ ok: false, reason: 'rotationBranch' });
    expect(prepared.references).toEqual(before);
  });
});

describe('actual assembly solve entry and authored expression integration', () => {
  function document(f: ReturnType<typeof fixture>, ratioSource = 'gearRatio') {
    return { ...f.assembly, parameters: [
      { name: 'gearRatio', value: expressionValueFromNumber(-2), unit: 'none' as const, description: '' },
      { name: 'gearPhase', value: expressionValueFromNumber(10), unit: 'degree' as const, description: '' },
    ], mechanismCouplings: [{ ...coupling(), ratio: { source: ratioSource, value: 999, display: '999' },
      phaseDeg: { source: 'gearPhase', value: 888, display: '888' } }] };
  }
  it('evaluates parameters instead of stale saved ratio/phase values', () => {
    const f = fixture(), source = document(f), before = structuredClone(source);
    expect(evaluateMechanismCouplings(source)).toMatchObject({ ok: true, couplings: [{ ratio: -2, phaseDeg: 10 }] });
    expect(source).toEqual(before);
  });
  it('does not accept a real1e-8degree coupling error under the default rad tolerance', () => {
    const f = fixture([0, 10 + 1e-8, 0]), prepared = prepare(f, [coupling()]);
    const result = mechanismCouplingRows({ ...f, prepared, references: prepared.references });
    if (!result.ok) throw new Error(result.reason);
    expect(Math.abs(result.rows[0].value)).toBeGreaterThan(rigidRowTolerance(result.rows[0]));
  });
  it('refuses unsupported coupled drag before any pose mutation and preserves uncoupled drag', () => {
    const f = fixture(), before = structuredClone(f.placements);
    expect(prepareMateDrag(document(f), new Map(), f.placements, 'a', { jointFrames: f.frames }))
      .toMatchObject({ ok: false, reason: 'unresolvedConstraint' });
    expect(prepareMateDrag(f.assembly, new Map(), f.placements, 'a', { jointFrames: f.frames }).ok).toBe(true);
    expect(f.placements).toEqual(before);
  });
  it.each(['missingRatio', '1/0', 'sqrt(-1)'])('rejects expression%s without cached-value fallback or pose mutation', source => {
    const f = fixture(), assembly = document(f, source), before = structuredClone(f.placements);
    expect(evaluateMechanismCouplings(assembly)).toMatchObject({ ok: false, reason: 'invalidExpression' });
    const result = solveMates(assembly, new Map(), f.placements, { jointFrames: f.frames });
    expect(result.converged).toBe(false);
    expect(result.couplingFailure).toMatchObject({ reason: 'invalidExpression' });
    expect(result.placements).toEqual(before);
    expect(diagnoseMates(assembly, result).complete).toBe(false);
  });
  it.each([['ja', 30, 30, -50], ['jb', -50, 30, -50]] as const)('existing solveDrivenJoint drives%s and solves both independently grounded gears', (jointId, target, a, b) => {
      const f = fixture(), assembly = document(f), before = structuredClone(assembly);
      const result = solveDrivenJoint(assembly, new Map(), f.placements,
        { jointId, coordinate: 'angle', value: target, referenceAngle: jointId === 'ja' ? 0 : 10 }, { jointFrames: f.frames });
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
      const combined = result.outcome.diagnosis.components.find(c => c.componentIds.includes('a'));
      expect(combined?.componentIds).toEqual(['a', 'b']);
      expect(combined?.couplingRows).toHaveLength(1);
      expect(diagnoseMates(assembly, result.outcome).complete).toBe(true);
      for (const [id, expected] of [['ja', a], ['jb', b]] as const) {
        const joint = prepareJointResiduals(f).joints.find(j => j.jointId === id);
        if (joint === undefined) throw new Error('Fixture joint absent');
        const value = jointValue({ ...f, placements: result.placements, joint, coordinate: 'angle', referenceAngle: expected });
        if (!value.ok) throw new Error(value.reason);
        expect(Math.abs(value.value - expected)).toBeLessThan(1e-8);
      }
      expect(assembly).toEqual(before);
    });
  it.each([false, true])('retains the public drive result across an unrelated gear group; targetFirst=%s', (targetFirst) => {
    const f = fixture(), base = document(f);
    const assembly = { ...base, components: targetFirst
      ? [...base.components.filter(c => c.id === 'ground' || c.id === 'c'),
        ...base.components.filter(c => c.id !== 'ground' && c.id !== 'c')]
      : base.components };
    const before = structuredClone({ assembly, placements: f.placements });
    const result = solveDrivenJoint(assembly, new Map(), f.placements,
      { jointId: 'jc', coordinate: 'angle', value: 30, referenceAngle: 0 }, { jointFrames: f.frames });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.outcome.converged).toBe(true);
    expect(result.outcome.diagnosis.limits).toEqual([]);
    expect(result.outcome.diagnosis.components.map(c => c.componentIds))
      .toEqual(targetFirst ? [['c'], ['a', 'b']] : [['a', 'b'], ['c']]);
    expect(Math.abs(result.actual - 30)).toBeLessThan(1e-8);
    for (const [id, expected] of [['ja', 0], ['jb', 10], ['jc', 30]] as const) {
      const joint = prepareJointResiduals(f).joints.find(j => j.jointId === id);
      if (joint === undefined) throw new Error('Fixture joint absent');
      const value = jointValue({ ...f, placements: result.placements, joint, coordinate: 'angle', referenceAngle: expected });
      if (!value.ok) throw new Error(value.reason);
      expect(Math.abs(value.value - expected)).toBeLessThan(1e-8);
    }
    expect({ assembly, placements: f.placements }).toEqual(before);
  });
  it('ordinary solveMates enforces permanent relation before any driver exists', () => {
    const f = fixture([0, 0, 0]), assembly = document(f);
    const result = solveMates(assembly, new Map(), f.placements, { jointFrames: f.frames });
    expect(result.converged).toBe(true);
    const angles = ['ja', 'jb'].map(id => {
      const joint = prepareJointResiduals(f).joints.find(j => j.jointId === id);
      if (joint === undefined) throw new Error('Fixture joint absent');
      const value = jointValue({ ...f, placements: result.placements, joint, coordinate: 'angle', referenceAngle: 0 });
      if (!value.ok) throw new Error(value.reason);
      return value.value;
    });
    expect(Math.abs(angles[1] + 2 * angles[0] - 10)).toBeLessThan(1e-7);
    expect(diagnoseMates(assembly, result).couplingRows).toHaveLength(1);
  });
});

describe('W07 independent gear/cam/two-pin-link constraint-cycle oracle', () => {
  it('solves the consistent mixed cycle and closes angles, cam contacts and both link pins', () => {
    const f = createMechanismCycleFixture(), before = structuredClone(f);
    const walk = oracleAffineCycle(f.edges);
    expect(walk.product).toBe(1);
    expect(walk.phaseDeg).toBe(0);
    const maximum = { gearDeg: 0, loopDeg: 0, camPositionMm: 0, contactGapMm: 0, guideMm: 0,
      pinMm: 0, linkLengthMm: 0, returnPositionMm: 0, returnOrientationDeg: 0 };
    let placements: ReadonlyMap<string, RigidPlacement> = f.placements, reference = 0;
    for (const target of [-60, -30, 0, 30, 60, 0]) {
      const result = solveDrivenJoint(f.assembly, new Map(), placements,
        { jointId: 'ja', coordinate: 'angle', value: target, referenceAngle: reference }, { jointFrames: f.frames });
      expect(result.ok, `mixed cycle at ${target} degrees`).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.outcome.converged).toBe(true);
      const diagnosis = diagnoseMates(f.assembly, result.outcome);
      expect(diagnosis.complete).toBe(true);
      expect(diagnosis.couplingFailure).toBeUndefined();
      expect(diagnosis.couplingRows).toHaveLength(5);
      const support = requireCyclePlacement(result.placements, 'ground');
      const angles = new Map([['ja', oracleAngle(support, requireCyclePlacement(result.placements, 'a'), target)],
        ['jb', oracleAngle(support, requireCyclePlacement(result.placements, 'b'), -2 * target + 20)],
        ['jc', oracleAngle(support, requireCyclePlacement(result.placements, 'c'), target + 13)]]);
      for (const edge of f.edges) {
        const a = angles.get(edge.from), b = angles.get(edge.to);
        if (a === undefined || b === undefined) throw new Error('Missing cycle vertex');
        const error = Math.abs(b - edge.ratio * a - edge.phaseDeg);
        maximum.gearDeg = Math.max(maximum.gearDeg, error);
        expect(error).toBeLessThanOrEqual(1e-6);
      }
      const a = angles.get('ja');
      if (a === undefined) throw new Error('Missing cycle root');
      maximum.loopDeg = Math.max(maximum.loopDeg, Math.abs(walk.returnedAngle(a) - a));
      expect(Math.abs(a - target)).toBeLessThanOrEqual(1e-6);
      expect(maximum.loopDeg).toBeLessThanOrEqual(1e-6);
      for (const [i, cam] of f.cams.entries()) {
        const errors = oracleCamErrors(cam, result.placements, target + (i === 0 ? 0 : 13));
        for (const error of Object.values(errors)) expect(error).toBeLessThanOrEqual(1e-6);
        maximum.camPositionMm = Math.max(maximum.camPositionMm, errors.positionMm);
        maximum.contactGapMm = Math.max(maximum.contactGapMm, errors.contactGapMm);
        maximum.guideMm = Math.max(maximum.guideMm, errors.guideMm);
      }
      const link = oracleLinkErrors(result.placements);
      for (const error of Object.values(link)) expect(error).toBeLessThanOrEqual(1e-6);
      maximum.pinMm = Math.max(maximum.pinMm, link.pinAMm, link.pinCMm);
      maximum.linkLengthMm = Math.max(maximum.linkLengthMm, link.lengthMm);
      placements = result.placements;
      reference = target;
    }
    for (const [id, start] of f.placements) {
      const error = oraclePoseError(start, requireCyclePlacement(placements, id));
      maximum.returnPositionMm = Math.max(maximum.returnPositionMm, error.positionMm);
      maximum.returnOrientationDeg = Math.max(maximum.returnOrientationDeg, error.orientationDeg);
      expect(error.positionMm, id).toBeLessThanOrEqual(1e-6);
      expect(error.orientationDeg, id).toBeLessThanOrEqual(1e-6);
    }
    expect(f).toEqual(before);
    stdout.write(`[W07] ${JSON.stringify({ kind: 'mixed-cycle', product: walk.product, phaseDeg: walk.phaseDeg, maximum })}${String.fromCharCode(10)}`);
  });

  it('rejects the same mixed graph with a proved one-degree affine contradiction before iteration', () => {
    const f = createMechanismCycleFixture(1), before = structuredClone(f);
    const walk = oracleAffineCycle(f.edges);
    // theta = P*theta + Q with P=1,Q=1 is impossible for every theta, independently of solver convergence.
    expect(walk.product).toBe(1);
    expect(walk.phaseDeg).toBe(1);
    for (const angle of [-120, 0, 75]) expect(walk.returnedAngle(angle) - angle).toBe(1);
    const result = solveMates(f.assembly, new Map(), f.placements, { jointFrames: f.frames });
    expect(result.converged).toBe(false);
    expect(result.couplingFailure).toMatchObject({ reason: 'contradictoryLoop' });
    expect(result.iterations).toBe(0);
    expect(result.placements).toEqual(before.placements);
    expect(f).toEqual(before);
    stdout.write(`[W07] ${JSON.stringify({ kind: 'contradictory-cycle', product: walk.product,
      phaseDeg: walk.phaseDeg, reason: result.couplingFailure?.reason, iterations: result.iterations })}${String.fromCharCode(10)}`);
  });
});
