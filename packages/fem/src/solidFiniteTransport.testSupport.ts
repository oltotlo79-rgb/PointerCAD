import { SOLID_FINITE_PLAN_SCHEMA } from './solidFinitePlan.js';
import { SOLID_FINITE_INPUT_SCHEMA, translateSolidFinite, type SolidFiniteInput } from './solidFiniteTranslation.js';
// Synthetic transport fixture copied exactly from W34 runtime contract; not a new physical oracle.
const L = 10, J1 = 0.95703125;
export function finiteInput(documentId = 'doc', revision = 3): SolidFiniteInput {
  return translateSolidFinite({ schema: SOLID_FINITE_INPUT_SCHEMA, source: { documentId, revision }, plan: {
    schema: SOLID_FINITE_PLAN_SCHEMA, units: 'N-mm-MPa', nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]], elements: [[0, 1, 2, 3]],
    material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 1000 }, steps: 1,
    prescribedMm: [[0, 'x'], [0, 'y'], [0, 'z'], [1, 'y'], [1, 'z'], [2, 'x'], [2, 'z'], [3, 'x'], [3, 'y']]
      .map(([node, dof]) => ({ node, dof, valuesMm: [0] })),
    forcesN: [{ node: 1, dof: 'x', valuesN: [100] }] } }).input;
}
export function finiteNative(retained = 1): Record<string, unknown> {
  return { schema: 'pointercad-finite-j2-equilibrium/1',
    method: 'oofem-ltrspace-nlgeo1-staticstructural-nrsolver-pointercad-finite-j2/1', units: 'N-mm-MPa',
    scope: 'finite-strain-j2-linear-isotropic-hardening-tet4-internal', structuralCertification: false, freeResidualBound: 1e-8,
    records: [{ step: 1, time: 1, freeResidualRatio: 0, forceScaleN: 100,
      displacementMm: [[0, 0, 0], [0.005, 0, 0], [0, -0.0015, 0], [0, 0, -0.0015]],
      internalN: [[-60, 10, 0], [100, -10, 0], [-20, 0, 0], [-20, 0, 0]], externalN: [[0, 0, 0], [100, 0, 0], [0, 0, 0], [0, 0, 0]],
      elements: [{ J: J1, tau: [250, 0, 0, 0, 0, 0, 0, 0, 0], P: [200, 0, 0, 0, 0, 0, 0, 0, 0], sigma: [250 / J1, 0, 0, 0, 0, 0, 0, 0, 0],
        alpha: 0, plastic: false, dissipation: 0, q: 250, native: { F9: [1.25, 0.875, 0.875, 0, 0, 0, 0, 0, 0], S6: [160, 0, 0, 0, 0, 0] } }] }],
    refusedCommits: [], retainedNativeAnalyses: retained, runtimeAnalysisLimit: 8 };
}
