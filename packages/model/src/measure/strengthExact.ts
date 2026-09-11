/** Input values first pass the quantity/unit boundary; intermediates retain exact decimal strings. */
import { evaluateExpressionExact, type ExactExpressionValue } from '@pointercad/expression';

export type StrengthResultName = 'secondMoment' | 'sectionModulus' | 'innerDiameter' | 'moment' | 'stress'
  | 'deflection' | 'equivalentStress' | 'allowableStress' | 'actualSafetyFactor' | 'reserveFactor'
  | 'polarMoment' | 'polarModulus' | 'shearStress' | 'twist';
type Formula = readonly [name: StrengthResultName, source: string];
export type BeamSectionKind = 'rectangle' | 'circle' | 'tube';
export type StrengthCalculation =
  | { readonly kind: 'beam'; readonly section: BeamSectionKind; readonly support: 'cantilever' | 'simply-supported' }
  | { readonly kind: 'shaft' }
  | { readonly kind: 'bolt' };
export type ExactStrengthOutcome = { readonly ok: true; readonly values: ReadonlyMap<string, ExactExpressionValue> }
  | { readonly ok: false; readonly field: string; readonly message: string };

const sectionSteps: Record<BeamSectionKind, readonly Formula[]> = {
  rectangle: [['secondMoment', 'width*height^3/12'], ['sectionModulus', 'width*height^2/6']],
  circle: [['secondMoment', 'pi*diameter^4/64'], ['sectionModulus', 'pi*diameter^3/32']],
  tube: [['innerDiameter', 'diameter-2*thickness'],
    ['secondMoment', 'pi*(diameter-innerDiameter)*(diameter+innerDiameter)*(diameter^2+innerDiameter^2)/64'],
    ['sectionModulus', '2*secondMoment/diameter']],
};
const normalAssessment: readonly Formula[] = [
  ['equivalentStress', 'stress'], ['allowableStress', 'yieldStress/safetyFactor'],
  ['actualSafetyFactor', 'yieldStress/equivalentStress'], ['reserveFactor', 'actualSafetyFactor/safetyFactor'],
];
export function strengthFormulas(calculation: StrengthCalculation): readonly Formula[] {
  if (calculation.kind === 'beam') return [
    ...sectionSteps[calculation.section],
    ['moment', calculation.support === 'cantilever' ? 'force*length' : 'force*length/4'],
    // For a rectangle, avoid taking the reciprocal of the rounded b*h²/6.
    // The equivalent formula retains exact integer boundary cases such as 6 MPa.
    ['stress', calculation.section === 'rectangle' ? '6*moment/(width*height^2)' : 'moment/sectionModulus'],
    ['deflection', calculation.support === 'cantilever'
      ? 'force*length^3/(3*youngModulus*secondMoment)' : 'force*length^3/(48*youngModulus*secondMoment)'],
    ...normalAssessment,
  ];
  if (calculation.kind === 'shaft') return [
    ['polarMoment', 'pi*(outerDiameter-innerDiameter)*(outerDiameter+innerDiameter)*(outerDiameter^2+innerDiameter^2)/32'],
    ['polarModulus', '2*polarMoment/outerDiameter'], ['shearStress', 'torque/polarModulus'],
    ['twist', 'torque*length/(shearModulus*polarMoment)'], ['equivalentStress', 'sqrt(3)*shearStress'],
    ['allowableStress', 'yieldStress/(sqrt(3)*safetyFactor)'],
    ['actualSafetyFactor', 'yieldStress/equivalentStress'], ['reserveFactor', 'actualSafetyFactor/safetyFactor'],
  ];
  return [['stress', 'force/tensileArea'], ...normalAssessment];
}

/** Canonical units: N, mm, MPa, N·mm, rad; exact input strings have no suffix.
 * Geometric/material bounds are checked by the calling pure input validator.
 * Only computed output doubles may be used for final display/comparison.
 */
export function calculateExactStrength(calculation: StrengthCalculation, canonicalInputs: ReadonlyMap<string, string>): ExactStrengthOutcome {
  const exactVariables = new Map(canonicalInputs);
  const values = new Map<string, ExactExpressionValue>();
  for (const [name, source] of strengthFormulas(calculation)) {
    const result = evaluateExpressionExact(source, { exactVariables });
    if (!result.ok) return { ok: false, field: name, message: result.error.message };
    if (!Number.isFinite(result.value.value) || result.value.value <= 0) {
      return { ok: false, field: name, message: '入力の範囲を確認してください。正の有限値を計算できません。' };
    }
    exactVariables.set(name, result.value.exact);
    values.set(name, result.value);
  }
  return { ok: true, values };
}
