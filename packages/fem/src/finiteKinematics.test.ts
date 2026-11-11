import { describe, expect, it } from 'vitest';
import type { SolidVector3, SolidVector6 } from './solidAnalysisModel.js';
import { solidStrainStress, solidTetGeometry } from './solidAnalysisTranslation.js';
import {
  cauchyStress, deformationJacobian, firstPiolaStress, greenLagrangeDerivative, greenLagrangeStrain, multiply3,
  stVenantKirchhoffFirstPiolaDerivative, stVenantKirchhoffStress, tetDeformationGradient,
  transpose3, type Matrix3,
} from './finiteKinematics.js';

/** W = S : E / 2 per reference volume (N mm / mm^3); engineering shear makes the off-diagonal products S_ij * 2E_ij. */
function strainEnergyDensity(strain: SolidVector6, stress: SolidVector6): number {
  return strain.reduce((sum, value, index) => sum + value * stress[index], 0) / 2;
}

/*
 * Independent expectations: closed forms of Holzapfel, Nonlinear Solid Mechanics (2000) (C = F^T F, E = (C - I)/2,
 * S = lambda tr(E) I + 2 mu E, W = S:E/2, P = F S, sigma = F S F^T / J, objectivity under F -> R F), the linear-field
 * completeness of tet4, and hand-derived values (uniaxial stretch 1.2: E11 = 0.22, S11 = (lambda + 2 mu) 0.22 =
 * 59230.76923076923 MPa, S22 = lambda 0.22 = 25384.615384615383 MPa, W = 6515.384615384615, P11 = 1.2 S11 =
 * 71076.92307692308 MPa; simple shear 0.5: E = [0, 0.125, 0, 0, 0, 0.5]). The stdlib replica
 * kinematics_check.py of the W32 packet evaluates the same relations through a different tet gradient route.
 * Limits are the original plan values (W32 rotation strain/energy 1e-10, W33 objectivity 1e-8 and tangent 1e-5).
 */
const E = 200000, NU = 0.3;
const LAMBDA = E * NU / ((1 + NU) * (1 - 2 * NU)), MU = E / (2 * (1 + NU));
const TET: readonly SolidVector3[] = [[100, -40, 25], [1100, 60, -15], [180, 950, 70], [140, 30, 1020]];
const F0: Matrix3 = [[1.1, 0.2, -0.05], [0.03, 0.95, 0.1], [-0.02, 0.04, 1.05]];
const OFFSET: SolidVector3 = [3, -7, 11];

const identity: Matrix3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const maxAbs = (values: readonly number[]): number => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const flat = (m: Matrix3): number[] => m.flatMap(row => [...row]);
const difference = (a: readonly number[], b: readonly number[]): number[] => a.map((v, i) => v - b[i]);
function matrixOf(entry: (i: number, j: number) => number): Matrix3 {
  const row = (i: number): SolidVector3 => [entry(i, 0), entry(i, 1), entry(i, 2)];
  return [row(0), row(1), row(2)];
}
/** Nodal displacements of the homogeneous map x = M X + OFFSET. */
function displacementOf(m: Matrix3): SolidVector3[] {
  const component = (x: SolidVector3, i: number): number => m[i][0] * x[0] + m[i][1] * x[1] + m[i][2] * x[2] + OFFSET[i] - x[i];
  return TET.map((x): SolidVector3 => [component(x, 0), component(x, 1), component(x, 2)]);
}
/** Rodrigues' rotation formula R = cos t I + (1 - cos t) k k^T + sin t [k]x. */
function rotation(axis: SolidVector3, degrees: number): Matrix3 {
  const n = Math.hypot(...axis), k = axis.map(v => v / n), t = degrees * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const skew = [[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]];
  return matrixOf((i, j) => c * (i === j ? 1 : 0) + (1 - c) * k[i] * k[j] + s * skew[i][j]);
}
const smallStrainMaterial = { id: 'steel', youngMPa: E, poisson: NU };
const energyOf = (strain: SolidVector6): number => strainEnergyDensity(strain, stVenantKirchhoffStress(strain, E, NU));

describe('finite kinematics of tet4 (EX-09 W32 candidate)', () => {
  it('reproduces an imposed homogeneous deformation gradient on a skewed tet4', () => {
    expect(maxAbs(difference(flat(tetDeformationGradient(TET, displacementOf(F0))), flat(F0)))).toBeLessThanOrEqual(1e-12);
    expect(maxAbs(difference(flat(tetDeformationGradient(TET, displacementOf(identity))), flat(identity)))).toBeLessThanOrEqual(1e-15);
  });

  it('matches hand-derived Green-Lagrange strain, Saint Venant-Kirchhoff stress, energy and stress measures', () => {
    const stretch: Matrix3 = [[1.2, 0, 0], [0, 1, 0], [0, 0, 1]];
    const strain = greenLagrangeStrain(stretch);
    expect(maxAbs(difference(strain, [0.22, 0, 0, 0, 0, 0]))).toBeLessThanOrEqual(1e-15);
    expect(maxAbs(difference(greenLagrangeStrain([[1, 0.5, 0], [0, 1, 0], [0, 0, 1]]), [0, 0.125, 0, 0, 0, 0.5]))).toBeLessThanOrEqual(1e-15);
    expect(maxAbs(difference(greenLagrangeStrain([[1, 0, 0], [0, 1, 0], [0.5, 0, 1]]), [0.125, 0, 0, 0, 0.5, 0]))).toBeLessThanOrEqual(1e-15);
    const stress = stVenantKirchhoffStress(strain, E, NU);
    const relative = (value: number, expected: number): number => Math.abs(value - expected) / Math.abs(expected);
    expect(relative(stress[0], 59230.76923076923)).toBeLessThanOrEqual(1e-12);
    expect(relative(stress[0], (LAMBDA + 2 * MU) * 0.22)).toBeLessThanOrEqual(1e-12);
    expect(relative(stress[1], 25384.615384615383)).toBeLessThanOrEqual(1e-12);
    expect(relative(stress[2], LAMBDA * 0.22)).toBeLessThanOrEqual(1e-12);
    expect(maxAbs(stress.slice(3))).toBe(0);
    expect(relative(strainEnergyDensity(strain, stress), 6515.384615384615)).toBeLessThanOrEqual(1e-12);
    const first = firstPiolaStress(stretch, stress);
    expect(relative(first[0][0], 71076.92307692308)).toBeLessThanOrEqual(1e-12);
    const cauchy = cauchyStress(stretch, stress);
    expect(relative(cauchy[0], 1.2 * 59230.76923076923)).toBeLessThanOrEqual(1e-12);
    expect(relative(cauchy[1], 25384.615384615383 / 1.2)).toBeLessThanOrEqual(1e-12);
    expect(deformationJacobian(stretch)).toBe(1.2);
  });

  it.each([
    [[0, 0, 1], 90], [[1, 0, 0], 180], [[0, 1, 0], 180], [[1, 1, 1], 90], [[1, 1, 1], 180],
  ] as const)('rigid rotation about %j by %i degrees: Green-Lagrange strain and energy vanish to 1e-10 of the small-strain measure', (axis, degrees) => {
    const displacement = displacementOf(rotation(axis, degrees));
    const strain = greenLagrangeStrain(tetDeformationGradient(TET, displacement));
    // The current small-strain measure of the same motion (solidStrainStress) is O(1): the reason it is not objective.
    const small = solidStrainStress(solidTetGeometry(TET).gradients, displacement, smallStrainMaterial);
    const smallEnergy = strainEnergyDensity(small.strain, small.stressMPa);
    expect(maxAbs(small.strain)).toBeGreaterThanOrEqual(0.5);
    expect(maxAbs(strain) / maxAbs(small.strain)).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(energyOf(strain)) / smallEnergy).toBeLessThanOrEqual(1e-10);
  });

  it('is objective under a superposed rotation (strain/energy 1e-10, P and Cauchy 1e-8)', () => {
    const r = rotation([0.3, -0.5, 0.8], 137);
    const base = tetDeformationGradient(TET, displacementOf(F0));
    const rotated = tetDeformationGradient(TET, displacementOf(multiply3(r, F0)));
    const strain = greenLagrangeStrain(base), rotatedStrain = greenLagrangeStrain(rotated);
    expect(maxAbs(difference(rotatedStrain, strain)) / maxAbs(strain)).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(energyOf(rotatedStrain) - energyOf(strain)) / energyOf(strain)).toBeLessThanOrEqual(1e-10);
    const stress = stVenantKirchhoffStress(strain, E, NU), rotatedStress = stVenantKirchhoffStress(rotatedStrain, E, NU);
    const p = firstPiolaStress(base, stress);
    expect(maxAbs(difference(flat(firstPiolaStress(rotated, rotatedStress)), flat(multiply3(r, p)))) / maxAbs(flat(p))).toBeLessThanOrEqual(1e-8);
    const sigma = cauchyStress(base, stress);
    const sigmaMatrix: Matrix3 = [[sigma[0], sigma[5], sigma[4]], [sigma[5], sigma[1], sigma[3]], [sigma[4], sigma[3], sigma[2]]];
    const expected = multiply3(multiply3(r, sigmaMatrix), transpose3(r));
    const actual = cauchyStress(rotated, rotatedStress);
    expect(maxAbs(difference(actual, [expected[0][0], expected[1][1], expected[2][2], expected[1][2], expected[0][2], expected[0][1]]))
      / maxAbs(sigma)).toBeLessThanOrEqual(1e-8);
  });

  it('directional derivatives of E and P agree with central differences to 1e-5', () => {
    const direction: Matrix3 = [[0.3, -0.1, 0.2], [0.05, 0.4, -0.25], [-0.15, 0.1, 0.35]];
    const h = 1e-6;
    const shifted = (sign: number): Matrix3 => matrixOf((i, j) => F0[i][j] + sign * h * direction[i][j]);
    const numericStrain = difference(greenLagrangeStrain(shifted(1)), greenLagrangeStrain(shifted(-1))).map(v => v / (2 * h));
    const analyticStrain = greenLagrangeDerivative(F0, direction);
    expect(maxAbs(difference(numericStrain, analyticStrain)) / maxAbs(analyticStrain)).toBeLessThanOrEqual(1e-5);
    const p = (f: Matrix3): number[] => flat(firstPiolaStress(f, stVenantKirchhoffStress(greenLagrangeStrain(f), E, NU)));
    const numericP = difference(p(shifted(1)), p(shifted(-1))).map(v => v / (2 * h));
    const analyticP = flat(stVenantKirchhoffFirstPiolaDerivative(F0, direction, E, NU));
    expect(maxAbs(difference(numericP, analyticP)) / maxAbs(analyticP)).toBeLessThanOrEqual(1e-5);
  });

  it('refuses inverted or collapsed elements, non-finite input and wrong arity instead of returning a strain', () => {
    expect(() => tetDeformationGradient(TET, displacementOf([[-1, 0, 0], [0, 1, 0], [0, 0, 1]]))).toThrow('non-positive deformation Jacobian');
    expect(() => tetDeformationGradient(TET, displacementOf([[1, 0, 0], [0, 1, 0], [0, 0, -0.5]]))).toThrow('non-positive deformation Jacobian');
    // An exactly collapsed gradient (J = 0); a tet mapped onto a plane carries rounding of either sign, so it is not used.
    expect(() => deformationJacobian([[1, 0, 0], [0, 1, 0], [0, 0, 0]])).toThrow('non-positive deformation Jacobian');
    expect(() => deformationJacobian([[1, 0, 0], [0, Number.NaN, 0], [0, 0, 1]])).toThrow('non-finite deformation gradient');
    const broken = displacementOf(F0);
    broken[2] = [0, Number.POSITIVE_INFINITY, 0];
    expect(() => tetDeformationGradient(TET, broken)).toThrow('non-finite displacement');
    expect(() => tetDeformationGradient(TET.slice(0, 3), displacementOf(F0).slice(0, 3))).toThrow('tet4 requires four');
    expect(() => stVenantKirchhoffStress([0, 0, 0, 0, 0, 0], E, 0.5)).toThrow('poisson must be in [0, 0.5)');
  });
});
