import { createPrefixedError } from './valueGuards.js';
import type { SolidVector3, SolidVector6 } from './solidAnalysisModel.js';
import { solidTetGeometry } from './solidAnalysisTranslation.js';

/*
 * Finite-deformation kinematics of one tet4 (EX-09 W32 candidate). Internal module: not re-exported from the package
 * index, no plan/result schema, and the small-strain solidPlastic path (MAXIMUM_STRAIN 0.05) is unchanged.
 *
 * Measures follow the bundled OOFEM 214b161 Total Lagrangian path (element keyword `nlgeo 1`):
 * - NLStructuralElement::computeDeformationGradientVector (nlstructuralelement.C:89-121): F = I + dU/dX.
 * - StructuralMaterial::giveFirstPKStressVector_3d (structuralmaterial.C:330-351), used by MisesMat because it does not
 *   override it: Green-Lagrange E = (F^T F - I) / 2, the material's small-strain stress of E is taken as the second
 *   Piola-Kirchhoff stress S, and P = F S. The relations are those of Holzapfel, Nonlinear Solid Mechanics (2000),
 *   which the same OOFEM source cites for its dP/dF conversion (structuralmaterial.C:431-436).
 * Voigt orders as OOFEM floatmatrixf.h:770-858 and solidStrainStress: strain [11, 22, 33, 2*23, 2*13, 2*12]
 * (engineering shear), stress [11, 22, 33, 23, 13, 12], unsymmetric 9-form [11, 22, 33, 23, 13, 12, 32, 31, 21].
 * Units N-mm-MPa.
 */

/** Row-major 3x3 matrix: m[i][j] is row i, column j. */
export type Matrix3 = readonly [SolidVector3, SolidVector3, SolidVector3];

const fail: (message: string) => never = createPrefixedError('finite-kinematics');
function finiteMatrix(m: Matrix3, what: string): Matrix3 {
  if (!m.every(row => row.every(Number.isFinite))) fail(`non-finite ${what}`);
  return m;
}
function build(entry: (i: number, j: number) => number): Matrix3 {
  const row = (i: number): SolidVector3 => [entry(i, 0), entry(i, 1), entry(i, 2)];
  return [row(0), row(1), row(2)];
}
export function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  return build((i, j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]);
}
export function transpose3(a: Matrix3): Matrix3 { return build((i, j) => a[j][i]); }
export function determinant3(a: Matrix3): number {
  return a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
}
function strainVoigt(t: Matrix3): SolidVector6 {
  return [t[0][0], t[1][1], t[2][2], t[1][2] + t[2][1], t[0][2] + t[2][0], t[0][1] + t[1][0]];
}
function stressMatrix(s: SolidVector6): Matrix3 { return [[s[0], s[5], s[4]], [s[5], s[1], s[3]], [s[4], s[3], s[2]]]; }
function stressVoigt(t: Matrix3): SolidVector6 {
  return [t[0][0], t[1][1], t[2][2], (t[1][2] + t[2][1]) / 2, (t[0][2] + t[2][0]) / 2, (t[0][1] + t[1][0]) / 2];
}

/** J = det F. An inverted or collapsed element (J <= 0) has no admissible finite-strain state and is refused. */
export function deformationJacobian(f: Matrix3): number {
  const jacobian = determinant3(finiteMatrix(f, 'deformation gradient'));
  if (!Number.isFinite(jacobian) || !(jacobian > 0)) fail('non-positive deformation Jacobian (inverted or collapsed element)');
  return jacobian;
}

/** F = I + sum_a u_a (x) grad N_a with the exact tet4 gradients of the reference configuration (solidTetGeometry). */
export function tetDeformationGradient(reference: readonly SolidVector3[], displacement: readonly SolidVector3[]): Matrix3 {
  if (reference.length !== 4 || displacement.length !== 4) fail('tet4 requires four reference points and four displacements');
  if (!displacement.every(u => u.length === 3 && u.every(Number.isFinite))) fail('non-finite displacement');
  const { gradients } = solidTetGeometry(reference);
  const f = build((i, j) => (i === j ? 1 : 0) + gradients.reduce((sum, gradient, node) => sum + displacement[node][i] * gradient[j], 0));
  deformationJacobian(f);
  return f;
}

/** E = (F^T F - I) / 2 in the engineering-shear strain order. */
export function greenLagrangeStrain(f: Matrix3): SolidVector6 {
  const c = multiply3(transpose3(finiteMatrix(f, 'deformation gradient')), f);
  return strainVoigt(build((i, j) => (c[i][j] - (i === j ? 1 : 0)) / 2));
}

/** Directional derivative dE[F; dF] = (dF^T F + F^T dF) / 2, engineering-shear order. */
export function greenLagrangeDerivative(f: Matrix3, df: Matrix3): SolidVector6 {
  const a = multiply3(transpose3(finiteMatrix(df, 'deformation gradient direction')), finiteMatrix(f, 'deformation gradient'));
  return strainVoigt(build((i, j) => (a[i][j] + a[j][i]) / 2));
}

function lame(youngMPa: number, poisson: number): { lambda: number; mu: number } {
  if (!Number.isFinite(youngMPa) || !(youngMPa > 0)) fail('youngMPa must be positive');
  if (!Number.isFinite(poisson) || poisson < 0 || poisson >= 0.5) fail('poisson must be in [0, 0.5)');
  return { lambda: youngMPa * poisson / ((1 + poisson) * (1 - 2 * poisson)), mu: youngMPa / (2 * (1 + poisson)) };
}

/**
 * Isotropic linear-elastic stress of a Green-Lagrange strain, taken as S (Saint Venant-Kirchhoff). This is the elastic
 * branch of the OOFEM default first Piola-Kirchhoff path for MisesMat; plastic return mapping is W33, not this module.
 */
export function stVenantKirchhoffStress(strain: SolidVector6, youngMPa: number, poisson: number): SolidVector6 {
  const { lambda, mu } = lame(youngMPa, poisson);
  if (!strain.every(Number.isFinite)) fail('non-finite strain');
  const trace = strain[0] + strain[1] + strain[2];
  return [lambda * trace + 2 * mu * strain[0], lambda * trace + 2 * mu * strain[1], lambda * trace + 2 * mu * strain[2],
    mu * strain[3], mu * strain[4], mu * strain[5]];
}

/** P = F S. */
export function firstPiolaStress(f: Matrix3, secondPiola: SolidVector6): Matrix3 {
  return multiply3(finiteMatrix(f, 'deformation gradient'), stressMatrix(secondPiola));
}

/** Cauchy stress sigma = F S F^T / J (stress order). */
export function cauchyStress(f: Matrix3, secondPiola: SolidVector6): SolidVector6 {
  const jacobian = deformationJacobian(f);
  const product = multiply3(multiply3(f, stressMatrix(secondPiola)), transpose3(f));
  return stressVoigt(build((i, j) => product[i][j] / jacobian));
}

/** dP[F; dF] = dF S + F dS with dS = C : dE[F; dF] for the Saint Venant-Kirchhoff stress above. */
export function stVenantKirchhoffFirstPiolaDerivative(f: Matrix3, df: Matrix3, youngMPa: number, poisson: number): Matrix3 {
  const stress = stVenantKirchhoffStress(greenLagrangeStrain(f), youngMPa, poisson);
  const stressIncrement = stVenantKirchhoffStress(greenLagrangeDerivative(f, df), youngMPa, poisson);
  const a = multiply3(df, stressMatrix(stress)), b = multiply3(f, stressMatrix(stressIncrement));
  return build((i, j) => a[i][j] + b[i][j]);
}
