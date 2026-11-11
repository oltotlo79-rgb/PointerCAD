import { describe, expect, it } from 'vitest';
import { calculateBoltPreloadStages, type BoltPreloadDeclaration } from './boltPreloadStages.js';
import { initialStrainTestInput } from './beamJointInitialStrain.testSupport.js';

function fixture() {
  const old = initialStrainTestInput(.00005);
  // Existing geometry length=1m. E=200GPa,A=.001m2 -> shank compliance=5nm/N.
  const input = { ...old, joint: { ...old.joint, bolts: [{ ...old.joint.bolts[0], youngPa: 200e9, areaM2: .001 }] } };
  const source = { kind: 'user-supplied' as const, reference: 'independent synthetic two-spring fixture',
    condition: 'linear elastic; outer-plane loading; disjoint compliance regions; no capacity claim' };
  const item = (value: number) => ({ value, source });
  const declaration: BoltPreloadDeclaration = { boltId: 'bolt', model: 'coaxial-outer-planes-series-bearing',
    modelSource: source, shankSource: source, shorteningSource: source, preloadN: item(4000),
    threadCompliance: item(2e-9), headCompliance: item(1e-9), bearingCompliance: item(2e-9), memberCompliance: item(2.5e-9),
    externalLoadsN: [0, 1000, 4999, 5000, 5001, 1000, 0], loadSource: source };
  return { input, declaration };
}
describe('explicit axial tightening stages and series compliance', () => {
  it('retains original shortening, requires its force compatibility, and preserves each stage and provenance', () => {
    const f = fixture(), before = structuredClone(f), r = calculateBoltPreloadStages(f.input, f.declaration);
    expect(f).toEqual(before);
    expect(r.input).toEqual(f.input);
    expect(r.declaration).toEqual(f.declaration);
    expect(r.kind).toBe('analytic-selected-bolt-preload');
    expect(r.preparation).toEqual({ kind: 'prescribed-shortening', shorteningM: .00005, equilibriumSolved: false });
    expect(r.equilibratedPreloadN).toBeCloseTo(4000, 9);
    expect(r.tightening.boltTensionN).toBeCloseTo(4000, 9);
    expect(r.tightening.memberCompressionN).toBeCloseTo(4000, 9);
    expect(r.tightening.portDisplacementM).toBeCloseTo(-.00001, 14);
    expect(r.tightening.elasticEnergyJ).toBeCloseTo(.1, 12);
    expect(() => calculateBoltPreloadStages(initialStrainTestInput(1e-6), f.declaration)).toThrow('preload-shortening-force-mismatch');
  });
  it('matches independently solved forces before/at/after separation and reversible unloading', () => {
    const f = fixture(), r = calculateBoltPreloadStages(f.input, f.declaration);
    // cb=10nm/N,cm=2.5nm/N; (N-Q=P,10N+2.5Q=50000) in nm units.
    const expected = [[4000, 4000, -1e-5, .1], [4200, 3200, -8e-6, .101],
      [4999.8, .8, -2e-9, .124990001], [5000, 0, 0, .125],
      [5001, 0, 1e-8, .125050005], [4200, 3200, -8e-6, .101], [4000, 4000, -1e-5, .1]];
    expect(r.loadFraction).toBeCloseTo(.2, 12);
    expect(Math.abs(r.separationLoadN - 5000) / 5000).toBeLessThanOrEqual(.01);
    expect(Math.abs((r.external[1].boltTensionN - r.tightening.boltTensionN) - 200) / 200).toBeLessThanOrEqual(.001);
    for (const [i, row] of r.external.entries()) {
      expect(row.boltTensionN).toBeCloseTo(expected[i][0], 8);
      expect(row.memberCompressionN).toBeCloseTo(expected[i][1], 8);
      expect(row.portDisplacementM).toBeCloseTo(expected[i][2], 14);
      expect(row.elasticEnergyJ).toBeCloseTo(expected[i][3], 12);
      expect(Math.abs(row.boltTensionN - row.memberCompressionN - row.externalLoadN)).toBeLessThanOrEqual(1e-8);
      expect(row.gapM * row.memberCompressionN).toBe(0);
    }
    expect(r.external.map(s => s.state)).toEqual(['clamped', 'clamped', 'clamped', 'separation', 'separated', 'clamped', 'clamped']);
    expect(r.external[0]).toEqual(r.external[6]);
    expect(r.external[1]).toEqual(r.external[5]);
  });
  it('keeps zero preload and explicit rigid extras distinct from absent compliance or source', () => {
    const f = fixture(), zero = { ...f.input, shortenings: [{ boltId: 'bolt', shorteningM: 0 }] };
    const r = calculateBoltPreloadStages(zero, { ...f.declaration, preloadN: { ...f.declaration.preloadN, value: 0 }, externalLoadsN: [0, 1, 0] });
    expect(r.external.map(s => s.boltTensionN)).toEqual([0, 1, 0]);
    expect(r.external[1].gapM).toBeCloseTo(1e-8, 15);
    expect(() => calculateBoltPreloadStages(zero, { ...f.declaration, preloadN: { ...f.declaration.preloadN, value: 1e-320 } })).toThrow('preload-number');
    const rigid = { ...f.declaration, threadCompliance: { ...f.declaration.threadCompliance, value: 0 },
      headCompliance: { ...f.declaration.headCompliance, value: 0 }, bearingCompliance: { ...f.declaration.bearingCompliance, value: 0 } };
    expect(calculateBoltPreloadStages({ ...f.input, shortenings: [{ boltId: 'bolt', shorteningM: .00003 }] }, rigid).equilibratedPreloadN).toBeCloseTo(4000, 9);
    for (const key of ['threadCompliance', 'headCompliance', 'bearingCompliance', 'memberCompliance', 'modelSource', 'shankSource', 'shorteningSource', 'loadSource']) {
      const missing: Record<string, unknown> = { ...f.declaration }; delete missing[key];
      expect(() => calculateBoltPreloadStages(f.input, missing)).toThrow();
    }
  });
  it('does not reject exact separation because a product roundoff becomes a negative gap', () => {
    const f = fixture();
    // cb=11nm/N, cm=2.5nm/N, s=3um. Independent N=P,Q=0 at P=3um/(11nm/N).
    const d = { ...f.declaration, threadCompliance: { ...f.declaration.threadCompliance, value: 3e-9 },
      preloadN: { ...f.declaration.preloadN, value: .000003 / (11e-9 + 2.5e-9) }, externalLoadsN: [.000003 / (1 / (200e9 * .001) + 3e-9 + 1e-9 + 2e-9)] };
    const r = calculateBoltPreloadStages({ ...f.input, shortenings: [{ boltId: 'bolt', shorteningM: .000003 }] }, d);
    expect(r.external[0].gapM).toBe(0);
    expect(r.external[0].memberCompressionN).toBe(0);
    expect(r.external[0].state).toBe('separation');
  });
  it('rejects unsupported loading, unbound provenance, malformed history and foreign identity', () => {
    const f = fixture();
    for (const patch of [{ boltId: 'foreign' }, { torqueNm: 10 }, { model: 'midplane' },
      { externalLoadsN: [-1] }, { externalLoadsN: [NaN] }, { externalLoadsN: Array(1) }, { externalLoadsN: Array(33).fill(0) },
      { preloadN: { value: 4000 } }, { memberCompliance: { ...f.declaration.memberCompliance, value: 0 } },
      { bearingCompliance: { value: 2e-9, source: { kind: 'measured', reference: '', condition: 'unknown' } } },
      { threadCompliance: { ...f.declaration.threadCompliance, value: -1 } }]) {
      expect(() => calculateBoltPreloadStages(f.input, { ...f.declaration, ...patch })).toThrow();
    }
  });
});
