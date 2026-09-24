/**
 * Definition-editing commands for math geometry (GR-03, `scratchpad/claude/plans/geomref-plan.md`
 * §5.2 GR-03, plus wave2's "GR-03 への追加"): the pure functions behind "選択から追加" / "選び直す" /
 * the angle-unit toggle / "削除" / the per-definition tolerance edit (Q5=T3) in §4(a)'s row operations.
 * Every function takes a `PartDocument` and returns a new one (or, when nothing actually changes, the
 * same document by reference — `part/documentChange.ts`'s `affectsShape` relies on that to skip
 * unnecessary recomputation). Nothing here touches the kernel, a Worker, or evaluates a value; the
 * identity rules (name collisions, the coefficient-ID namespace, the default tolerance, usage lookup)
 * all come from GR-01 (`mathGeometryIdentity.ts`) and are never re-derived here.
 *
 * GR-03b (plan §5.2 GR-03b) added `validateMathGeometryTolerance`, the exported per-field form of the
 * tolerance rule, so the screen's two tolerance fields (Q5=T3) can each show their own error, and split
 * the tolerance refusal into one sentence per field (Appendix C).
 *
 * A rejection carries both a machine-checkable `reason` (for callers/tests that want their own wording)
 * and a ready Japanese `message`. This package cannot import `packages/ui`'s i18n JSON (dependency
 * direction, rules/04-設計の規律.md), so — like `measure/mathGeometry.ts`'s `GeometryProblem` and
 * `part/timelineOrder.ts`'s `ReorderRefusal` — a model-layer refusal must carry its own text rather than
 * a bare code the UI resolves.
 */
import type { PartDocument } from '../part/types.js';
import {
  checkMathGeometryName,
  DEFAULT_MATH_GEOMETRY_TOLERANCE,
  mathGeometryUsage,
  type MathGeometryNameIssue,
} from './mathGeometryIdentity.js';
import type { MathGeometryDefinition, MathGeometryQuantity, MathGeometryTolerance } from './mathGeometryTypes.js';

/** What a new definition needs. `tolerance` defaults to `DEFAULT_MATH_GEOMETRY_TOLERANCE` (Q5=T1) when omitted. */
export interface MathGeometryDefinitionInput {
  readonly name: string;
  readonly quantity: MathGeometryQuantity;
  readonly tolerance?: MathGeometryTolerance;
}

/**
 * Every way one of this file's commands can refuse. Name issues are `MathGeometryNameIssue` verbatim
 * (GR-01's `checkMathGeometryName`, reused rather than re-derived). The rest are specific to this file:
 * - `duplicateId`: `newId` already names a definition in this document (`addMathGeometryDefinition`).
 * - `notFound`: no definition with that ID (every other command).
 * - `kindMismatch`: a re-select changed the quantity's `kind` (`replaceMathGeometryQuantity`). §4(a)'s
 *   row only ever offers a same-kind re-select, but this function is the actual gate (NFR-UX-5).
 * - `unitMismatch`: a re-select kept the `kind` but changed an angle's `unit` (`replaceMathGeometryQuantity`).
 * - `notAngle`: an angle-unit edit on a definition whose quantity carries no unit (`setMathGeometryAngleUnit`).
 * - `inUse`: a delete on a definition some coefficient/configuration/unresolved problem still references
 *   (`removeMathGeometryDefinition`); GR-01's `mathGeometryUsage` names them in the message.
 * - `invalidTolerance`: outside the range shared with `measure/mathGeometry.ts`'s request validation and
 *   io's `readMathGeometry` (`addMathGeometryDefinition` with an explicit `tolerance`, `setMathGeometryTolerance`).
 *   The message names the offending field (`validateMathGeometryTolerance`); the code is the same for both.
 */
export type MathGeometryDefinitionReason = MathGeometryNameIssue
  | 'duplicateId' | 'notFound' | 'kindMismatch' | 'unitMismatch' | 'notAngle' | 'inUse' | 'invalidTolerance';

export type MathGeometryDefinitionResult =
  | { readonly ok: true; readonly document: PartDocument }
  | { readonly ok: false; readonly reason: MathGeometryDefinitionReason; readonly message: string };

function refuse(reason: MathGeometryDefinitionReason, message: string): MathGeometryDefinitionResult {
  return { ok: false, reason, message };
}

/** `checkMathGeometryName`'s codes have no Japanese text of their own (`packages/ui` owns `parameter.error.*`); this file needs one anyway (see the module doc), so it maps each code once, here. */
function nameIssueMessage(issue: MathGeometryNameIssue): string {
  switch (issue) {
    case 'empty': return '名前を入れてください。';
    case 'startsWithDigit': return '名前を数字で始めることはできません。';
    case 'reserved': return 'この名前は計算に使う言葉のため使えません。';
    case 'invalidCharacter': return '名前に使えない文字が含まれています。';
    case 'lengthUnitName': return 'この名前は長さの単位と紛らわしいため使えません。';
    case 'duplicateName': return 'この名前は既に使われています。';
    case 'tooLong': return '名前が長すぎます。';
    case 'whitespace': return '名前の前後に空白を含めることはできません。';
  }
}

/** The refusal for an unknown definition ID. Exported so every command that looks a definition up by ID says it the same way (GR-03b's `mathGeometryParameterDraft` reuses it). */
export const MATH_GEOMETRY_NOT_FOUND_MESSAGE = '指定した図形の測定値が見つかりません。';

/** A field of `MathGeometryTolerance` (`linearMm` / `angularRadians`), as the screen's two tolerance fields name them (Q5=T3). */
export type MathGeometryToleranceField = 'linear' | 'angular';

/**
 * The field of `tolerance` that breaks the rule, or `null` when both fields are valid (GR-03b). The rule is
 * the one `measure/mathGeometry.ts`'s `evaluateMathGeometry` enforces on every request (its local `valid`
 * check) and `packages/io/src/pcad/codecs/mathGeometry.ts`'s `readMathGeometry` enforces on every saved
 * definition, unchanged: `linearMm` is finite and strictly positive; `angularRadians` is finite, strictly
 * positive and strictly below `Math.PI / 4` (45°). Lines are compared unoriented within 0〜90°, so a margin of
 * 45° or more would let one pair of lines count as parallel and perpendicular at the same time.
 *
 * The length field is checked first: when both fields are wrong, `'linear'` (the first field) is reported.
 * The screen converts its degree input to radians before calling this (GR-19a), so the rule is never
 * restated in `packages/ui`. `mathGeometryTypes.ts` holds only the `MathGeometryTolerance` shape, model
 * cannot import io (dependency direction), and `mathGeometry.ts` keeps its check private, so this is the
 * model's one exported form of the rule.
 */
export function validateMathGeometryTolerance(tolerance: MathGeometryTolerance): MathGeometryToleranceField | null {
  const linearValid = Number.isFinite(tolerance.linearMm) && tolerance.linearMm > 0;
  if (!linearValid) return 'linear';
  const angularValid = Number.isFinite(tolerance.angularRadians) && tolerance.angularRadians > 0
    && tolerance.angularRadians < Math.PI / 4;
  return angularValid ? null : 'angular';
}

/**
 * Appendix C's sentence per field (GR-03b). It replaces GR-03's single sentence, which gave 90° as the
 * angle limit where the rule has always been 45° (plan §7 #21). The reason code stays `invalidTolerance`.
 * The screen shows its own text per field (`mathGeometry.tolerance.error.linear` / `.angular`), not these.
 */
const INVALID_TOLERANCE_MESSAGES: Readonly<Record<MathGeometryToleranceField, string>> = {
  linear: '長さの比べる幅は0より大きい有限の数にしてください。',
  angular: '角度の比べる幅は0より大きく45度より小さい数にしてください。',
};

/** `invalidTolerance` with the offending field's sentence, or `null` when `tolerance` is valid. */
function toleranceRefusal(tolerance: MathGeometryTolerance): MathGeometryDefinitionResult | null {
  const field = validateMathGeometryTolerance(tolerance);
  return field === null ? null : refuse('invalidTolerance', INVALID_TOLERANCE_MESSAGES[field]);
}

function sameTolerance(a: MathGeometryTolerance, b: MathGeometryTolerance): boolean {
  return a.linearMm === b.linearMm && a.angularRadians === b.angularRadians;
}

/** `document.mathGeometry`'s index of `id`, or -1. A tiny helper so every command spells this the same way. */
function indexOf(document: PartDocument, id: string): number {
  return (document.mathGeometry ?? []).findIndex((definition) => definition.id === id);
}

/**
 * Adds a definition built from `input` under `newId` (minted by the caller — `crypto.randomUUID()` from
 * the UI, per §4(e)'s identifier contract; this function only guards against an already-issued ID, it
 * does not mint one). Refuses a name `checkMathGeometryName` rejects, an already-used `newId`, or an
 * explicit `tolerance` that `validateMathGeometryTolerance` rejects. Omitting `tolerance` always succeeds
 * (name/id permitting) — `DEFAULT_MATH_GEOMETRY_TOLERANCE` (Q5=T1) is valid by construction.
 */
export function addMathGeometryDefinition(
  document: PartDocument,
  input: MathGeometryDefinitionInput,
  newId: string,
): MathGeometryDefinitionResult {
  if (indexOf(document, newId) !== -1) return refuse('duplicateId', '同じ識別番号の図形の測定値が既にあります。');
  const nameIssue = checkMathGeometryName(document, input.name);
  if (nameIssue !== null) return refuse(nameIssue, nameIssueMessage(nameIssue));
  const refusal = input.tolerance === undefined ? null : toleranceRefusal(input.tolerance);
  if (refusal !== null) return refusal;
  const tolerance = input.tolerance ?? DEFAULT_MATH_GEOMETRY_TOLERANCE;
  const definition: MathGeometryDefinition = { id: newId, documentId: document.id, name: input.name, quantity: input.quantity, tolerance };
  return { ok: true, document: { ...document, mathGeometry: [...(document.mathGeometry ?? []), definition] } };
}

/** A quantity with an explicit angular unit; new angle kinds are included structurally. */
export type MathGeometryAngleQuantity = Extract<MathGeometryQuantity, { readonly unit: 'degree' | 'radian' }>;

export function isMathGeometryAngleQuantity(quantity: MathGeometryQuantity): quantity is MathGeometryAngleQuantity {
  return 'unit' in quantity && (quantity.unit === 'degree' || quantity.unit === 'radian');
}

/** The definition's angular unit, or null for quantities that do not measure an angle. */
export function mathGeometryAngleUnitOf(quantity: MathGeometryQuantity): 'degree' | 'radian' | null {
  return isMathGeometryAngleQuantity(quantity) ? quantity.unit : null;
}

/**
 * Re-selects what `id` measures. §4(a)'s row only offers this when the current selection yields the same
 * `quantity.kind` (and, for an angle, the same `unit`) as the existing definition, but this function is
 * the actual gate: it refuses `kindMismatch`/`unitMismatch` itself rather than trusting the caller. The
 * definition's `id`, `name` and `tolerance` are always kept (only `quantity` changes) — per R23/§4(a)'s
 * "識別番号・名前・比べる幅は保つ".
 */
export function replaceMathGeometryQuantity(document: PartDocument, id: string, quantity: MathGeometryQuantity): MathGeometryDefinitionResult {
  const index = indexOf(document, id);
  if (index === -1) return refuse('notFound', MATH_GEOMETRY_NOT_FOUND_MESSAGE);
  const existing = (document.mathGeometry ?? [])[index];
  if (existing.quantity.kind !== quantity.kind) return refuse('kindMismatch', '選び直しでは、同じ種類の量だけを選べます。');
  if (mathGeometryAngleUnitOf(existing.quantity) !== mathGeometryAngleUnitOf(quantity)) {
    return refuse('unitMismatch', '選び直しでは、角度の単位が同じ量だけを選べます。');
  }
  const next = [...(document.mathGeometry ?? [])];
  next[index] = { ...existing, quantity };
  return { ok: true, document: { ...document, mathGeometry: next } };
}

/**
 * Toggles an angle definition's display unit (度/ラジアン, §4(a)). Quantities without an angular unit
 * refuse `notAngle`. Setting the unit already in effect is a
 * no-op that returns `document` by the same reference (no pointless recomputation; mirrors
 * `part/configurations.ts`'s "nothing changed → same document" convention).
 */
export function setMathGeometryAngleUnit(document: PartDocument, id: string, unit: 'degree' | 'radian'): MathGeometryDefinitionResult {
  const index = indexOf(document, id);
  if (index === -1) return refuse('notFound', MATH_GEOMETRY_NOT_FOUND_MESSAGE);
  const existing = (document.mathGeometry ?? [])[index];
  if (!isMathGeometryAngleQuantity(existing.quantity)) return refuse('notAngle', '角度の単位は、角度を測る定義にだけ設定できます。');
  if (existing.quantity.unit === unit) return { ok: true, document };
  const next = [...(document.mathGeometry ?? [])];
  next[index] = { ...existing, quantity: { ...existing.quantity, unit } };
  return { ok: true, document: { ...document, mathGeometry: next } };
}

/**
 * Changes `id`'s comparison margin (Q5=T3's per-definition edit). Refuses `invalidTolerance` under the
 * same rule `addMathGeometryDefinition` checks an explicit tolerance against (`validateMathGeometryTolerance`),
 * with the offending field's sentence. Setting the same value already stored is a no-op that returns
 * `document` unchanged by reference.
 */
export function setMathGeometryTolerance(document: PartDocument, id: string, tolerance: MathGeometryTolerance): MathGeometryDefinitionResult {
  const index = indexOf(document, id);
  if (index === -1) return refuse('notFound', MATH_GEOMETRY_NOT_FOUND_MESSAGE);
  const refusal = toleranceRefusal(tolerance);
  if (refusal !== null) return refusal;
  const existing = (document.mathGeometry ?? [])[index];
  if (sameTolerance(existing.tolerance, tolerance)) return { ok: true, document };
  const next = [...(document.mathGeometry ?? [])];
  next[index] = { ...existing, tolerance };
  return { ok: true, document: { ...document, mathGeometry: next } };
}

/**
 * Removes definition `id`, refusing `inUse` (naming every referencing coefficient/configuration/unresolved
 * problem, via GR-01's `mathGeometryUsage`) rather than deleting out from under a live reference — R23,
 * NFR-UX-5, and the same "先にそちらを直してください" shape §4(a)/付録B use for the screen's own message.
 */
export function removeMathGeometryDefinition(document: PartDocument, id: string): MathGeometryDefinitionResult {
  if (indexOf(document, id) === -1) return refuse('notFound', MATH_GEOMETRY_NOT_FOUND_MESSAGE);
  const usage = mathGeometryUsage(document).get(id);
  if (usage !== undefined) {
    const names = [...usage.parameterNames, ...usage.configurationNames, ...usage.unresolvedProblemNames];
    return refuse('inUse', `この測定値は${names.join('、')}で使われています。先にそちらを直してください。`);
  }
  return { ok: true, document: { ...document, mathGeometry: (document.mathGeometry ?? []).filter((definition) => definition.id !== id) } };
}
