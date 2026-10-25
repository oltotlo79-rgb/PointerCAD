import { describe, expect, it } from 'vitest';
import { cadSolidPlasticInput, type CadSolidPlasticSettings } from './cadSolidPlastic.js';
import type { CadSolidPrepared } from './cadSolidAnalysis.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';

/** PROVISIONAL (authored, unexecuted). Benchmark constants for this test only, not a material specification. */
function prepared(): CadSolidPrepared {
  const input = translateSolidAnalysis({ schema: 'pointercad-solid-tet4/1', units: 'N-mm-MPa',
    source: { documentId: 'part', revision: 7, meshKey: 'mesh-1' }, numericBudgetBytes: 1_000_000,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [{ materialId: 'm', nodes: [0, 1, 2, 3] }],
    materials: [{ id: 'm', youngMPa: 200000, poisson: 0.3 }],
    constraints: [0, 1, 2].map(node => ({ node, fixed: [true, true, true] })), nodalLoads: [],
    surfaceLoads: [{ nodes: [1, 2, 3], tractionMPa: [0, 0, 2] }] }).input;
  return { input, loadedAreaMm2: Math.sqrt(3) / 2, totalForceN: [0, 0, Math.sqrt(3)] };
}
function settings(): CadSolidPlasticSettings {
  return { material: { id: 'm', youngMPa: 200000, poisson: 0.3 }, fixedFaces: [], loadedFaces: [], tractionMPa: [0, 0, 2],
    numericBudgetBytes: 1_000_000, geometry: { kind: 'planar', boundary: { boundary: 'closed', linearDeflection: 0.05,
      angularDeflection: 0.2 } }, yieldStressMPa: 250, hardeningModulusMPa: 2000,
    materialReference: 'Test benchmark constants, not a material specification', loadFactor: [0, 1, 0, -1, 0], stepsPerSegment: 2 };
}

describe('CAD plasticity bridge maps the adopted linear tet4 input without new algebra (provisional)', () => {
  it('turns fixed nodes into zero prescriptions and reuses the linear nodal forces as the reference load', () => {
    const value = prepared(), linear = translateSolidAnalysis(value.input).plan;
    const input = cadSolidPlasticInput(value, settings());
    expect(input.source).toEqual({ documentId: 'part', revision: 7 });
    expect(input.plan.prescribedMm).toHaveLength(9);
    expect(input.plan.prescribedMm.every(p => p.valueMm === 0 && p.node <= 2)).toBe(true);
    // Free DOFs are those of node 3; the forces are exactly the adopted translation's consistent nodal forces.
    for (const force of input.plan.forcesN) {
      expect(force.node).toBe(3);
      expect(force.forceN).toBe(linear.forcesN[3]['xyz'.indexOf(force.dof)]);
    }
    const sumZ = linear.forcesN.reduce((sum, row) => sum + row[2], 0);
    expect(Math.abs(sumZ - Math.sqrt(3))).toBeLessThan(1e-12);
    expect(input.plan.loadFactor).toEqual([0, 1, 0, -1, 0]);
    expect(input.plan.material).toEqual({ youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
      source: { kind: 'user-supplied', reference: 'Test benchmark constants, not a material specification' } });
  });

  it('refuses before sending when the plasticity plan bounds are violated', () => {
    expect(() => cadSolidPlasticInput(prepared(), { ...settings(), materialReference: ' ' })).toThrow('material.source.reference');
    expect(() => cadSolidPlasticInput(prepared(), { ...settings(), yieldStressMPa: 300000 })).toThrow('yieldStressMPa');
    expect(() => cadSolidPlasticInput(prepared(), { ...settings(), loadFactor: [0, 1, 1] })).toThrow('consecutive load-factor knots');
  });
});
