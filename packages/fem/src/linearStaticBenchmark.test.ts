import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { cantilever } from './analysisCases.testSupport.js';
import { axialElongationM, BAR, barForceN, BEAM, cantileverTipDeflectionM, cantileverTipDeflectionWithoutShearM,
  loadPackagedRuntime, relative, tensionBar, uniaxialDisplacementMm, verifiedAsset, wheelLocation } from './linearStaticBenchmark.testSupport.js';
import { analyzeBeam, analyzeSolid, type PyodideRuntime } from './runtime.js';
import { solidResultMatches } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';

// W14: actual pinned offline Pyodide + OOFEM through the public analyzeBeam / analyzeSolid routes, compared with
// closed forms only. This is a linear-elastic oracle; it says nothing about material-grade conformity, plasticity or fatigue.
describe('W14 independent linear-static oracles on the packaged offline OOFEM', () => {
  const originalFetch = globalThis.fetch;
  let runtime: PyodideRuntime, deniedRequests = 0;
  beforeAll(async () => {
    globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
    runtime = await loadPackagedRuntime();
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  afterAll(() => { globalThis.fetch = originalFetch; expect(deniedRequests).toBe(0); });

  it('matches the Timoshenko cantilever tip deflection and axial elongation, rejecting the shear-free formula and a flipped sign', async () => {
    const programs = { wrapper: verifiedAsset('beamAnalysis.py'), wheelLocation: wheelLocation() };
    const bending = cantilever({ mode: 'y' });
    // The fixture is input only; pin that it carries the oracle's constants before trusting the comparison.
    expect(bending.units).toBe('N-m');
    expect(bending.nodes.find(node => node.id === 'tip')?.position).toEqual([BEAM.lengthM, 0, 0]);
    expect(bending.materials[0]).toMatchObject({ youngModulus: BEAM.youngPa, shearModulus: BEAM.shearPa });
    expect(bending.sections[0]).toMatchObject({ area: BEAM.areaM2, iz: BEAM.izM4, shearFactor: BEAM.shearFactor });
    expect(bending.loads[0]).toMatchObject({ nodeId: 'tip', force: [0, BEAM.forceN, 0] });
    const tip = async (document: ReturnType<typeof cantilever>): Promise<readonly number[]> => {
      const found = (await analyzeBeam(runtime, document, programs, () => undefined)).nodes.find(node => node.nodeId === 'tip');
      if (found === undefined) throw new Error('Missing tip node result');
      return found.displacementM;
    };
    const expected = cantileverTipDeflectionM(BEAM.forceN), bent = await tip(bending);
    expect(relative(bent[1], expected), 'tip deflection vs PL^3/(3EI)+PL/(kGA)').toBeLessThanOrEqual(1e-3);
    // Negative oracle 1: the shear-free formula is off by PL/(kGA) / total = 3.9e-3 and must not pass the same limit.
    expect(relative(bent[1], cantileverTipDeflectionWithoutShearM(BEAM.forceN))).toBeGreaterThan(1e-3);
    // Negative oracle 2: reversing the load reverses the deflection; the unreversed expectation must fail.
    const reversed = await tip(cantilever({ mode: 'y', forceMultiplier: -1 }));
    expect(relative(reversed[1], -expected)).toBeLessThanOrEqual(1e-3);
    expect(relative(reversed[1], expected)).toBeGreaterThan(1e-3);
    const axial = await tip(cantilever({ mode: 'axial' }));
    expect(relative(axial[0], axialElongationM(BEAM.forceN)), 'axial PL/(EA)').toBeLessThanOrEqual(1e-6);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('reproduces uniaxial tension displacement and the non-singular stress P/A on three refinements with free Poisson contraction', async () => {
    const programs = { wrapper: verifiedAsset('solidAnalysis.py'), wheelLocation: wheelLocation() };
    const area = BAR.widthMm * BAR.heightMm, force = barForceN(), stress = force / area;
    const tipMm = BAR.stressMPa * BAR.lengthMm / BAR.youngMPa;
    const cornerLateralMm = -BAR.poisson * BAR.stressMPa * BAR.widthMm / BAR.youngMPa;
    for (const level of [1, 2, 3]) {
      const input = tensionBar(level), before = structuredClone(input);
      const result = await analyzeSolid(runtime, input, programs, () => undefined);
      expect(result.elements).toHaveLength(input.elements.length);
      const support = result.reactionN.reduce((total, row) => total + row[0], 0);
      expect(relative(support, -force), `level ${level} support force vs -P`).toBeLessThanOrEqual(1e-6);
      let worst = 0;
      input.nodes.forEach((point, node) => {
        const exact = uniaxialDisplacementMm(point), got = result.displacementMm[node];
        worst = Math.max(worst, Math.hypot(got[0] - exact[0], got[1] - exact[1], got[2] - exact[2]) / tipMm);
      });
      expect(worst, `level ${level} displacement error / (sigma L / E)`).toBeLessThanOrEqual(1e-3);
      // The far corner (L, W, H) is the last node: free contraction must actually occur, not be restrained to zero.
      const corner = result.displacementMm[input.nodes.length - 1];
      expect(relative(corner[1], cornerLateralMm), `level ${level} lateral contraction`).toBeLessThanOrEqual(1e-3);
      for (const element of result.elements) {
        expect(relative(element.stressMPa[0], stress)).toBeLessThanOrEqual(0.01);
        expect(Math.max(...element.stressMPa.slice(1).map(value => Math.abs(value))) / stress).toBeLessThanOrEqual(0.01);
      }
      expect(solidResultMatches(result, input, await solidInputSha256(input))).toBe(true);
      expect(input).toEqual(before);
    }
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
