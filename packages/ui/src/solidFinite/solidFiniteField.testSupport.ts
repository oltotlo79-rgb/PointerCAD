import { solidFiniteInputSha256, translateSolidFinite, type CadSolidFiniteOutcome,
  type SolidFiniteElementRecord, type SolidFiniteStepRecord } from '@pointercad/fem';

type FiniteOutcome = Extract<CadSolidFiniteOutcome, { kind: 'result' }>;
type V3 = readonly [number, number, number];
export const FIELD_NODES: readonly V3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [2 / 3, 2 / 3, 2 / 3]];
const TETS = [[0, 1, 2, 3], [4, 1, 3, 2]] as const;
export const FIELD_DISPLACEMENTS: readonly V3[] = [[0, 0, 0], [0.01, 0, 0], [0, -0.02, 0], [0, 0, 0.03], [0.004, 0.005, 0.006]];
export const FIELD_SIGMA = [[100, 5, -4, 5, -20, 3, -4, 3, 10], [-40, 0, 0, 0, 0, 20, 0, 20, 0]] as const;

function point(sigma: readonly number[]): SolidFiniteElementRecord {
  // Synthetic display matrices, not a converged solver oracle. Distinct tau and sigma catch the wrong tensor choice.
  return { sigma, J: 2, tau: sigma.map(value => 2 * value), P: [...sigma], alpha: 0.01, plastic: true,
    dissipation: 1, q: 300, native: { F9: [2, 1, 1, 0, 0, 0, 0, 0, 0], S6: [0, 0, 0, 0, 0, 0] } };
}
/** Real finite input/result shapes on two positive tetrahedra; no fake linear result or native Worker execution. */
export async function finiteFieldOutcome(): Promise<FiniteOutcome> {
  const source = { documentId: 'saved-part', revision: 7 };
  const { input } = translateSolidFinite({ schema: 'pointercad-finite-j2-equilibrium-input/1', source,
    plan: { schema: 'pointercad-finite-j2-equilibrium-plan/1', units: 'N-mm-MPa', nodes: FIELD_NODES, elements: TETS,
      material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 1000 }, steps: 2,
      prescribedMm: (['x', 'y', 'z'] as const).map(dof => ({ node: 0, dof, valuesMm: [0, 0] })),
      forcesN: [{ node: 1, dof: 'x', valuesN: [1, 0] }], referenceForceN: 1 } });
  const zero = (): V3[] => FIELD_NODES.map(() => [0, 0, 0]);
  const first: SolidFiniteStepRecord = { step: 1, time: 1, freeResidualRatio: 0, forceScaleN: 1,
    displacementMm: FIELD_DISPLACEMENTS, internalN: zero(), externalN: zero(), elements: FIELD_SIGMA.map(point) };
  const second: SolidFiniteStepRecord = { ...first, step: 2, time: 2,
    displacementMm: FIELD_DISPLACEMENTS.map(move => move.map(value => value * 2)),
    elements: [point([0, 10, 0, 10, 0, 0, 0, 0, 0]), point([0, 0, 0, 0, 0, 0, 0, 0, 0])] };
  const mesh: FiniteOutcome['mesh'] = { kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1',
    source: { ...source, featureId: 'box', bodyKey: 'box:7' }, units: 'mm', coordinates: FIELD_NODES.flat(),
    triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 4, 3, 1, 4, 1, 2, 4, 2, 3], tags: [0, 1, 2, 3, 4, 5], tagCount: 6 },
    inputSha256: 'synthetic-display-mesh', coordinates: FIELD_NODES.flat(), tetrahedra: TETS.flat(),
    boundaryTriangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 4, 3, 1, 4, 1, 2, 4, 2, 3], boundaryTags: [0, 1, 2, 3, 4, 5],
    volumeMm3: 1 / 3, minTetVolumeMm3: 1 / 6 };
  return { kind: 'result', input, mesh, materialReference: 'Independent synthetic display fixture; not a material grade',
    prepared: { input: { schema: 'pointercad-solid-tet4/1', units: 'N-mm-MPa',
      source: { ...source, meshKey: mesh.inputSha256 }, nodes: FIELD_NODES,
      elements: TETS.map(nodes => ({ nodes, materialId: 'material' })), materials: [{ id: 'material', youngMPa: 200000, poisson: 0.3 }],
      constraints: [{ node: 0, fixed: [true, true, true] }], nodalLoads: [{ node: 1, forceN: [1, 0, 0] }], surfaceLoads: [],
      numericBudgetBytes: 1024 * 1024 }, loadedAreaMm2: 1, totalForceN: [1, 0, 0] },
    result: { input, inputSha256: await solidFiniteInputSha256(input), schema: 'pointercad-finite-j2-equilibrium/1',
      method: 'oofem-ltrspace-nlgeo1-staticstructural-nrsolver-pointercad-finite-j2/1', units: 'N-mm-MPa',
      scope: 'finite-strain-j2-linear-isotropic-hardening-tet4-internal', structuralCertification: false,
      freeResidualBound: 1e-8, records: [first, second], refusedCommits: [], retainedNativeAnalyses: 1, runtimeAnalysisLimit: 8 } };
}
