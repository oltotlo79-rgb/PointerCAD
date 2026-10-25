import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { beamImpactResultMatches } from './beamImpactBinding.js';
import { impactElementEndForces } from './beamImpactInterior.js';
import type { BeamImpactInput } from './beamImpactModel.js';
import { decodeBeamImpact, impactOutputSteps } from './beamImpactResults.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';

// task184: the ACTUAL native run_beam_impact reply with the task183 mesh fields, checked in the pinned Pyodide against
// an independent closed-form Timoshenko element (beamImpactNativeInterior.test.py), then decoded here by the product
// decoder; impactElementEndForces (the function under test) must reproduce the Python closed-form oracle. The input
// numbers below are the only source of the expectations.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('native interior record');
  return value;
}
const evidence = { kind: 'user-supplied', reference: 'Explicit oblique subdivided cantilever constants',
  condition: 'Isotropic elastic constants for a beam-formula check; no capacity or general impact claim' } as const;
// Member from (0,0,0) to (1.2,1.6,0), L = 2 m, x = (0.6,0.8,0), y = hint (exactly perpendicular), z = (0.64,-0.48,0.6).
const BENCH = { youngPa: 210e9, shearPa: 80e9, densityKgM3: 7850, areaM2: 6e-4, iyM4: 2e-8, izM4: 8e-8, torsionM4: 3e-8,
  shearFactor: 5 / 6, startM: [0, 0, 0], endM: [1.2, 1.6, 0], localYHint: [-0.48, 0.36, 0.8], segments: 4,
  // 0.01 m/s along local y plus 0.002 m/s along local x: bending, shear and axial response.
  tipVelocityMPerS: [-0.0036, 0.0052, 0.008] } as const;
const history = { timeStepS: 1.5e-4, stepCount: 40, outputEvery: 4 } as const;
function interiorInput(): BeamImpactInput {
  return {
    schema: 'pointercad-beam-impact/1',
    geometry: {
      schema: 'pointercad-beam/2', id: 'native-interior-impact', revision: 1,
      source: { documentId: 'native-interior-benchmark', documentRevision: 1, geometryRevision: 'explicit-two-metre-member' },
      units: 'N-m', modal: { modeCount: 1, segmentsPerMember: BENCH.segments },
      nodes: [{ id: 'interior-1', position: [...BENCH.startM] }, { id: 'interior-2', position: [...BENCH.endM] }],
      members: [{ id: 'interior-member', componentId: 'interior-component', occurrencePath: ['interior-component'],
        startNodeId: 'interior-1', endNodeId: 'interior-2', materialId: 'steel', sectionId: 'unequal-section',
        localYHint: [...BENCH.localYHint] }],
      materials: [{ id: 'steel', youngModulus: BENCH.youngPa, shearModulus: BENCH.shearPa, densityKgM3: BENCH.densityKgM3,
        source: evidence }],
      sections: [{ id: 'unequal-section', area: BENCH.areaM2, iy: BENCH.iyM4, iz: BENCH.izM4, torsionConstant: BENCH.torsionM4,
        shearFactor: BENCH.shearFactor, source: evidence }],
      constraints: [], loads: [],
    },
    supports: [{ nodeId: 'interior-1', restrained: [true, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'interior-2', velocityMPerS: [...BENCH.tipVelocityMPerS] }],
    // A plane facing local z, 1 mm away: the motion in the local x-y plane never reaches it.
    contacts: [{ nodeId: 'interior-2', directionUnit: [0.64, -0.48, 0.6], gapM: 1e-3 }],
    contactStiffnessNPerM: 21e6,
    history: { ...history },
  };
}

describe('actual native run_beam_impact mesh fields against a closed-form Timoshenko oracle (separate pinned runtime)', () => {
  it('decodes the actual reply and recovers the element end forces of the closed-form oracle', async () => {
    const source = interiorInput();
    const { plan } = translateBeamImpact(source);
    const samples = impactOutputSteps(history.stepCount, history.outputEvery).length;
    // 10 fixed checks, 2 per element (identity and block) and 2 original-node rows per sample.
    const expectedChecks = 10 + 2 * BENCH.segments + 2 * samples;
    const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('./beamImpactNativeInterior.harness.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 55_000, maxBuffer: 64 * 1024 * 1024,
      input: JSON.stringify({ plans: { interior: plan }, constants: BENCH, expectedChecks }),
    });
    const reply = record(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
    expect(reply.report).toEqual([`beam-impact-native-interior: ${expectedChecks} independent checks passed`]);
    const hash = await impactInputSha256(source);
    const result = decodeBeamImpact(reply.raw, source, hash);
    expect(beamImpactResultMatches(result, source, hash)).toBe(true);
    expect([result.meshNodes, result.meshElements]).toEqual([BENCH.segments + 1, BENCH.segments]);
    if (result.interior === undefined) throw new Error('the actual reply must carry the mesh fields');
    expect(result.interior.elements.map(element => [element.memberId, element.segment]))
      .toEqual([0, 1, 2, 3].map(segment => ['interior-member', segment]));
    const oracle = reply.oracle;
    if (!Array.isArray(oracle) || oracle.length !== result.samples.length) throw new Error('oracle per emitted sample');
    const forces = impactElementEndForces(result.interior);
    const peak = Math.max(...oracle.flatMap((rows: unknown) => (rows as { start: number[]; end: number[] }[])
      .flatMap(row => [...row.start, ...row.end].map(Math.abs))));
    expect(peak).toBeGreaterThan(0);
    forces.forEach((element, index) => {
      // Values exist only at the emitted samples.
      expect([element.start.length, element.end.length]).toEqual([result.samples.length, result.samples.length]);
      element.start.forEach((values, sample) => {
        const expected = (oracle[sample] as { start: number[]; end: number[] }[])[index];
        values.forEach((value, axis) => expect(Math.abs(value - expected.start[axis])).toBeLessThanOrEqual(1e-9 * peak));
        element.end[sample].forEach((value, axis) => expect(Math.abs(value - expected.end[axis])).toBeLessThanOrEqual(1e-9 * peak));
      });
    });
    // Rest at time 0: no element force.
    forces.forEach(element => [...element.start[0], ...element.end[0]].forEach(value => expect(Math.abs(value)).toBe(0)));
  });
});
