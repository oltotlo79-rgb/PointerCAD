import assert from 'node:assert/strict';
import type { FemClient } from './client.js';
import type { BeamTransientInput, BeamTransientResult, TransientHistory } from './transientModel.js';
import { AXIAL_FORCE_N, AXIAL_OSCILLATOR, TORSION_MOMENT_NM, TORSION_OSCILLATOR,
  axialOscillator, axialTorsionOscillator, transientHistory } from './transient.testSupport.js';

type Damping = Exclude<TransientHistory['damping'], 'none'>;
const METHOD = 'oofem-beam3d-matrices-newmark-average-acceleration/2';
const ROUNDING = 1e-9;

/** Independent solution of m*u''+c*u'+k*u=F, initially at rest, under a constant step.
 * For Newmark average acceleration, replace exp(lambda*t) by g^n,
 * g=(1+h*lambda/2)/(1-h*lambda/2), lambda=-zeta*omega+i*omega*sqrt(1-zeta^2).
 * This closed form never calls the product recurrence or any fitted output.
 */
export function dampedStep(oscillator: { readonly mass: number; readonly stiffness: number; readonly omega: number },
  force: number, damping: Damping, timeStep: number, step: number, continuous = false): readonly [number, number, number] {
  const { mass, stiffness, omega } = oscillator;
  const c = damping.massCoefficientPerS * mass + damping.stiffnessCoefficientS * stiffness;
  const zeta = c / (2 * mass * omega);
  assert(zeta > 0, 'This independent fixture requires positive damping');
  // The deliberately critical alpha=2*omega case can differ from one by a few ulps
  // after multiplication by physical mass; use its repeated-root limit, not cancellation.
  const critical = Math.abs(zeta - 1) <= 4 * Number.EPSILON;
  if (zeta >= 1 || critical) {
    assert(!continuous, 'Continuous refinement controls use the underdamped fixture');
    const scale = force / stiffness;
    let u: number;
    let v: number;
    if (critical) {
      const g = (1 - omega * timeStep / 2) / (1 + omega * timeStep / 2);
      const derivative = timeStep / (1 + omega * timeStep / 2) ** 2;
      const jordan = step === 0 ? 0 : step * derivative * g ** (step - 1);
      u = scale * (1 - g ** step - omega * jordan);
      v = scale * omega * omega * jordan;
    } else {
      const root = Math.sqrt(zeta * zeta - 1);
      const first = -omega / (zeta + root);
      const second = -omega * (zeta + root);
      const g1 = ((1 + first * timeStep / 2) / (1 - first * timeStep / 2)) ** step;
      const g2 = ((1 + second * timeStep / 2) / (1 - second * timeStep / 2)) ** step;
      u = scale * (1 + (second * g1 - first * g2) / (first - second));
      v = scale * first * second * (g1 - g2) / (first - second);
    }
    return [u, v, (force - c * v - stiffness * u) / mass];
  }
  const s = Math.sqrt(1 - zeta * zeta);
  const x = -zeta * omega * timeStep / 2;
  const y = omega * s * timeStep / 2;
  const denominator = (1 - x) ** 2 + y * y;
  const real = (1 - x * x - y * y) / denominator;
  const imaginary = 2 * y / denominator;
  const amplitude = continuous ? Math.exp(-zeta * omega * timeStep * step) : Math.hypot(real, imaginary) ** step;
  const angle = continuous ? omega * s * timeStep * step : Math.atan2(imaginary, real) * step;
  const u = force / stiffness * (1 - amplitude * (Math.cos(angle) + zeta / s * Math.sin(angle)));
  const v = force / stiffness * omega / s * amplitude * Math.sin(angle);
  return [u, v, (force - c * v - stiffness * u) / mass];
}

/** Append to the existing Root-owned real OOFEM/NumPy client route, preserving all original
 * transient controls. Root records each completion BEFORE assertions, including failures.
 * ROUNDING=1e-9 of physical oscillator scales is the existing undamped discrete tolerance.
 * Time convergence uses a pre-derived complex-log bound, with no fitted constants.
 */
export async function runTransientDampingNativeChecks(client: FemClient,
  record: (value: unknown) => Promise<void>): Promise<void> {
  const solve = async (name: string, input: BeamTransientInput): Promise<BeamTransientResult> => {
    const completion = await client.analyzeTransient(input);
    await record({ name, input, completion });
    assert.equal(completion.kind, 'result', `${name}: real solver result required`);
    if (completion.kind !== 'result') throw new Error('No transient result');
    const result = completion.result;
    assert.equal(result.nativeTransientSolver, false);
    assert.equal(result.structuralCertification, false);
    assert(result.maximumEquilibriumResidual <= 1e-8 && result.maximumEnergyBalanceError <= 1e-8);
    if (input.history.damping !== 'none') {
      assert.equal(result.method, METHOD);
      if (result.method !== METHOD) throw new Error('Stale undamped runtime');
      assert.deepEqual(result.damping, input.history.damping);
      assert(Number.isFinite(result.dissipatedEnergyJ) && result.dissipatedEnergyJ >= 0);
    }
    return result;
  };
  const { omega, period, stiffness, mass } = AXIAL_OSCILLATOR;
  const cases: readonly Damping[] = [
    { kind: 'rayleigh', massCoefficientPerS: 0.4 * omega, stiffnessCoefficientS: 0 },
    { kind: 'rayleigh', massCoefficientPerS: 0, stiffnessCoefficientS: 0.4 / omega },
    { kind: 'rayleigh', massCoefficientPerS: 0.2 * omega, stiffnessCoefficientS: 0.2 / omega },
    { kind: 'rayleigh', massCoefficientPerS: 2 * omega, stiffnessCoefficientS: 0 },
    { kind: 'rayleigh', massCoefficientPerS: 4 * omega, stiffnessCoefficientS: 0 },
  ];
  const history = (damping: Damping, steps = 80): TransientHistory => ({
    ...transientHistory(period / steps, steps, [[0, 1], [steps, 1]]), damping,
  });
  const check = (result: BeamTransientResult, input: BeamTransientInput, damping: Damping,
    torsion = false): void => {
    assert.equal(result.method, METHOD);
    if (result.method !== METHOD) throw new Error('Missing damping metadata');
    let finalEnergy = 0;
    let finalWork = 0;
    const axes = [{ oscillator: AXIAL_OSCILLATOR, force: AXIAL_FORCE_N, rotation: false },
      ...(torsion ? [{ oscillator: TORSION_OSCILLATOR, force: TORSION_MOMENT_NM, rotation: true }] : [])];
    for (const { oscillator, force, rotation } of axes) {
      const scales = [force / oscillator.stiffness, force * oscillator.omega / oscillator.stiffness, force / oscillator.mass];
      result.samples.forEach((sample, index) => {
        const n = Math.min(index * input.history.outputEvery, input.history.stepCount);
        const expected = dampedStep(oscillator, force, damping, input.history.timeStepS, n);
        const tip = sample.nodes[1];
        const values = rotation ? [tip.rotationRad[0], tip.angularVelocityRadPerS[0], tip.angularAccelerationRadPerS2[0]]
          : [tip.displacementM[0], tip.velocityMPerS[0], tip.accelerationMPerS2[0]];
        values.forEach((value, axis) => assert(Math.abs(value - expected[axis]) <= ROUNDING * scales[axis],
          `damped closed form n=${n} rotation=${rotation} axis=${axis}: ${value} vs ${expected[axis]}`));
        if (index === result.samples.length - 1) {
          finalEnergy += (oscillator.mass * values[1] ** 2 + oscillator.stiffness * values[0] ** 2) / 2;
          finalWork += force * values[0];
        }
      });
    }
    const energyScale = axes.reduce((sum, axis) => sum + axis.force ** 2 / axis.oscillator.stiffness, 0);
    assert(result.dissipatedEnergyJ > 0, 'A nonzero loaded viscously damped trajectory must dissipate energy');
    assert(Math.abs(result.dissipatedEnergyJ - (finalWork - finalEnergy)) <= ROUNDING * energyScale,
      'Independent physical work minus kinetic/elastic energy must equal reported loss');
  };
  for (const [index, damping] of cases.entries()) {
    const input = axialOscillator(history(damping));
    check(await solve(`damping-step-${index}`, input), input, damping);
  }
  const mixed = cases[2];
  // A second independent natural frequency prevents a wrong constant modal damping ratio from passing.
  // Use smaller alpha so both axial and torsional modes are underdamped.
  const twoMode: Damping = { kind: 'rayleigh', massCoefficientPerS: 0.1 * TORSION_OSCILLATOR.omega,
    stiffnessCoefficientS: 0.2 / omega };
  const coupled = axialTorsionOscillator(history(twoMode));
  check(await solve('damping-axial-and-torsion', coupled), coupled, twoMode, true);
  const mm = axialOscillator(history(mixed), { millimetres: true });
  check(await solve('damping-millimetres', mm), mm, mixed);

  const errors: number[] = [];
  for (const steps of [20, 40, 80]) {
    const input = axialOscillator(history(mixed, steps));
    const result = await solve(`damping-time-convergence-${steps}`, input);
    check(result, input, mixed);
    const error = Math.max(...result.samples.map((sample, index) => Math.abs(sample.nodes[1].displacementM[0]
      - dampedStep(AXIAL_OSCILLATOR, AXIAL_FORCE_N, mixed, input.history.timeStepS, index, true)[0])));
    // |log(g)-h*lambda| <= |h*lambda|^3/[12*(1-|h*lambda|^2/4)], |lambda|=omega.
    const h = input.history.timeStepS;
    const epsilon = period * omega ** 3 * h * h / (12 * (1 - (omega * h) ** 2 / 4));
    const zeta = 0.2;
    const bound = AXIAL_FORCE_N / stiffness * (1 + zeta / Math.sqrt(1 - zeta * zeta)) * epsilon * Math.exp(epsilon);
    assert(error <= bound, `Continuous damped solution exceeds independent bound: ${error} > ${bound}`);
    errors.push(error);
  }
  assert(errors[0] / errors[1] > 3.5 && errors[1] / errors[2] > 3.5, `Expected second order: ${errors.join(',')}`);

  const none = transientHistory(period / 80, 80, [[0, 1], [80, 1]]);
  const zero: Damping = { kind: 'rayleigh', massCoefficientPerS: 0, stiffnessCoefficientS: 0 };
  const undamped = await solve('damping-none-regression', axialOscillator(none));
  const zeroResult = await solve('damping-zero-equivalence', axialOscillator({ ...none, damping: zero }));
  assert.deepEqual(zeroResult.samples, undamped.samples);
  assert.equal(zeroResult.maximumEnergyBalanceError, undamped.maximumEnergyBalanceError);
  assert.equal(zeroResult.maximumEquilibriumResidual, undamped.maximumEquilibriumResidual);
  if (zeroResult.method !== METHOD) throw new Error('Missing zero-Rayleigh metadata');
  assert.equal(zeroResult.dissipatedEnergyJ, 0);

  const pulse: TransientHistory = { ...transientHistory(period / 80, 80, [[0, 0], [10, 1], [20, 0], [80, 0]]), damping: mixed };
  const pulseResult = await solve('damping-pulse-release', axialOscillator(pulse));
  let previousEnergy = Number.POSITIVE_INFINITY;
  for (const sample of pulseResult.samples.slice(20)) {
    const tip = sample.nodes[1];
    const energy = (mass * tip.velocityMPerS[0] ** 2 + stiffness * tip.displacementM[0] ** 2) / 2;
    assert(energy <= previousEnergy + 1e-12 * AXIAL_FORCE_N ** 2 / stiffness, 'Unforced energy increased');
    previousEnergy = energy;
  }
  const unloaded = await solve('damping-zero-load', axialOscillator({ ...history(mixed),
    loadFactor: [{ timeS: 0, factor: 0 }, { timeS: period, factor: 0 }] }));
  assert.equal(unloaded.peakDisplacementM, 0);
  if (unloaded.method !== METHOD) throw new Error('Missing unloaded Rayleigh metadata');
  assert.equal(unloaded.dissipatedEnergyJ, 0);
  const quantities = ['displacementM', 'rotationRad', 'velocityMPerS', 'angularVelocityRadPerS',
    'accelerationMPerS2', 'angularAccelerationRadPerS2'] as const;
  assert(unloaded.samples.every(sample => sample.nodes.every(node => quantities.every(key =>
    node[key].every(value => value === 0)))), 'Zero load from rest must stay exactly at rest');
}
