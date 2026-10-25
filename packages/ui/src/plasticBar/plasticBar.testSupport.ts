import { decodePlasticBar, plasticBarInputSha256, type PlasticBarInput, type PlasticBarResult } from '@pointercad/fem';
import type { PlasticBarEdit } from './plasticBarSession.js';

export const BENCHMARK_REFERENCE = 'Test benchmark constants, not a material specification';
/** Benchmark entered as a user would: E 200 GPa, sigma0 250 MPa, H 2000 MPa, L 1000 mm, A 100 mm², knots in mm. */
export const BENCHMARK_EDITS: readonly PlasticBarEdit[] = [
  { kind: 'value', field: 'young', source: '200 GPa' }, { kind: 'value', field: 'poisson', source: '0.3' },
  { kind: 'value', field: 'yieldStress', source: '250' }, { kind: 'value', field: 'hardening', source: '2000' },
  { kind: 'value', field: 'length', source: '1000' }, { kind: 'value', field: 'area', source: '100' },
  { kind: 'value', field: 'stepsPerSegment', source: '1' }, { kind: 'reference', source: BENCHMARK_REFERENCE },
  { kind: 'knot', index: 0, source: '2.5' }, { kind: 'knot-add' }, { kind: 'knot', index: 1, source: '0' },
  { kind: 'knot-add' }, { kind: 'knot', index: 2, source: '-2.5' }, { kind: 'knot-add' }, { kind: 'knot', index: 3, source: '0' },
];
/** Hand-derived 1D return of the benchmark (load past yield, elastic unload, reverse yield, elastic reload), stated
 * before execution. */
interface PlasticBarBenchmarkStep {
  readonly u: number;
  readonly stressPa: number;
  readonly plasticStrain: number;
}
export const BENCHMARK_STEPS: readonly PlasticBarBenchmarkStep[] = [
  { u: 2.5e-3, stressPa: 252475247.52475247, plasticStrain: 1.2376237623762376e-3 },
  { u: 0, stressPa: -247524752.47524753, plasticStrain: 1.2376237623762376e-3 },
  { u: -2.5e-3, stressPa: -257376727.77178708, plasticStrain: -1.2131163611410645e-3 },
  { u: 0, stressPa: 242623272.2282129, plasticStrain: -1.2131163611410645e-3 },
] as const;

/** Protocol-shaped runner output, not a native oracle: decodePlasticBar still applies the strict reader (within 1e-8
 * of its own reference) and binds the result to the exact input and digest. */
export async function benchmarkResult(input: PlasticBarInput): Promise<PlasticBarResult> {
  const area = input.plan.areaM2;
  const samples = BENCHMARK_STEPS.map((s, index) => ({ step: index + 1, targetDisplacementM: s.u, endDisplacementM: s.u,
    strain: s.u / input.plan.lengthM, stressPa: s.stressPa, plasticStrain: s.plasticStrain, axialForceN: s.stressPa * area }));
  const mismatch = samples.reduce((max, s) => Math.max(max, Math.abs(s.axialForceN - s.stressPa * area)), 0)
    / (input.plan.material.yieldStressPa * area);
  return decodePlasticBar({ schema: 'pointercad-oofem-plastic-bar-result/1',
    method: 'oofem-misesmat-htype0-truss1d-staticstructural/1',
    scope: 'uniaxial-small-strain-j2-linear-isotropic-hardening-displacement-control', structuralCertification: false,
    samples, yielded: samples.some(s => s.plasticStrain !== 0), maximumEquilibriumMismatch: mismatch },
  input, await plasticBarInputSha256(input));
}
