/**
 * The coefficient behind "この値の係数を作る" (Q2=U3; GR-03b, `scratchpad/claude/plans/geomref-plan.md`
 * §4(a) and §5.2 GR-03b): one pure function that turns a math-geometry definition into a draft coefficient
 * (`Parameter`) whose formula is exactly `coef("<definition name>")`. It neither adds the coefficient nor
 * checks its name: the caller (GR-31) passes the draft to the existing `commitAddParameter`, which owns the
 * name rule, the duplicate check, the coefficient IDs and the single Undo step. The document is never
 * changed here.
 *
 * The formula refers to the definition by its coefficient ID (`math-geometry:` + definition ID, GR-01), so a
 * later rename of the measurement rewrites the label inside the formula and the coefficient keeps
 * following it (plan §7 #20). The value stored with the draft is only the caller's current measured value,
 * for display until the next recomputation replaces it (GR-04, GR-06). Like every geometry-derived value it
 * is the shape kernel's double: never an exact original and never an error bound (§4(e)).
 */
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { CANDIDATE_MATH_BY_ID, formatMathText, MATH_INPUT_FORMAT, type MathNode,
  type StoredMathExpression } from '@pointercad/expression/math/contracts';
import type { Parameter, ParameterUnit } from '../parameters/types.js';
import type { PartDocument } from '../part/types.js';
import { MATH_GEOMETRY_NOT_FOUND_MESSAGE } from './mathGeometryDefinitions.js';
import { mathGeometryCoefficientId } from './mathGeometryIdentity.js';
import type { MathGeometryOutcome } from './mathGeometryTypes.js';

/** The unit of a measured real value (`MathGeometryOutcome`'s real `unit`): mm, mm², mm³, degree or radian. */
export type MathGeometryValueUnit = Extract<MathGeometryOutcome, { readonly kind: 'real' }>['unit'];

/** What the caller supplies for the new coefficient (GR-31 builds `name` and `description` from the UI's messages). */
export interface MathGeometryParameterDraftInput {
  /** The coefficient's name, e.g. "<測定値の名前>の値" (`mathGeometry.createParameter.nameSuffix`). Not checked here. */
  readonly name: string;
  /** The definition's current measured value (GR-14). Kept for display only; the recomputation decides the value. */
  readonly value: number;
  /** The measured value's unit. Only the unit decides the coefficient's unit; the quantity kind is never consulted. */
  readonly unit: MathGeometryValueUnit;
  /** The coefficient's description, e.g. `mathGeometry.createParameter.description`. */
  readonly description: string;
}

/**
 * Why no draft could be made:
 * - `notFound`: the document has no definition with that ID.
 * - `noValue`: `value` is not a finite number. A boolean quantity (parallel, perpendicular, ...) or a
 *   pending/unresolved measurement has no number at all, so the caller refuses those before calling.
 */
export type MathGeometryParameterDraftReason = 'notFound' | 'noValue';

export type MathGeometryParameterDraftResult =
  | { readonly ok: true; readonly parameter: Parameter }
  | { readonly ok: false; readonly reason: MathGeometryParameterDraftReason; readonly message: string };

/** Appendix C「係数の下書き・値なし」; the screen's own text is `mathGeometry.createParameter.disabled.noValue`. */
const NO_VALUE_MESSAGE = '値が決まっていないため、係数を作れません。';

/**
 * Measured unit → coefficient unit (§4(a)). Only millimetres and degrees have a `ParameterUnit` of their own;
 * areas, volumes and radians become `none` instead of being forced into `mm` or `degree` (`ParameterUnit` is
 * not extended, §4(e)). A `Record`, so a new measured unit cannot be added without deciding its entry here.
 */
const PARAMETER_UNIT_OF: Readonly<Record<MathGeometryValueUnit, ParameterUnit>> = {
  mm: 'mm',
  mm2: 'none',
  mm3: 'none',
  degree: 'degree',
  radian: 'none',
};

/**
 * A draft coefficient that reads definition `definitionId` of `document`, or why none can be made
 * (`notFound` is checked before `noValue`). The draft's formula is the stored form of
 * `coef("<definition name>")`:
 * - `expression`: a single coefficient symbol whose ID is `mathGeometryCoefficientId(definitionId)` and whose
 *   label is the definition's current name (GR-04 resolves the pair and checks that they still agree);
 * - `source`: `formatMathText` of that expression, used for both `ExpressionValue.source` and
 *   `mathDefinition.source`. The math engine parses `source` again and requires the stored expression, and
 *   `acceptNumericMath` requires the two sources to be one string;
 * - `inputNotation: 'text'` and `angleUnit: 'degree'` (nothing in the formula depends on the angle setting).
 *
 * `value` and `display` come from `exactExpressionValueFromNumber`: the passed double unrounded, and the same
 * 12 significant digits a recomputation displays (`mathScalarExpression`). The draft carries no `mathId`;
 * whether the new coefficient gets one is decided when it is added (GR-31).
 */
export function mathGeometryParameterDraft(document: PartDocument, definitionId: string,
  input: MathGeometryParameterDraftInput): MathGeometryParameterDraftResult {
  const definition = (document.mathGeometry ?? []).find((item) => item.id === definitionId);
  if (definition === undefined) return { ok: false, reason: 'notFound', message: MATH_GEOMETRY_NOT_FOUND_MESSAGE };
  if (!Number.isFinite(input.value)) return { ok: false, reason: 'noValue', message: NO_VALUE_MESSAGE };
  const expression: MathNode = {
    kind: 'symbol',
    reference: { role: 'coefficient', id: mathGeometryCoefficientId(definition.id), label: definition.name },
  };
  const source = formatMathText(expression, CANDIDATE_MATH_BY_ID);
  const mathDefinition: StoredMathExpression = { format: MATH_INPUT_FORMAT, source, inputNotation: 'text', angleUnit: 'degree', expression };
  return {
    ok: true,
    parameter: {
      name: input.name,
      value: { ...exactExpressionValueFromNumber(input.value), source, mathDefinition },
      unit: PARAMETER_UNIT_OF[input.unit],
      description: input.description,
    },
  };
}
