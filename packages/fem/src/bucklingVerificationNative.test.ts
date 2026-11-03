import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '@pointercad/test-utils/testing/release-performance';
import { bucklingFixture, eulerReference } from './buckling.testSupport.js';
import { bucklingResultMatches } from './bucklingResults.js';
import { bucklingInputSha256 } from './bucklingTranslation.js';
import { loadPackagedRuntime, verifiedAsset, wheelLocation } from './linearStaticBenchmark.testSupport.js';
import { analyzeBeamBuckling, type PyodideRuntime } from './runtime.js';
import { compareVerification } from './verificationComparison.testSupport.js';
import { bucklingInput } from './verificationCases.testSupport.js';

describe('W71 fixed-free buckling on packaged offline OOFEM', () => {
  const originalFetch = globalThis.fetch;
  let runtime: PyodideRuntime, deniedRequests = 0;
  beforeAll(async () => {
    globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
    runtime = await loadPackagedRuntime();
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  afterAll(() => { globalThis.fetch = originalFetch; expect(deniedRequests).toBe(0); });

  it('compares the real result to fixed-free Euler and rejects stale and pinned alternatives', async () => {
    const input = bucklingFixture({ pinned: false, segments: 16 });
    const phases: string[] = [];
    const result = await analyzeBeamBuckling(runtime, input,
      { wrapper: verifiedAsset('beamAnalysis.py'), wheelLocation: wheelLocation() }, phase => { phases.push(phase); });
    expect(phases).toEqual(['loading-packages', 'solving']);
    expect(result.structuralCertification).toBe(false);
    expect(bucklingResultMatches(result, input, await bucklingInputSha256(input))).toBe(true);
    const fixedFree = eulerReference({ pinned: false });
    const pinned = eulerReference({ pinned: true });
    expect(result.modes).toHaveLength(2);
    result.modes.forEach((mode, index) => {
      expect(Math.abs(mode.loadFactor / fixedFree[index] - 1)).toBeLessThan(1e-4);
      expect(Math.abs(mode.loadFactor / pinned[index] - 1)).toBeGreaterThan(1e-4);
    });
    const caseId = 'buckling-fixed-free-first-v1';
    expect(compareVerification(caseId, { caseId, input: bucklingInput(input), value: result.modes[0].loadFactor }).passed).toBe(true);
    const stale = { ...input, geometry: { ...input.geometry, revision: input.geometry.revision + 1 } };
    expect(bucklingResultMatches(result, stale, await bucklingInputSha256(stale))).toBe(false);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
