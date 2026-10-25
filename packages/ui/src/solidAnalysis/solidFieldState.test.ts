import type { CadSolidOutcome } from '@pointercad/fem';
import { describe, expect, it } from 'vitest';
import { createSolidAnalysisSession, type SolidAnalysisSession } from './solidAnalysisSession.js';
import { DEFAULT_SOLID_FIELD_VIEW, solidAnalysisFieldOf } from './solidFieldState.js';

type SolidResult = Extract<CadSolidOutcome, { kind: 'result' }>;
type Vector3 = readonly [number, number, number];
const NODES: readonly Vector3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** One unit Tet4 with uniaxial 100 MPa and node 1 moved by 0.01 mm in x. */
function outcome(): SolidResult {
  const input = { schema: 'pointercad-solid-tet4/1', source: { documentId: 'd', revision: 1, meshKey: 'm' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1, nodes: NODES, elements: [{ nodes: [0, 1, 2, 3] as const, materialId: 'material' }],
    materials: [{ id: 'material', youngMPa: 1, poisson: 0.3 }], constraints: [], nodalLoads: [], surfaceLoads: [] } as const;
  const result: SolidResult['result'] = { kind: 'oofem-linear-solid-tet4', source: input.source, inputSha256: 'x',
    method: 'oofem-ltrspace-isole-native-ldlt/1', units: 'N-mm-MPa', structuralCertification: false,
    displacementMm: [[0, 0, 0], [0.01, 0, 0], [0, 0, 0], [0, 0, 0]], reactionN: NODES.map((): Vector3 => [0, 0, 0]),
    elements: [{ strain: [0, 0, 0, 0, 0, 0], stressMPa: [100, 0, 0, 0, 0, 0] }], strainEnergyNmm: 0,
    maximumRelativeEquilibriumResidual: 0, reservedNumericBytes: 0, nativeElementForcesN: [[]], minimumScaledPivot: 1 };
  const mesh: SolidResult['mesh'] = { kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1',
    source: { documentId: 'd', revision: 1, featureId: 'f', bodyKey: 'k' }, units: 'mm', coordinates: [], triangles: [],
    tags: [], tagCount: 0 }, inputSha256: 'x', coordinates: [], tetrahedra: [], boundaryTriangles: [], boundaryTags: [],
  volumeMm3: 0, minTetVolumeMm3: 0 };
  return { kind: 'result', result, prepared: { input, loadedAreaMm2: 1, totalForceN: [0, 0, 0] }, mesh };
}
function complete(): SolidAnalysisSession {
  return { ...createSolidAnalysisSession('owner'), status: 'complete', result: outcome() };
}

describe('solid field state (display only)', () => {
  it('starts from the default view choice, which is not part of the saved input', () => {
    expect(createSolidAnalysisSession('owner').fieldView).toEqual(DEFAULT_SOLID_FIELD_VIEW);
  });

  it('draws only a completed current result', () => {
    expect(solidAnalysisFieldOf(null)).toBeNull();
    const done = complete();
    for (const status of ['editing', 'running', 'failed', 'cancelled'] as const) {
      expect(solidAnalysisFieldOf({ ...done, status })).toBeNull();
    }
    expect(solidAnalysisFieldOf({ ...done, result: null })).toBeNull();
    const field = solidAnalysisFieldOf(done);
    expect(field?.triangleElements).toEqual([0, 0, 0, 0]);
    expect(field?.elementValues).toEqual([100]);
  });

  it('reuses the mesh for the same result and choice and rebuilds when the choice changes', () => {
    const done = complete();
    const first = solidAnalysisFieldOf(done);
    expect(solidAnalysisFieldOf({ ...done, focused: 'young' })).toBe(first);
    const scaled = solidAnalysisFieldOf({ ...done, fieldView: { quantity: 'vonMises', deformationScale: 100 } });
    expect(scaled).not.toBe(first);
    // Node 1 drawn at (1 + 100 * 0.01, 0, 0) = (2, 0, 0).
    const positions = scaled?.positions ?? [];
    const corners = Array.from({ length: positions.length / 3 }, (_, index) => positions.slice(index * 3, index * 3 + 3).join(','));
    expect(corners).toContain('2,0,0');
    expect(corners).not.toContain('1,0,0');
    expect(solidAnalysisFieldOf({ ...done, fieldView: { quantity: 'xy', deformationScale: 1 } })?.elementValues).toEqual([0]);
  });
});
