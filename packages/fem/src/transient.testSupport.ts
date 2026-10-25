import type { Vector3 } from './analysisModel.js';
import type { BucklingRestraints } from './bucklingModel.js';
import { MODAL_REFERENCE, modalFixture, rotateModalVector } from './modal.testSupport.js';
import type { BeamTransientInput, TransientHistory } from './transientModel.js';

/** Independent single-degree axial oscillator, derived before any runtime observation.
 * One beam3d element, node-0 fully restrained and node-1 free only along global x.
 * Stiffness EA/L; the free entry of the native consistent axial mass is rho*A*L/3
 * (OOFEM 214b161 beam3d.C 775-776 and 795; the bending rotary correction does not touch axial DOFs).
 */
export const AXIAL_OSCILLATOR = (() => {
  const stiffness = MODAL_REFERENCE.young * MODAL_REFERENCE.area / MODAL_REFERENCE.length;
  const mass = MODAL_REFERENCE.density * MODAL_REFERENCE.area * MODAL_REFERENCE.length / 3;
  const omega = Math.sqrt(stiffness / mass);
  return { stiffness, mass, omega, period: 2 * Math.PI / omega };
})();
export const AXIAL_FORCE_N = 1000;

export function transientHistory(timeStepS: number, stepCount: number,
  knots: readonly (readonly [step: number, factor: number])[], outputEvery = 1): TransientHistory {
  return { timeStepS, stepCount, outputEvery, damping: 'none', initialConditions: 'zero-at-rest',
    loadFactor: knots.map(([step, factor]) => ({ timeS: timeStepS * step, factor })) };
}

export function axialOscillator(history: TransientHistory, options: { readonly millimetres?: boolean } = {}): BeamTransientInput {
  const geometry = modalFixture({ free: true, modes: 1, segments: 1, millimetres: options.millimetres });
  const axialOnly: BucklingRestraints = [false, true, true, true, true, true];
  return { schema: 'pointercad-beam-transient/1', geometry,
    supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] },
      { nodeId: 'node-1', restrained: axialOnly }],
    referenceLoads: [{ id: 'axial', kind: 'nodal', nodeId: 'node-1', force: [AXIAL_FORCE_N, 0, 0], moment: [0, 0, 0] }],
    history };
}

/** Exact average-acceleration Newmark (trapezoidal) response of the axial oscillator at grid step n.
 * The integrator rotates (omega*x, v) by Omega = 2 atan(omega*dt/2) per step around the static
 * solution. A factor f0 at t=0 is a step; each later slope change ds at grid knot j adds a ramp
 * whose particular solution is integrated exactly, so the response is a sum of shifted terms.
 * Knots must lie on grid steps. Values: displacement m, velocity m/s, acceleration m/s2.
 */
export function exactDiscreteAxial(history: TransientHistory, step: number): readonly [number, number, number] {
  return exactDiscreteOscillator(history, step, AXIAL_OSCILLATOR, AXIAL_FORCE_N);
}

/** Independent torsional oscillator of the same element (tip free only in rx): stiffness G*Ik/L
 * (beam3d B(4,4)=-1/l with SimpleCrossSection G*Ik) and consistent torsional mass rho*(Iy+Iz)*L/3
 * (beam3d.C 766-767 and 785; the rotary correction touches bending DOFs only). Decoupled from axial. */
export const TORSION_OSCILLATOR = (() => {
  const stiffness = MODAL_REFERENCE.shear * MODAL_REFERENCE.torsion / MODAL_REFERENCE.length;
  const mass = MODAL_REFERENCE.density * (MODAL_REFERENCE.iy + MODAL_REFERENCE.iz) * MODAL_REFERENCE.length / 3;
  const omega = Math.sqrt(stiffness / mass);
  return { stiffness, mass, omega, period: 2 * Math.PI / omega };
})();
export const TORSION_MOMENT_NM = 1;

/** Tip free in axial x and torsion rx only: two decoupled exact oscillators in one native run. */
export function axialTorsionOscillator(history: TransientHistory): BeamTransientInput {
  const input = axialOscillator(history);
  return { ...input, supports: [input.supports[0], { nodeId: 'node-1', restrained: [false, true, true, false, true, true] }],
    referenceLoads: [{ ...input.referenceLoads[0], moment: [TORSION_MOMENT_NM, 0, 0] }] };
}

export function exactDiscreteOscillator(history: TransientHistory, step: number,
  oscillator: { readonly stiffness: number; readonly mass: number; readonly omega: number },
  amplitude: number): readonly [number, number, number] {
  const { stiffness, mass, omega } = oscillator;
  const dt = history.timeStepS;
  const angle = 2 * Math.atan(omega * dt / 2);
  const knots = history.loadFactor.map(sample => {
    const index = Math.round(sample.timeS / dt);
    if (Math.abs(index * dt - sample.timeS) > dt * 1e-9) throw new Error('Knot is not on the time grid');
    return { index, factor: sample.factor };
  });
  const scale = amplitude / stiffness;
  const f0 = knots[0].factor;
  let u = f0 * scale * (1 - Math.cos(step * angle));
  let v = f0 * scale * omega * Math.sin(step * angle);
  let a = f0 * amplitude / mass * Math.cos(step * angle);
  let previousSlope = 0;
  for (let index = 0; index + 1 < knots.length; index += 1) {
    const slope = (knots[index + 1].factor - knots[index].factor) / (dt * (knots[index + 1].index - knots[index].index));
    const change = slope - previousSlope;
    previousSlope = slope;
    const start = knots[index].index;
    if (step < start) continue;
    const phase = (step - start) * angle;
    u += change * scale * ((step - start) * dt - Math.sin(phase) / omega);
    v += change * scale * (1 - Math.cos(phase));
    a += change * scale * omega * Math.sin(phase);
  }
  return [u, v, a];
}

/** Undamped continuous step response u = (F/k)(1 - cos(omega t)). */
export function continuousAxialStep(timeS: number): number {
  return AXIAL_FORCE_N / AXIAL_OSCILLATOR.stiffness * (1 - Math.cos(AXIAL_OSCILLATOR.omega * timeS));
}

/** Clamped four-segment cantilever with a transverse tip force and torque, optionally in the exact rotated frame. */
export function cantileverPulse(history: TransientHistory, options: {
  readonly rotated?: boolean; readonly millimetres?: boolean; readonly segments?: number;
} = {}): BeamTransientInput {
  const geometry = modalFixture({ free: true, modes: 1, segments: options.segments ?? 4, rotated: options.rotated,
    millimetres: options.millimetres });
  const map = (value: Vector3): Vector3 => options.rotated ? rotateModalVector(value) : value;
  const momentUnit = options.millimetres ? 1000 : 1;
  return { schema: 'pointercad-beam-transient/1', geometry,
    supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'tip', kind: 'nodal', nodeId: 'node-1', force: map([0, 20, 5]),
      moment: map([2 * momentUnit, 0, 0]) }],
    history };
}
