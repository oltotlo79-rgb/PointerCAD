import type { CadSolidOutcome } from '@pointercad/fem';
import { describe, expect, it } from 'vitest';
import { buildSolidFieldMesh, solidFieldFraction, solidFieldLegend, solidFieldValue, vonMisesMPa } from './solidFieldView.js';

type SolidResult = Extract<CadSolidOutcome, { kind: 'result' }>;
type Vector6 = readonly [number, number, number, number, number, number];
type Vector3 = readonly [number, number, number];

/** Two positively oriented unit tetrahedra sharing face (1, 2, 3); node 4 mirrors node 0 across it. */
const NODES: readonly Vector3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [2 / 3, 2 / 3, 2 / 3]];
const ELEMENTS: readonly (readonly [number, number, number, number])[] = [[0, 1, 2, 3], [4, 1, 3, 2]];

function outcome(stresses: readonly Vector6[], displacement: readonly Vector3[] = NODES.map(() => [0, 0, 0])): SolidResult {
  // Only the fields the view reads are meaningful; the rest are inert, typed placeholders of the real shapes.
  const input = { schema: 'pointercad-solid-tet4/1', source: { documentId: 'd', revision: 1, meshKey: 'm' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1, nodes: NODES, elements: ELEMENTS.map(nodes => ({ nodes, materialId: 'material' })),
    materials: [{ id: 'material', youngMPa: 1, poisson: 0.3 }], constraints: [], nodalLoads: [], surfaceLoads: [] } as const;
  const result = { kind: 'oofem-linear-solid-tet4', source: input.source, inputSha256: 'x',
    method: 'oofem-ltrspace-isole-native-ldlt/1', units: 'N-mm-MPa', structuralCertification: false,
    displacementMm: displacement, reactionN: NODES.map((): Vector3 => [0, 0, 0]),
    elements: stresses.map(stressMPa => ({ strain: [0, 0, 0, 0, 0, 0] as const, stressMPa })),
    strainEnergyNmm: 0, maximumRelativeEquilibriumResidual: 0, reservedNumericBytes: 0,
    nativeElementForcesN: ELEMENTS.map(() => []), minimumScaledPivot: 1 } as const;
  const parsed: SolidResult['result'] = result;
  const prepared: SolidResult['prepared'] = { input, loadedAreaMm2: 1, totalForceN: [0, 0, 0] };
  const mesh: SolidResult['mesh'] = { kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1',
    source: { documentId: 'd', revision: 1, featureId: 'f', bodyKey: 'k' }, units: 'mm', coordinates: [], triangles: [],
    tags: [], tagCount: 0 }, inputSha256: 'x', coordinates: [], tetrahedra: [], boundaryTriangles: [], boundaryTags: [],
  volumeMm3: 0, minTetVolumeMm3: 0 };
  return { kind: 'result', result: parsed, prepared, mesh };
}

describe('solid field view (display only)', () => {
  it('computes independently known von Mises and component values', () => {
    // Uniaxial 100 MPa: von Mises 100. Pure shear xy 10: sqrt(3)*10. Biaxial +50/-50: sqrt(7500).
    expect(vonMisesMPa([100, 0, 0, 0, 0, 0])).toBeCloseTo(100, 12);
    expect(vonMisesMPa([0, 0, 0, 0, 0, 10])).toBeCloseTo(10 * Math.sqrt(3), 12);
    expect(vonMisesMPa([50, -50, 0, 0, 0, 0])).toBeCloseTo(Math.sqrt(7500), 12);
    expect(solidFieldValue([1, 2, 3, 4, 5, 6], 'yz')).toBe(4);
    expect(solidFieldValue([1, 2, 3, 4, 5, -6], 'xy')).toBe(-6);
  });

  it('keeps von Mises exact in the moderate band and the original hypot result outside it, without NaN at extreme finite stresses', () => {
    // The original form, evaluated independently here, is the reference outside the band.
    const original = (s: readonly [number, number, number, number, number, number]): number => Math.hypot(
      (s[0] - s[1]) / Math.SQRT2, (s[1] - s[2]) / Math.SQRT2, (s[2] - s[0]) / Math.SQRT2,
      Math.sqrt(3) * s[5], Math.sqrt(3) * s[3], Math.sqrt(3) * s[4]);
    const max = Number.MAX_VALUE, min = Number.MIN_VALUE;
    // Inside the band: exactly the independent values 100 and sqrt((40^2 + 40^2) / 2 + 3 * 20^2) = sqrt(2800).
    expect(vonMisesMPa([100, 0, 0, 0, 0, 0])).toBe(100);
    expect(vonMisesMPa([-40, 0, 0, 0, 0, 20])).toBe(Math.sqrt(2800));
    // Equal hydrostatic MAX with a moderate shear: the differences are 0, so only sqrt(3) * shear remains.
    expect(vonMisesMPa([max, max, max, 0, 0, 1])).toBe(Math.sqrt(3));
    // Equal 1e200 normals with a 1e-200 shear: outside the band, the real shear is kept (not underflowed to 0).
    expect(vonMisesMPa([1e200, 1e200, 1e200, 0, 0, 1e-200])).toBe(Math.sqrt(3) * 1e-200);
    expect(vonMisesMPa([1e200, 1e200, 1e200, 0, 0, 1e-200])).toBeGreaterThan(0);
    // MAX uniaxial and the smallest finite inputs: never NaN, the same result as the original form.
    for (const stress of [[max, 0, 0, 0, 0, 0], [-max, 0, 0, 0, 0, 0], [min, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, -min],
      [1e200, 0, 0, 0, 0, 0], [1e-200, 0, 0, 0, 0, 0]] as const) {
      expect(vonMisesMPa(stress)).not.toBeNaN();
      expect(vonMisesMPa(stress)).toBe(original(stress));
    }
    // Zero and non-finite input keep the previous results, which buildSolidFieldMesh then refuses.
    expect(vonMisesMPa([0, 0, 0, 0, 0, 0])).toBe(0);
    expect(vonMisesMPa([Number.POSITIVE_INFINITY, 0, 0, 0, 0, 0])).toBe(Number.POSITIVE_INFINITY);
    expect(vonMisesMPa([Number.NaN, 0, 0, 0, 0, 0])).toBeNaN();
  });

  it('keeps each boundary triangle on its owning element and drops the shared interior face', () => {
    const field = buildSolidFieldMesh(outcome([[100, 0, 0, 0, 0, 0], [-40, 0, 0, 0, 0, 0]]), 'xx', 0);
    if (field === null) throw new Error('field expected');
    expect(field.triangleElements).toHaveLength(6); // 2 x 4 faces minus the shared face counted twice
    expect(field.triangleElements.filter(element => element === 0)).toHaveLength(3);
    expect(field.triangleElements.filter(element => element === 1)).toHaveLength(3);
    expect(field.elementValues).toEqual([100, -40]);
    expect(field.positions).toHaveLength(6 * 9);
    expect(field.legend).toEqual({ minimumMPa: -40, maximumMPa: 100, constant: false });
  });

  it('deforms positions by exactly scale times the node displacement', () => {
    const displacement: Vector3[] = [[0, 0, 0], [0.01, 0, 0], [0, -0.02, 0], [0, 0, 0.03], [0.004, 0.005, 0.006]];
    const field = buildSolidFieldMesh(outcome([[1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0]], displacement), 'vonMises', 100);
    if (field === null) throw new Error('field expected');
    const corners = new Set<string>();
    for (let index = 0; index < field.positions.length; index += 3) {
      corners.add(field.positions.slice(index, index + 3).map(value => value.toFixed(9)).join(','));
    }
    // Node 1 (1,0,0)+100*(0.01,0,0)=(2,0,0); node 2 -> (0,-1,0); node 3 -> (0,0,4); node 4 -> (2/3+0.4, 2/3+0.5, 2/3+0.6).
    expect(corners.has('2.000000000,0.000000000,0.000000000')).toBe(true);
    expect(corners.has('0.000000000,-1.000000000,0.000000000')).toBe(true);
    expect(corners.has('0.000000000,0.000000000,4.000000000')).toBe(true);
    expect(corners.has([2 / 3 + 0.4, 2 / 3 + 0.5, 2 / 3 + 0.6].map(value => value.toFixed(9)).join(','))).toBe(true);
    expect(field.legend.constant).toBe(true);
    expect(solidFieldFraction(1, field.legend)).toBe(0.5);
  });

  it('gives finite ordered bounds for zero, constant and negative components and refuses non-finite or mismatched data', () => {
    expect(solidFieldLegend([0, 0])).toEqual({ minimumMPa: 0, maximumMPa: 0, constant: true });
    expect(solidFieldLegend([-5, -2, -9])).toEqual({ minimumMPa: -9, maximumMPa: -2, constant: false });
    expect(solidFieldLegend([])).toBeNull();
    expect(solidFieldLegend([1, Number.NaN])).toBeNull();
    expect(buildSolidFieldMesh(outcome([[1, 0, 0, 0, 0, 0]]), 'xx', 1)).toBeNull(); // one stress for two elements
    expect(buildSolidFieldMesh(outcome([[1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0]]), 'xx', -1)).toBeNull();
  });
});
