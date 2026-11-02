import { describe, expect, it } from 'vitest';
import type { Vector3, Vector6 } from './analysisModel.js';
import { beamSpanShape, prepareWeldSpan, type WeldSpanPlan } from './beamWeldSpan.js';

function fixture(): WeldSpanPlan {
  return { mesh: { originalNodeCount: 4,
    nodes: [0, 2, 0, 2].map((x, i) => ({ number: i+1, positionM: [x, 0, 0],
      restrained: [false, false, false, false, false, false], load: [0, 0, 0, 0, 0, 0] })),
    members: ['a', 'b'].map((id, i) => ({ number: i+1, id, componentId: id, occurrencePath: [id],
      nodes: [i*2+1, i*2+2], material: 1, section: 1,
      frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], lengthM: 2 } })),
    materials: [{ number: 1, youngPa: 1000, poisson: .25, densityKgM3: 1 }],
    sections: [{ number: 1, areaM2: 1, iyM4: .1, izM4: .1, torsionM4: .1, shearFactor: 1 }],
  }, patches: [{ id: 'physical-bead', first: { kind: 'span', memberId: 'a' }, second: { kind: 'span', memberId: 'b' },
    centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
    thicknessM: .2, youngPa: 1000, poisson: .25 }] };
}
function motions(plan: WeldSpanPlan, f: (p: Vector3, i: number) => Vector6): Vector6[] {
  return plan.mesh.nodes.map((n, i) => f(n.positionM, i));
}
const zero: Vector6 = [0, 0, 0, 0, 0, 0];
const close = (actual: number, expected: number, scale = Math.abs(expected)) =>
  expect(Math.abs(actual-expected)).toBeLessThanOrEqual(1e-9*Math.max(scale, 1e-30));
const sum = (rows: readonly (readonly number[])[], axis: number) => rows.reduce((v, row) => v+row[axis], 0);

describe('straight weld span internal physical kernel', () => {
  it('retains endpoint DOFs and the independent Timoshenko tip-shear field, including the opposite bending sign', () => {
    for (const xi of [0, 1]) {
      const n = beamSpanShape(2, 3/8, 3/8, xi);
      n.forEach((row, i) => row.forEach((v, j) => close(v, j === i+6*xi ? 1 : 0, 1)));
    }
    const n = beamSpanShape(2, 3/8, 3/8, .25), q = [...zero, 0, 19/6000, 0, 0, 0, 1/500];
    const response = n.map(row => row.reduce((v, x, i) => v+x*q[i], 0));
    close(response[1], 17/48000); close(response[5], 7/8000);
    const other = [...zero, 0, 0, 19/6000, 0, -1/500, 0];
    const w = n.map(row => row.reduce((v, x, i) => v+x*other[i], 0));
    close(w[2], 17/48000); close(w[4], -7/8000);
  });

  it('recovers F10/U1/200 from independent uniform normal displacement without changing input', () => {
    const p = fixture(), before = structuredClone(p), k = prepareWeldSpan(p);
    const r = k.evaluate(motions(p, (_x, i) => i < 2 ? zero : [0, .001, 0, 0, 0, 0]))[0];
    close(r.forceOnFirstN[1], 10); close(r.energyJ, 1/200);
    close(sum(r.first, 1), 10); close(sum(r.second, 1), -10);
    expect(p).toEqual(before); expect(r.structuralCertification).toBe(false);
  });

  it('uses the shear density for uniform axial slip and the closed-form axial strain integral', () => {
    const p = fixture(), k = prepareWeldSpan(p);
    const slip = k.evaluate(motions(p, (_x, i) => i < 2 ? zero : [.001, 0, 0, 0, 0, 0]))[0];
    close(slip.forceOnFirstN[0], 4); close(slip.energyJ, 1/500);
    const strain = k.evaluate(motions(p, (x, i) => i < 2 ? zero : [.001*x[0], 0, 0, 0, 0, 0]))[0];
    close(strain.forceOnFirstN[0], 4); close(strain.energyJ, 1/375);
  });

  it('integrates the pure curvature field to F20/3, origin Mz10 and U1/250 with four longitudinal points', () => {
    const p = fixture(), k = prepareWeldSpan(p);
    const r = k.evaluate(motions(p, (x, i) => i < 2 ? zero : [0, .0005*x[0]**2, 0, 0, 0, .001*x[0]]))[0];
    close(r.forceOnFirstN[1], 20/3); close(r.momentAtCenterNm[2]+r.forceOnFirstN[1], 10);
    close(r.energyJ, 1/250);
    const origin = r.first.reduce((v, row, i) => v+row[5]+p.mesh.nodes[i].positionM[0]*row[1], 0);
    close(origin, 10);
  });

  it('recovers the torsion cross-section field Mx5/6 and U1/2400 with zero resultant force', () => {
    const p = fixture();
    const r = prepareWeldSpan(p).evaluate(motions(p, (_x, i) => i < 2 ? zero : [0, 0, 0, .001, 0, 0]))[0];
    close(r.forceOnFirstN[1], 0, 1); close(r.momentAtCenterNm[0], 5/6); close(r.energyJ, 1/2400);
  });

  it('maps eccentric slip by the adjoint: end Fx2, Fy +/-8/35 and Mz -6/35, not a rigid F/2 surrogate', () => {
    const p = fixture(); Object.assign(p.patches[0], { centerM: [1, .2, 0] });
    const r = prepareWeldSpan(p).evaluate(motions(p, (_x, i) => i < 2 ? zero : [.001, 0, 0, 0, 0, 0]))[0];
    close(r.first[0][0], 2); close(r.first[1][0], 2);
    close(r.first[0][1], 8/35); close(r.first[1][1], -8/35);
    close(r.first[0][5], -6/35); close(r.first[1][5], -6/35);
    close(2*r.first[1][1]+sum(r.first, 5), -4/5);
    // Unit virtual v at the first A node: integral traction . delta-u = 8/35 J.
    close(r.first[0][1], 8/35);
  });

  it('assembles symmetric B^T D B, keeps energy positive, and preserves nodal virtual work and both-side balance', () => {
    const p = fixture(), k = prepareWeldSpan(p);
    const q = motions(p, (x, i) => [i*.0001, x[0]*.0003, -.0004*i, .0002, -.0001*i, .0005]);
    const r = k.evaluate(q)[0], flat = q.flat(), internal = k.stiffness.map(row => row.reduce((v, x, i) => v+x*flat[i], 0));
    close(flat.reduce((v, x, i) => v+x*internal[i], 0)/2, r.energyJ);
    for (let i = 0; i < internal.length; i++) close(internal[i], -r.first[Math.floor(i/6)][i%6]-r.second[Math.floor(i/6)][i%6], 20);
    k.stiffness.forEach((row, i) => row.forEach((v, j) => close(v, k.stiffness[j][i], 1e5)));
    for (let a = 0; a < 3; a++) close(sum(r.first, a)+sum(r.second, a), 0, 20);
    const moment = [0, 0, 0];
    r.first.forEach((row, i) => {
      const x = p.mesh.nodes[i].positionM, f = row.map((v, a) => v+r.second[i][a]);
      moment[0] += f[3]+x[1]*f[2]-x[2]*f[1];
      moment[1] += f[4]+x[2]*f[0]-x[0]*f[2];
      moment[2] += f[5]+x[0]*f[1]-x[1]*f[0];
    });
    moment.forEach(v => close(v, 0, 20));
  });

  it('reproduces arbitrary common rigid translation and rotation at every eccentric point', () => {
    const p = fixture(); Object.assign(p.patches[0], { centerM: [1, .2, 0] });
    const r = prepareWeldSpan(p).evaluate(motions(p, (x) => [
      .003+.002*x[2]+.004*x[1], -.001-.004*x[0]-.003*x[2], .005+.003*x[1]-.002*x[0], .003, .002, -.004,
    ]))[0];
    expect(r.energyJ).toBeLessThan(1e-25);
    r.forceOnFirstN.forEach(v => close(v, 0, 1e-4));
  });

  it('retains world-frame invariance under a nontrivial axis permutation and translation', () => {
    const p = fixture(), transformed = fixture();
    const rotate = (v: Vector3): Vector3 => [v[2], v[0], v[1]];
    transformed.mesh.nodes.forEach(n => Object.assign(n, { positionM: rotate([n.positionM[0]+3, n.positionM[1]-2, n.positionM[2]+5]) }));
    transformed.mesh.members.forEach(e => Object.assign(e, { frame: { ...e.frame, x: rotate(e.frame.x), y: rotate(e.frame.y), z: rotate(e.frame.z) } }));
    Object.assign(transformed.patches[0], { centerM: rotate([4, -2, 5]), normal: rotate([0, 1, 0]), along: rotate([1, 0, 0]) });
    const a = prepareWeldSpan(p).evaluate(motions(p, (_x, i) => i < 2 ? zero : [.001, .002, -.001, 0, 0, 0]))[0];
    const b = prepareWeldSpan(transformed).evaluate(motions(transformed, (_x, i) => i < 2 ? zero : [-.001, .001, .002, 0, 0, 0]))[0];
    close(b.energyJ, a.energyJ); rotate(a.forceOnFirstN).forEach((v, i) => close(b.forceOnFirstN[i], v));
  });

  it('exchanges sides, reverses signs and records actual zero without changing the physical energy', () => {
    const p = fixture(), k = prepareWeldSpan(p), q = motions(p, (_x, i) => i < 2 ? zero : [0, .001, 0, 0, 0, 0]);
    const positive = k.evaluate(q)[0], negative = k.evaluate(q.map(row => [-row[0], -row[1], -row[2], -row[3], -row[4], -row[5]] as Vector6))[0];
    close(negative.energyJ, positive.energyJ); close(negative.forceOnFirstN[1], -10);
    const swapped = fixture(); Object.assign(swapped.patches[0], { first: p.patches[0].second, second: p.patches[0].first });
    const r = prepareWeldSpan(swapped).evaluate(q)[0]; close(r.energyJ, positive.energyJ); close(r.forceOnFirstN[1], -10);
    expect(k.evaluate(motions(p, () => zero))[0].energyJ).toBe(0);
  });

  it('partitions the same physical area at x=.7 without filling a gap or multiplying energy', () => {
    const p = fixture(), q = motions(p, (x, i) => i < 2 ? zero : [0, .0005*x[0]**2, 0, 0, 0, .001*x[0]]);
    const whole = prepareWeldSpan(p).evaluate(q)[0];
    const left = fixture(), right = fixture();
    Object.assign(left.patches[0], { widthM: .7, centerM: [.35, 0, 0] });
    Object.assign(right.patches[0], { widthM: 1.3, centerM: [1.35, 0, 0] });
    const a = prepareWeldSpan(left).evaluate(q)[0], b = prepareWeldSpan(right).evaluate(q)[0];
    close(a.energyJ+b.energyJ, whole.energyJ); close(a.forceOnFirstN[1]+b.forceOnFirstN[1], 20/3);
  });

  it('uses both meshes boundary union and actual internal DOFs; refuses missing motion rather than zero completion', () => {
    const p = fixture();
    const nodes = [...p.mesh.nodes,
      { ...p.mesh.nodes[0], number: 5, positionM: [.7, 0, 0] as Vector3 },
      { ...p.mesh.nodes[0], number: 6, positionM: [1.3, 0, 0] as Vector3 }];
    const a = p.mesh.members[0], b = p.mesh.members[1];
    const members = [[1, 5, .7], [5, 2, 1.3], [3, 6, 1.3], [6, 4, .7]].map((row, i) => {
      const e = i < 2 ? a : b;
      return { ...e, number: i+1, nodes: [row[0], row[1]] as [number, number], frame: { ...e.frame, lengthM: row[2] } };
    });
    const refined = { ...p, mesh: { ...p.mesh, nodes, members } }, k = prepareWeldSpan(refined);
    expect(k.cellCounts).toEqual([3]);
    expect(() => k.evaluate(motions(p, () => zero))).toThrow();
    const q = motions(refined, (_x, i) => i === 5 ? [0, .001, 0, 0, 0, 0] : zero);
    expect(k.evaluate(q)[0].energyJ).toBeGreaterThan(0);
    const rigid = k.evaluate(motions(refined, (_x, i) => [0, i === 2 || i === 3 || i === 5 ? .001 : 0, 0, 0, 0, 0]))[0];
    close(rigid.forceOnFirstN[1], 10); close(rigid.energyJ, 1/200);
  });

  it('keeps section-node rigid maps explicit and snapshots later input mutation', () => {
    const p = fixture(); Object.assign(p.patches[0], { first: { kind: 'section', node: 1 } });
    const k = prepareWeldSpan(p); Object.assign(p.patches[0], { youngPa: 1 });
    const r = k.evaluate(motions(p, (_x, i) => i < 2 ? zero : [0, .001, 0, 0, 0, 0]))[0];
    close(r.forceOnFirstN[1], 10); close(r.first[0][1], 10); close(r.first[0][5], 10);
  });

  it('preserves the world field when one beam element points against the saved bead direction', () => {
    const p = fixture();
    Object.assign(p.mesh.members[1], { nodes: [4, 3], frame: { x: [-1, 0, 0], y: [0, 1, 0], z: [0, 0, -1], lengthM: 2 } });
    const r = prepareWeldSpan(p).evaluate(motions(p, (x, i) => i < 2 ? zero : [0, .0005*x[0]**2, 0, 0, 0, .001*x[0]]))[0];
    close(r.forceOnFirstN[1], 20/3); close(r.energyJ, 1/250);
  });

  it('refuses unsupported frame, span extrapolation, missing member, overlap, hidden initial strain and invalid numbers', () => {
    const cases: ((p: WeldSpanPlan) => void)[] = [
      p => Object.assign(p.patches[0], { normal: [1, 0, 0] }),
      p => Object.assign(p.patches[0], { widthM: 3 }),
      p => Object.assign(p.patches[0], { first: { kind: 'span', memberId: 'missing' } }),
      p => Object.assign(p, { patches: [p.patches[0], p.patches[0]] }),
      p => Object.assign(p, { patches: [p.patches[0], { ...p.patches[0], id: 'overlapping-physical-area' }] }),
      p => Object.assign(p, { initialStrain: .001 }),
      p => Object.assign(p.patches[0], { thicknessM: Number.NaN }),
      p => Object.assign(p.patches[0], { poisson: '0.25' }),
      p => Object.assign(p.mesh.members[0].frame, { lengthM: '2' }),
      p => Object.assign(p.mesh.members[0], { nodes: [1, 99] }),
      p => Object.assign(p.patches[0], { along: [0, 0, 1] }),
      p => { Object.assign(p.mesh, { originalNodeCount: 2 }); Object.assign(p.patches[0], { first: { kind: 'section', node: 3 } }); },
      p => Object.assign(p.mesh, { members: [p.mesh.members[0], { ...p.mesh.members[0], number: 2 }, { ...p.mesh.members[1], number: 3 }] }),
    ];
    cases.forEach(change => { const p = fixture(); change(p); expect(() => prepareWeldSpan(p)).toThrow(); });
    expect(() => beamSpanShape(2, 3/8, 3/8, -1e-9)).toThrow();
    expect(() => beamSpanShape(2, Number.POSITIVE_INFINITY, 0, .5)).toThrow();
  });

  it('refuses limits, accessors, sparse arrays, prescribed-support violations and nonfinite full motions', () => {
    const p = fixture();
    expect(() => prepareWeldSpan({ ...p, patches: Array.from({ length: 65 }, () => p.patches[0]) })).toThrow();
    const oversized = fixture(); Object.assign(oversized.mesh, { nodes: Array.from({ length: 129 }, () => p.mesh.nodes[0]) });
    expect(() => prepareWeldSpan(oversized)).toThrow();
    const accessor = fixture(), getter = () => { throw new Error('must not evaluate getter'); };
    Object.defineProperty(accessor.patches[0], 'youngPa', { get: getter });
    expect(() => prepareWeldSpan(accessor)).toThrow('weld-span');
    const hole = fixture(); Object.assign(hole.mesh, { nodes: Array<Vector3>(4) }); expect(() => prepareWeldSpan(hole)).toThrow();
    const supported = fixture(); Object.assign(supported.mesh.nodes[0], { restrained: [true, false, false, false, false, false] });
    const k = prepareWeldSpan(supported);
    expect(() => k.evaluate(motions(supported, () => [.001, 0, 0, 0, 0, 0]))).toThrow();
    expect(() => k.evaluate(motions(supported, () => [0, Number.NaN, 0, 0, 0, 0]))).toThrow();
  });
});

describe('occurrence path strict array input regression', () => {
  it.each(['a', { a: 7 }])('refuses non-array occurrence path %j', occurrencePath => {
    const p = fixture();
    Object.assign(p.mesh.members[0], { occurrencePath });
    expect(() => prepareWeldSpan(p)).toThrow();
  });

  it('retains the valid occurrence path array and its independent force and energy', () => {
    const p = fixture(), before = structuredClone(p);
    expect(p.mesh.members[0].occurrencePath).toEqual(['a']);
    const r = prepareWeldSpan(p).evaluate(motions(p, (_x, i) => i < 2 ? zero : [0, .001, 0, 0, 0, 0]))[0];
    close(r.forceOnFirstN[1], 10); close(r.energyJ, 1/200);
    expect(p).toEqual(before);
  });
});
