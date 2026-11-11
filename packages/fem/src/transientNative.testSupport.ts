import assert from 'node:assert/strict';
import type { Vector3 } from './analysisModel.js';
import type { FemClient } from './client.js';
import { rotateModalVector } from './modal.testSupport.js';
import type { BeamTransientInput, BeamTransientResult, TransientNodeResponse } from './transientModel.js';
import { AXIAL_FORCE_N, AXIAL_OSCILLATOR, TORSION_MOMENT_NM, TORSION_OSCILLATOR, axialOscillator, axialTorsionOscillator,
  cantileverPulse, continuousAxialStep, exactDiscreteAxial, exactDiscreteOscillator, transientHistory } from './transient.testSupport.js';

/** Root supplies the existing owned real-OOFEM Worker client (candidate wrapper, frozen
 * OOFEM/NumPy runtime, new transient dispatch) and persists every record immediately.
 *
 * Tolerances fixed before execution:
 * - DISCRETE 1e-9 x (F/k, omega F/k, F/m): exact discrete Newmark identity, so only rounding
 *   remains (<1e-12 expected for one DOF and <=400 steps); a lumped rho*A*L/2 mass, a wrong
 *   gamma/beta or a missing initial acceleration each differ by >=1e-3 of these scales.
 * - Continuous step error: rigorous bound (F/k) * omega * t * (omega dt)^2 / 12 from the
 *   alternating series of 2 atan(x/2) and |cos a - cos b| <= |a - b|; halving dt must reduce
 *   the maximum error by more than 3.5 (second order -> 4; first order would give 2).
 * - FRAME 1e-8 of each quantity's peak: rotated and millimetre inputs are the same physical
 *   problem, differing only by rounding of the exact orthogonal map / unit conversion.
 * - Zero load: every returned component exactly 0.
 * - Peaks: largest single-time node magnitude over all integration steps. Exact oscillator peaks within the
 *   DISCRETE bound even between returned samples; sampled single-time maximum within 1e-12 relative (only
 *   numpy norm vs Math.hypot rounding); identical value/time/node when steps are not returned; rotated frame
 *   within FRAME. The fixtures assert they discriminate (a norm of mixed-time maxima exceeds it by >1e-6).
 */
const DISCRETE = 1e-9;
const FRAME = 1e-8;
const fields = ['displacementM', 'rotationRad', 'velocityMPerS', 'angularVelocityRadPerS',
  'accelerationMPerS2', 'angularAccelerationRadPerS2'] as const;

function peak(result: BeamTransientResult, field: typeof fields[number]): number {
  return Math.max(...result.samples.flatMap(sample => sample.nodes.map(node => Math.hypot(...node[field]))));
}

export async function runTransientNativeChecks(client: FemClient,
  record: (value: unknown) => Promise<void>): Promise<void> {
  const solve = async (name: string, input: BeamTransientInput): Promise<BeamTransientResult> => {
    const completion = await client.analyzeTransient(input);
    await record({ name, input, completion });
    assert.equal(completion.kind, 'result', `${name}: native transient must produce a validated result`);
    if (completion.kind !== 'result') throw new Error('No transient result');
    assert.equal(completion.result.structuralCertification, false);
    assert.equal(completion.result.nativeTransientSolver, false);
    assert(completion.result.maximumEquilibriumResidual <= 1e-8 && completion.result.maximumEnergyBalanceError <= 1e-8);
    return completion.result;
  };
  const { stiffness, mass, omega, period } = AXIAL_OSCILLATOR;
  const scales = [AXIAL_FORCE_N / stiffness, omega * AXIAL_FORCE_N / stiffness, AXIAL_FORCE_N / mass];
  const axial = async (name: string, history: ReturnType<typeof transientHistory>, maximumFactor = 1,
    millimetres = false): Promise<BeamTransientResult> => {
    const result = await solve(name, axialOscillator(history, { millimetres }));
    result.samples.forEach((sample, index) => {
      const step = Math.min(index * history.outputEvery, history.stepCount);
      const tip = sample.nodes[1];
      const expected = exactDiscreteAxial(history, step);
      const actual = [tip.displacementM[0], tip.velocityMPerS[0], tip.accelerationMPerS2[0]];
      actual.forEach((value, axis) => assert(Math.abs(value - expected[axis]) <= DISCRETE * scales[axis] * maximumFactor,
        `${name} step ${step} quantity ${axis}: ${value} vs ${expected[axis]}`));
      for (const field of fields) {
        const vector = tip[field];
        const others = field === 'displacementM' || field === 'velocityMPerS' || field === 'accelerationMPerS2'
          ? [vector[1], vector[2]] : [...vector];
        assert(others.every(value => value === 0), `${name}: restrained component moved (${field})`);
      }
      assert(sample.nodes[0][fields[0]].every(value => value === 0), `${name}: the clamped node moved`);
    });
    return result;
  };

  // Step, ramp-and-hold and triangular pulse: exact discrete Newmark responses.
  const dt = period / 40;
  await axial('step', transientHistory(dt, 80, [[0, 1], [80, 1]]));
  await axial('ramp-hold', transientHistory(dt, 80, [[0, 0], [20, 1], [80, 1]]));
  await axial('triangle', transientHistory(dt, 80, [[0, 0], [10, 2], [20, 0], [80, 0]]), 2);
  await axial('step-every-4', transientHistory(dt, 80, [[0, 1], [80, 1]], 4));
  await axial('step-millimetres', transientHistory(dt, 80, [[0, 1], [80, 1]]), 1, true);

  // Time-step convergence of the step response toward the continuous solution over one period.
  const errors: number[] = [];
  for (const steps of [20, 40, 80]) {
    const result = await axial(`convergence-${steps}`, transientHistory(period / steps, steps, [[0, 1], [steps, 1]]));
    const error = Math.max(...result.samples.map(sample => Math.abs(sample.nodes[1].displacementM[0]
      - continuousAxialStep(sample.timeS))));
    const h = period / steps;
    const bound = AXIAL_FORCE_N / stiffness * omega * period * (omega * h) ** 2 / 12;
    assert(error <= bound * (1 + 1e-6), `convergence-${steps}: ${error} exceeds the analytic bound ${bound}`);
    errors.push(error);
  }
  assert(errors[0] / errors[1] > 3.5 && errors[1] / errors[2] > 3.5, `Not second order: ${errors.join(', ')}`);

  // Zero load: all-zero factors give an exactly zero response.
  const zero = await solve('zero-load', cantileverPulse(transientHistory(1e-4, 20, [[0, 0], [20, 0]])));
  assert.equal(zero.peakDisplacementM, 0);
  assert.equal(zero.peakRotationRad, 0);
  assert(zero.samples.every(sample => sample.nodes.every(node => fields.every(field => node[field].every(value => value === 0)))));

  // Rotated frame and millimetre invariance of a multi-DOF cantilever pulse.
  const pulse = transientHistory(5e-5, 60, [[0, 0], [10, 1], [30, 0], [60, 0]], 2);
  const base = await solve('cantilever', cantileverPulse(pulse));
  assert(base.peakDisplacementM > 0 && base.peakRotationRad > 0);
  const compare = (name: string, other: BeamTransientResult, map: (value: Vector3) => Vector3): void => {
    assert.equal(other.samples.length, base.samples.length);
    for (const field of fields) {
      const tolerance = FRAME * peak(base, field);
      other.samples.forEach((sample, index) => {
        assert.equal(sample.timeS, base.samples[index].timeS);
        sample.nodes.forEach((node: TransientNodeResponse, nodeIndex) => {
          const expected = map(base.samples[index].nodes[nodeIndex][field]);
          node[field].forEach((value, axis) => assert(Math.abs(value - expected[axis]) <= tolerance,
            `${name} ${field} t=${sample.timeS}: ${value} vs ${expected[axis]}`));
        });
      });
    }
  };
  compare('rotated', await solve('cantilever-rotated', cantileverPulse(pulse, { rotated: true })), rotateModalVector);
  compare('millimetres', await solve('cantilever-millimetres', cantileverPulse(pulse, { millimetres: true })), value => value);

  // Peaks include unsampled steps: exact axial and torsional oscillators, output every 7th step. Both exact
  // maxima (near steps 20 and 46) fall between returned samples, asserted below so the case discriminates.
  const sparseHistory = transientHistory(dt, 70, [[0, 1], [70, 1]], 7);
  const pair = await solve('peak-axial-torsion-every-7', axialTorsionOscillator(sparseHistory));
  const allSteps = Array.from({ length: 71 }, (_, step) => step);
  for (const [name, oscillator, amplitude, peak, time, node, axis] of [
    ['displacement', AXIAL_OSCILLATOR, AXIAL_FORCE_N, pair.peakDisplacementM, pair.peakDisplacementTimeS,
      pair.peakDisplacementSolverNode, 'displacementM'],
    ['rotation', TORSION_OSCILLATOR, TORSION_MOMENT_NM, pair.peakRotationRad, pair.peakRotationTimeS,
      pair.peakRotationSolverNode, 'rotationRad'],
  ] as const) {
    const at = (step: number): number => Math.abs(exactDiscreteOscillator(sparseHistory, step, oscillator, amplitude)[0]);
    const scale = DISCRETE * amplitude / oscillator.stiffness;
    const expected = Math.max(...allSteps.map(at));
    assert(expected > Math.max(...allSteps.filter(step => step % 7 === 0).map(at)) + 1e3 * scale,
      `${name}: fixture peak must lie between samples`);
    assert(Math.abs(peak - expected) <= scale, `${name} peak ${peak} vs exact ${expected}`);
    assert(Math.abs(at(Math.round(time / dt)) - peak) <= scale, `${name} peak time ${time}`);
    assert.equal(node, 2);
    pair.samples.forEach((sample, index) => {
      const step = Math.min(index * 7, 70);
      const value = sample.nodes[1][axis][0];
      const exact = exactDiscreteOscillator(sparseHistory, step, oscillator, amplitude)[0];
      assert(Math.abs(value - exact) <= scale, `${name} sample step ${step}: ${value} vs ${exact}`);
    });
  }

  // Different-time orthogonal components: a one-segment cantilever (every mesh node is returned) whose y/z
  // bending (Iz = 2 Iy) and torsion oscillate at different frequencies after a short pulse. The reported peak
  // must be the largest single-time node magnitude, identical when steps are not returned, and frame invariant.
  const turning = transientHistory(2e-3, 70, [[0, 0], [5, 1], [15, 0], [70, 0]]);
  const everyStep = await solve('peak-turning-every-1', cantileverPulse(turning, { segments: 1 }));
  const everySeventh = await solve('peak-turning-every-7', cantileverPulse({ ...turning, outputEvery: 7 }, { segments: 1 }));
  const turned = await solve('peak-turning-rotated', cantileverPulse(turning, { segments: 1, rotated: true }));
  const peaks = (result: BeamTransientResult) => ({
    displacementM: [result.peakDisplacementM, result.peakDisplacementTimeS, result.peakDisplacementSolverNode],
    rotationRad: [result.peakRotationRad, result.peakRotationTimeS, result.peakRotationSolverNode],
  } as const);
  for (const field of ['displacementM', 'rotationRad'] as const) {
    let best = 0, bestTime = 0, bestNode = 1;
    let mixedTime = 0;
    everyStep.samples[0].nodes.forEach((_, nodeIndex) => {
      const componentMaxima = [0, 1, 2].map(axis => Math.max(...everyStep.samples.map(sample =>
        Math.abs(sample.nodes[nodeIndex][field][axis]))));
      mixedTime = Math.max(mixedTime, Math.hypot(...componentMaxima));
    });
    for (const sample of everyStep.samples) {
      for (const node of sample.nodes) {
        const magnitude = Math.hypot(...node[field]);
        if (magnitude > best) { best = magnitude; bestTime = sample.timeS; bestNode = node.solverNode; }
      }
    }
    assert(mixedTime > best * (1 + 1e-6), `${field}: fixture must combine different-time orthogonal components`);
    const [value, time, node] = peaks(everyStep)[field];
    assert(Math.abs(value - best) <= 1e-12 * best, `${field} peak ${value} vs single-time maximum ${best}`);
    assert.equal(time, bestTime);
    assert.equal(node, bestNode);
    assert.deepEqual(peaks(everySeventh)[field], peaks(everyStep)[field], `${field}: unsampled steps change the peak`);
    const [rotatedValue, rotatedTime, rotatedNode] = peaks(turned)[field];
    assert(Math.abs(rotatedValue - value) <= FRAME * value, `${field}: rotated peak ${rotatedValue} vs ${value}`);
    assert.equal(rotatedTime, time);
    assert.equal(rotatedNode, node);
  }

  // Abort during the native solve; the next request still completes.
  const controller = new AbortController();
  const cancelled = await client.analyzeTransient(cantileverPulse(pulse), { signal: controller.signal,
    onPhase: phase => { if (phase === 'solving') controller.abort(); } });
  await record({ name: 'abort-while-solving', completion: cancelled });
  assert.equal(cancelled.kind, 'cancelled');
  await axial('after-abort', transientHistory(dt, 40, [[0, 1], [40, 1]]));

  // Mechanism: translations alone leave rigid rotation about the support.
  const mechanism = { ...cantileverPulse(pulse),
    supports: [{ nodeId: 'node-0', restrained: [true, true, true, false, false, false] as const }] };
  const failed = await client.analyzeTransient(mechanism);
  await record({ name: 'rigid-rotation-mechanism', input: mechanism, completion: failed });
  assert.equal(failed.kind, 'failed');
  if (failed.kind !== 'failed') throw new Error('Mechanism accepted');
  assert.equal(failed.failure.code, 'solver-failed');
  assert(failed.failure.message.includes('transient-mechanism:'), failed.failure.message);
}
