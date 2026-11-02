import { describe, expect, it } from 'vitest';
import { SOLID_FINITE_PLAN_SCHEMA } from './solidFinitePlan.js';
import { decodeSolidFinite, solidFiniteResultMatches } from './solidFiniteResults.js';
import { SOLID_FINITE_INPUT_SCHEMA, solidFiniteInputSha256, translateSolidFinite, type SolidFiniteInput } from './solidFiniteTranslation.js';

/*
 * Replies are written by hand with the field names of solidFiniteEquilibrium.py result()/advance(). The plan is one
 * tetrahedron with 9 zero displacements and an x dead load at node 1 (free DOFs: node 1 x, node 2 y, node 3 z).
 * Element values are closed forms of simple native states (independent of the decoder):
 *   step 1: F = diag(1.25, 0.875, 0.875), S = diag(160, 0, 0):  J = 1.25 x 0.875^2 = 0.95703125, P = F S = diag(200, 0, 0),
 *           tau = P F^T = diag(250, 0, 0), sigma = tau / J;
 *   step 2: simple shear F = I + 0.5 e1 (x) e2, S = diag(100, 40, 0):  J = 1, P = [[100, 20, 0], [0, 40, 0], [0, 0, 0]],
 *           tau = F S F^T = [[110, 20, 0], [20, 40, 0], [0, 0, 0]] = sigma.
 * OOFEM orders: F9 [11, 22, 33, 23, 13, 12, 32, 31, 21], S6 [11, 22, 33, 23, 13, 12].
 * Free-DOF balance (definition of the entry): step 1 is exact (scale 100); step 2 leaves 2^-20 N at node 1 x over the
 * scale 200, ratio 2^-20 / 200 < 1e-8.
 */
const L = 10;
function input(revision = 3, forces: readonly number[] = [100, 200]): SolidFiniteInput {
  return translateSolidFinite({ schema: SOLID_FINITE_INPUT_SCHEMA, source: { documentId: 'doc', revision }, plan: {
    schema: SOLID_FINITE_PLAN_SCHEMA, units: 'N-mm-MPa', nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]], elements: [[0, 1, 2, 3]],
    material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 1000 }, steps: 2,
    prescribedMm: [[0, 'x'], [0, 'y'], [0, 'z'], [1, 'y'], [1, 'z'], [2, 'x'], [2, 'z'], [3, 'x'], [3, 'y']]
      .map(([node, dof]) => ({ node, dof, valuesMm: [0, 0] })),
    forcesN: [{ node: 1, dof: 'x', valuesN: [...forces] }] } }).input;
}

interface ElementFixture { J: number; tau: number[]; P: number[]; sigma: number[]; alpha: number; plastic: unknown; dissipation: number;
  q: number; native: { F9: number[]; S6: number[]; [extra: string]: unknown }; [extra: string]: unknown }
interface RecordFixture { step: unknown; time: number; freeResidualRatio: number; forceScaleN: number; displacementMm: number[][];
  internalN: number[][]; externalN: number[][]; elements: ElementFixture[]; [extra: string]: unknown }
interface NativeFixture { schema: string; method: string; units: string; scope: string; structuralCertification: boolean;
  freeResidualBound: number; records: RecordFixture[]; refusedCommits: unknown[]; retainedNativeAnalyses: number;
  runtimeAnalysisLimit: number; [extra: string]: unknown }

const J1 = 0.95703125;
function native(): NativeFixture {
  const stretch: ElementFixture = { J: J1, tau: [250, 0, 0, 0, 0, 0, 0, 0, 0], P: [200, 0, 0, 0, 0, 0, 0, 0, 0],
    sigma: [250 / J1, 0, 0, 0, 0, 0, 0, 0, 0], alpha: 0, plastic: false, dissipation: 0, q: 250,
    native: { F9: [1.25, 0.875, 0.875, 0, 0, 0, 0, 0, 0], S6: [160, 0, 0, 0, 0, 0] } };
  const shear: ElementFixture = { J: 1, tau: [110, 20, 0, 20, 40, 0, 0, 0, 0], P: [100, 20, 0, 0, 40, 0, 0, 0, 0],
    sigma: [110, 20, 0, 20, 40, 0, 0, 0, 0], alpha: 0.001, plastic: true, dissipation: 0.25, q: 300,
    native: { F9: [1, 1, 1, 0, 0, 0.5, 0, 0, 0], S6: [100, 40, 0, 0, 0, 0] } };
  return { schema: 'pointercad-finite-j2-equilibrium/1',
    method: 'oofem-ltrspace-nlgeo1-staticstructural-nrsolver-pointercad-finite-j2/1', units: 'N-mm-MPa',
    scope: 'finite-strain-j2-linear-isotropic-hardening-tet4-internal', structuralCertification: false, freeResidualBound: 1e-8,
    records: [
      { step: 1, time: 1, freeResidualRatio: 0, forceScaleN: 100,
        displacementMm: [[0, 0, 0], [0.005, 0, 0], [0, -0.0015, 0], [0, 0, -0.0015]],
        internalN: [[-60, 10, 0], [100, -10, 0], [-20, 0, 0], [-20, 0, 0]],
        externalN: [[0, 0, 0], [100, 0, 0], [0, 0, 0], [0, 0, 0]], elements: [stretch] },
      { step: 2, time: 2, freeResidualRatio: 2 ** -20 / 200, forceScaleN: 200,
        displacementMm: [[0, 0, 0], [0.01, 0, 0], [0, -0.003, 0], [0, 0, -0.003]],
        internalN: [[-120, 20, 0], [200 - 2 ** -20, -20, 0], [-40, 0, 0], [-40, 0, 0]],
        externalN: [[0, 0, 0], [200, 0, 0], [0, 0, 0], [0, 0, 0]], elements: [shear] }],
    refusedCommits: [], retainedNativeAnalyses: 1, runtimeAnalysisLimit: 8 };
}
function variant(change: (value: NativeFixture) => void): NativeFixture {
  const value = structuredClone(native());
  change(value);
  return value;
}
/** Python json.dumps separators (', ' and ': '); the decoder sees the parsed value. */
const pythonText = (value: unknown): string => JSON.stringify(value).replaceAll(',', ', ').replaceAll(':', ': ');

describe('finite equilibrium result decoder', () => {
  it('decodes a complete reply bound to the copied input and its digest, keeping native F/S and spatial stresses apart', async () => {
    const value = input(), hash = await solidFiniteInputSha256(value);
    const result = await decodeSolidFinite(JSON.parse(pythonText(native())), value, hash);
    expect(result.input).toEqual(value);
    expect(result.inputSha256).toBe(hash);
    expect(result).toMatchObject({ schema: 'pointercad-finite-j2-equilibrium/1', structuralCertification: false, freeResidualBound: 1e-8,
      refusedCommits: [], retainedNativeAnalyses: 1, runtimeAnalysisLimit: 8 });
    expect(result.records.map(record => [record.step, record.time, record.freeResidualRatio, record.forceScaleN]))
      .toEqual([[1, 1, 0, 100], [2, 2, 2 ** -20 / 200, 200]]);
    const [stretch, shear] = result.records.map(record => record.elements[0]);
    expect(stretch.native).toEqual({ F9: [1.25, 0.875, 0.875, 0, 0, 0, 0, 0, 0], S6: [160, 0, 0, 0, 0, 0] });
    expect([stretch.J, stretch.P[0], stretch.tau[0], stretch.sigma[0]]).toEqual([J1, 200, 250, 250 / J1]);
    expect([shear.P, shear.tau]).toEqual([[100, 20, 0, 0, 40, 0, 0, 0, 0], [110, 20, 0, 20, 40, 0, 0, 0, 0]]);
    expect([stretch.plastic, shear.plastic, shear.alpha]).toEqual([false, true, 0.001]);
    expect(Object.isFrozen(result) && Object.isFrozen(result.records[1].elements[0].native.F9) && Object.isFrozen(result.records[0].internalN[1]))
      .toBe(true);
    expect(solidFiniteResultMatches(result, value, hash)).toBe(true);
  });

  it.each([
    ['another result schema', (n: NativeFixture) => { n.schema = 'pointercad-solid-plastic-native/1'; }, 'unsupported result schema'],
    ['another method', (n: NativeFixture) => { n.method = 'oofem-ltrspace-small-strain/1'; }, 'unexpected method'],
    ['other units', (n: NativeFixture) => { n.units = 'N-m-Pa'; }, 'units must be N-mm-MPa'],
    ['another scope', (n: NativeFixture) => { n.scope = 'finite-strain-j2-certified'; }, 'unexpected scope'],
    ['a structural certification claim', (n: NativeFixture) => { n.structuralCertification = true; }, 'structuralCertification must be false'],
    ['a looser residual bound', (n: NativeFixture) => { n.freeResidualBound = 1e-6; }, 'unexpected free residual bound'],
    ['an extra result field', (n: NativeFixture) => { n.capability = 'commercial'; }, 'result must have exactly the fields'],
    ['a refused commit', (n: NativeFixture) => { n.refusedCommits = [{ step: 2, token: '2:2', reason: 'x' }]; }, 'no refused commit'],
    ['no retained analysis', (n: NativeFixture) => { n.retainedNativeAnalyses = 0; }, 'retainedNativeAnalyses must be an integer from 1 to 8'],
    ['more retained analyses than the limit', (n: NativeFixture) => { n.retainedNativeAnalyses = 9; }, 'retainedNativeAnalyses'],
    ['another analysis limit', (n: NativeFixture) => { n.runtimeAnalysisLimit = 16; }, 'unexpected runtime analysis limit'],
    ['a partial record list', (n: NativeFixture) => { n.records.pop(); }, 'records must hold all 2 accepted steps'],
    ['an extra record', (n: NativeFixture) => { n.records.push(structuredClone(n.records[1])); }, 'records must hold all 2'],
    ['a repeated step number', (n: NativeFixture) => { n.records[1].step = 1; }, 'records[1].step must be 2'],
    ['a string step number', (n: NativeFixture) => { n.records[0].step = '1'; }, 'records[0].step must be 1'],
    ['a non-increasing time', (n: NativeFixture) => { n.records[1].time = 1; }, 'records[1].time must increase'],
    ['time 0 (the undeformed state)', (n: NativeFixture) => { n.records[0].time = 0; }, 'records[0].time must increase'],
    ['an extra record field', (n: NativeFixture) => { n.records[0].converged = true; }, 'records[0] must have exactly the fields'],
    ['a missing node row', (n: NativeFixture) => { n.records[0].internalN.pop(); }, 'records[0].internalN must have one entry per node (4)'],
    ['a 2-vector', (n: NativeFixture) => { n.records[0].displacementMm[3] = [0, 0]; }, 'records[0].displacementMm[3] must have 3 entries'],
    ['a NaN force', (n: NativeFixture) => { n.records[0].internalN[0][1] = Number.NaN; }, 'records[0].internalN[0][1] must be a finite number'],
    ['an infinite displacement', (n: NativeFixture) => { n.records[1].displacementMm[1][0] = Infinity; }, 'must be a finite number'],
    ['an inverted displacement with unchanged positive native F and J', (n: NativeFixture) => {
      n.records[0].displacementMm[1][0] = -2 * L;
    }, 'displacementMm inverts or collapses element 0'],
    ['a collapsed displacement with unchanged positive native F and J', (n: NativeFixture) => {
      n.records[0].displacementMm[1][0] = -L;
    }, 'displacementMm inverts or collapses element 0'],
    ['a prescribed displacement not reproduced', (n: NativeFixture) => { n.records[0].displacementMm[0][0] = 1e-9; },
      'records[0].displacementMm does not reproduce the prescribed node 0 direction x'],
    ['another dead load', (n: NativeFixture) => { n.records[1].externalN[1][0] = 200.001; }, 'externalN of node 1 direction x is not the planned'],
    ['a force on an unloaded DOF', (n: NativeFixture) => { n.records[0].externalN[2][1] = 1e-300; }, 'externalN of node 2 direction y'],
    ['an understated residual', (n: NativeFixture) => { n.records[1].freeResidualRatio = 0; }, 'records[1] free-DOF residual or force scale differs'],
    ['another force scale', (n: NativeFixture) => { n.records[1].forceScaleN = 199; }, 'records[1] free-DOF residual or force scale differs'],
    ['a residual above 1e-8 even if self-consistent', (n: NativeFixture) => {
      n.records[1].internalN[1][0] = 199; n.records[1].freeResidualRatio = 1 / 200;
    }, 'records[1].freeResidualRatio must be within 1e-8'],
    ['a missing element', (n: NativeFixture) => { n.records[1].elements = []; }, 'records[1].elements must have one entry per element (1)'],
    ['an extra element field', (n: NativeFixture) => { n.records[0].elements[0].vonMises = 250; }, 'must have exactly the fields'],
    ['an extra native field', (n: NativeFixture) => { n.records[0].elements[0].native.E6 = [0, 0, 0, 0, 0, 0]; }, '.native must have exactly'],
    ['a short native F', (n: NativeFixture) => { n.records[0].elements[0].native.F9.pop(); }, 'native.F9 must have 9 entries'],
    ['J that is not det F', (n: NativeFixture) => { n.records[0].elements[0].J = 0.957; }, 'records[0].elements[0].J differs from det F'],
    ['an inverted native F', (n: NativeFixture) => {
      const element = n.records[0].elements[0];
      element.native.F9[0] = -1.25; element.J = -J1;
    }, 'records[0].elements[0].J must be positive'],
    ['a perturbed first Piola-Kirchhoff stress', (n: NativeFixture) => { n.records[1].elements[0].P[1] = 20.000000000000004; },
      'records[1].elements[0].P differs from the value formed from the native F and S'],
    ['a Kirchhoff stress of the transposed F (F21 for F12)', (n: NativeFixture) => {
      n.records[1].elements[0].native.F9 = [1, 1, 1, 0, 0, 0, 0, 0, 0.5];
    }, 'records[1].elements[0].P differs'],
    ['a perturbed Kirchhoff stress', (n: NativeFixture) => { n.records[1].elements[0].tau[3] = 21; }, 'elements[0].tau differs'],
    ['Cauchy stress taken as Kirchhoff stress', (n: NativeFixture) => { n.records[0].elements[0].sigma = [250, 0, 0, 0, 0, 0, 0, 0, 0]; },
      'records[0].elements[0].sigma differs'],
    ['a non-boolean plastic flag', (n: NativeFixture) => { n.records[1].elements[0].plastic = 1; }, 'plastic must be a boolean'],
    ['a negative equivalent stress', (n: NativeFixture) => { n.records[1].elements[0].q = -1; }, 'q must not be negative'],
    ['a decreasing alpha', (n: NativeFixture) => {
      Object.assign(n.records[0].elements[0], { alpha: 0.002, plastic: true, dissipation: 0.5 });
    }, 'records[1].elements[0].alpha must not decrease'],
    ['an elastic step that changes alpha', (n: NativeFixture) => { n.records[1].elements[0].plastic = false; },
      'records[1].elements[0] is elastic but changes alpha or dissipates'],
    ['an elastic step that dissipates', (n: NativeFixture) => { n.records[0].elements[0].dissipation = 1e-12; }, 'is elastic but'],
  ])('refuses %s', async (_name, change, message) => {
    const value = input(), hash = await solidFiniteInputSha256(value);
    await expect(decodeSolidFinite(variant(change), value, hash)).rejects.toThrow(message);
  });

  it('uses the running accepted reference of earlier steps in the force scale (unloading below the earlier load)', async () => {
    const value = input(3, [100, 10]), hash = await solidFiniteInputSha256(value);
    const unload = (scale: number): NativeFixture => variant(n => {
      Object.assign(n.records[1], { externalN: [[0, 0, 0], [10, 0, 0], [0, 0, 0], [0, 0, 0]],
        internalN: [[-6, 1, 0], [10 - 2 ** -30, -1, 0], [-2, 0, 0], [-2, 0, 0]], forceScaleN: scale, freeResidualRatio: 2 ** -30 / scale });
    });
    // Step 1 accepted the reference max(load 100, reactions 60, 20, 20, 10) = 100, which stays in the step 2 scale.
    expect((await decodeSolidFinite(unload(100), value, hash)).records[1].forceScaleN).toBe(100);
    await expect(decodeSolidFinite(unload(10), value, hash)).rejects.toThrow('records[1] free-DOF residual or force scale differs');
  });

  it('refuses a stale or mutated binding: another input digest, a changed revision, a malformed digest, a reply for another plan', async () => {
    const value = input(), hash = await solidFiniteInputSha256(value);
    await expect(decodeSolidFinite(native(), input(4), hash)).rejects.toThrow('the input digest does not match the input');
    await expect(decodeSolidFinite(native(), value, await solidFiniteInputSha256(input(4)))).rejects.toThrow('does not match');
    await expect(decodeSolidFinite(native(), value, hash.toUpperCase())).rejects.toThrow('invalid input digest');
    await expect(decodeSolidFinite(native(), value, '')).rejects.toThrow('invalid input digest');
    const other = input(3, [150, 300]);
    await expect(decodeSolidFinite(native(), other, await solidFiniteInputSha256(other)))
      .rejects.toThrow('records[0].externalN of node 1 direction x is not the planned dead load');
    const result = await decodeSolidFinite(native(), value, hash);
    expect(solidFiniteResultMatches(result, input(4), hash)).toBe(false);
    expect(solidFiniteResultMatches(result, value, await solidFiniteInputSha256(input(4)))).toBe(false);
    expect(solidFiniteResultMatches(result, { ...value, extra: 1 }, hash)).toBe(false);
  });

  it('refuses non-object replies without a fallback', async () => {
    const value = input(), hash = await solidFiniteInputSha256(value);
    for (const raw of [null, 'result', [native()], 42]) {
      await expect(decodeSolidFinite(raw, value, hash)).rejects.toThrow('finite-equilibrium-result: result must be an object');
    }
  });
});
