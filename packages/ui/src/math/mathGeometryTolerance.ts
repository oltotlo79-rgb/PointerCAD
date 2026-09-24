/** GR-19a: comparison margins are entered in mm/degrees and stored in mm/radians. */
import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';
import {
  DEFAULT_MATH_GEOMETRY_TOLERANCE,
  validateMathGeometryTolerance,
  type MathGeometryTolerance,
  type MathGeometryToleranceField,
} from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';

export interface MathGeometryToleranceFields {
  readonly linear: string;
  readonly angular: string;
}

export const MATH_GEOMETRY_TOLERANCE_ERROR_KEYS = {
  linear: 'mathGeometry.tolerance.error.linear',
  angular: 'mathGeometry.tolerance.error.angular',
} as const satisfies Record<MathGeometryToleranceField, MessageKey>;

export type MathGeometryToleranceReadResult =
  | { readonly ok: true; readonly tolerance: MathGeometryTolerance }
  | { readonly ok: false; readonly errors: Readonly<Record<MathGeometryToleranceField, MessageKey | null>> };

/** Display only: 12 significant digits, without rounding the stored margin. Omit to reset the fields. */
export function mathGeometryToleranceFields(
  tolerance: MathGeometryTolerance = DEFAULT_MATH_GEOMETRY_TOLERANCE,
): MathGeometryToleranceFields {
  return {
    linear: expressionValueFromNumber(tolerance.linearMm).display,
    angular: expressionValueFromNumber(tolerance.angularRadians * (180 / Math.PI)).display,
  };
}

/** Always mm/degrees, even when measured lengths are displayed in inches. */
export function mathGeometryToleranceText(tolerance: MathGeometryTolerance): string {
  const fields = mathGeometryToleranceFields(tolerance);
  return t('mathGeometry.toleranceValue')
    .replace('{linear}', `${fields.linear} ${t('measure.unit.millimeter')}`)
    .replace('{angular}', `${fields.angular} ${t('measure.unit.degree')}`);
}

/**
 * GR-19c fix: resolves the tolerance to submit from `edited`, the field(s) a draft actually changed.
 * A field absent from `edited` keeps `current`'s own number **verbatim** rather than the 12-significant-
 * digit display text re-parsed — confirming an edit to one field must never drift the other.
 *
 * Reusing the displayed text for an untouched field round-trips it through degree conversion and
 * 12-digit formatting (`mathGeometryToleranceFields`), which is lossy: the default 1e-6 rad angular
 * margin becomes "0.0000572957795131"° on display, and reading that back
 * (`° × Math.PI / 180`) yields 1.0000000000003087e-6 rad, not the original 1e-6. This is the same
 * reasoning `mathGeometry.tolerance.reset`'s direct `DEFAULT_MATH_GEOMETRY_TOLERANCE` submission
 * already relies on to avoid a display round-trip; this function gives the ordinary "apply" submission
 * the same guarantee for whichever field the user did not touch.
 */
export function resolveMathGeometryTolerance(
  current: MathGeometryTolerance,
  edited: Partial<MathGeometryToleranceFields>,
): MathGeometryToleranceReadResult {
  const linear = edited.linear === undefined ? null : evaluateExpression(edited.linear);
  const angular = edited.angular === undefined ? null : evaluateExpression(edited.angular);
  const tolerance: MathGeometryTolerance = {
    linearMm: linear === null ? current.linearMm : (linear.ok ? linear.value.value : Number.NaN),
    angularRadians: angular === null ? current.angularRadians
      : (angular.ok ? angular.value.value * (Math.PI / 180) : Number.NaN),
  };
  // Validate each field with a valid companion, so neither error can hide the other.
  const linearError = validateMathGeometryTolerance({ ...DEFAULT_MATH_GEOMETRY_TOLERANCE, linearMm: tolerance.linearMm });
  const angularError = validateMathGeometryTolerance({ ...DEFAULT_MATH_GEOMETRY_TOLERANCE, angularRadians: tolerance.angularRadians });
  if (linearError === null && angularError === null) return { ok: true, tolerance };
  return { ok: false, errors: {
    linear: linearError === null ? null : MATH_GEOMETRY_TOLERANCE_ERROR_KEYS.linear,
    angular: angularError === null ? null : MATH_GEOMETRY_TOLERANCE_ERROR_KEYS.angular,
  } };
}

/**
 * Constants and arithmetic use the existing expression language; only the model validates margins.
 * `fields` always supplies both strings, so `resolveMathGeometryTolerance`'s "keep `current`'s value"
 * branch is never reached — `DEFAULT_MATH_GEOMETRY_TOLERANCE` is passed only as a placeholder `current`.
 */
export function readMathGeometryTolerance(fields: MathGeometryToleranceFields): MathGeometryToleranceReadResult {
  return resolveMathGeometryTolerance(DEFAULT_MATH_GEOMETRY_TOLERANCE, fields);
}
