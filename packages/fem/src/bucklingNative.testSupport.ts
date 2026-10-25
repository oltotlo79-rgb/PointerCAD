import assert from 'node:assert/strict';
import type { FemClient } from './client.js';
import type { BeamBucklingInput, BeamBucklingResult } from './bucklingModel.js';
import { bucklingFixture, eulerReference } from './buckling.testSupport.js';

/** Root supplies the existing owned real-OOFEM Worker client and persists every
 * record immediately. No mock or closed-form result enters the product path.
 * Run with the candidate source wrapper, frozen OOFEM/NumPy runtime and new
 * buckling dispatch. Each analyze call creates its own interpreter/Worker.
 */
export async function runBucklingNativeChecks(client: FemClient,
  record: (value: unknown) => Promise<void>): Promise<void> {
  const solve = async (name: string, input: BeamBucklingInput): Promise<BeamBucklingResult> => {
    const completion = await client.analyzeBuckling(input);
    await record({ name, input, completion });
    assert.equal(completion.kind, 'result', `${name}: native buckling must produce a validated result`);
    if (completion.kind !== 'result') throw new Error('No buckling result');
    assert.equal(completion.result.structuralCertification, false);
    return completion.result;
  };
  for (const pinned of [true, false]) {
    const expected = eulerReference({ pinned });
    let priorError = Number.POSITIVE_INFINITY;
    for (const segments of [8, 16, 32]) {
      const result = await solve(`${pinned ? 'pinned-pinned' : 'fixed-free'}-${segments}`, bucklingFixture({ pinned, segments }));
      const error = Math.max(...result.modes.map((mode, index) => Math.abs(mode.loadFactor / expected[index] - 1)));
      // Euler limit, independently justified by P_E/(kGA) <7e-8. Allowing
      // continuum discrepancy is based on that bound, never an observed fit.
      assert(error < 1e-4, `Independent Euler branch error ${error}`);
      assert(error < priorError, `Expected mesh convergence: ${error} >= ${priorError}`);
      priorError = error;
    }
  }
  for (const options of [
    { pinned: true, loadScale: 2 }, { pinned: true, stiffnessScale: 2 },
    { pinned: true, lengthScale: 2 }, { pinned: true, millimetres: true },
    { pinned: true, rotated: true }, { pinned: false, rotated: true },
  ]) {
    const result = await solve(JSON.stringify(options), bucklingFixture(options));
    const expected = eulerReference(options);
    result.modes.forEach((mode, index) => assert(Math.abs(mode.loadFactor / expected[index] - 1) < 1e-4));
  }
  const base = bucklingFixture();
  const negative: readonly { readonly name: string; readonly input: BeamBucklingInput; readonly error: string }[] = [
    { name: 'tension-does-not-become-compression', input: bucklingFixture({ loadScale: -1 }), error: 'buckling-no-positive-mode:' },
    { name: 'non-axial-reference-state-is-unsupported', input: { ...base,
      referenceLoads: [{ ...base.referenceLoads[0], force: [-1, 1, 0] }] }, error: 'buckling-prestress:' },
    { name: 'torsional-rigid-mechanism', input: { ...base,
      supports: [{ nodeId: 'node-0', restrained: [true, true, true, false, false, false] }] }, error: 'buckling-mechanism:' },
  ];
  for (const test of negative) {
    const completion = await client.analyzeBuckling(test.input);
    await record({ name: test.name, input: test.input, completion });
    assert.equal(completion.kind, 'failed');
    if (completion.kind !== 'failed') throw new Error('Invalid physical problem accepted');
    assert.equal(completion.failure.code, 'solver-failed');
    assert(completion.failure.message.includes(test.error), completion.failure.message);
  }
}
