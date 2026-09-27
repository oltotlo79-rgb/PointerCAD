/**
 * One place for every math-geometry identity concern (GR-01, `scratchpad/claude/plans/geomref-plan.md`
 * §5.2 GR-01): the coefficient-ID namespace, the shared name-collision rule, the default comparison
 * tolerance (Q5=T1), extracting `coef("name")` references out of a stored expression, finding where a
 * definition is used, and branching on a quantity's kind to list what it targets. GR-09〜GR-11 add new
 * quantity kinds later; they extend `mathGeometryTargetsOf` here instead of re-deriving the same switch
 * elsewhere (§5.2 GR-01, §4(d)).
 */
import { collectMathCoefficients, type StoredMathExpression } from '@pointercad/expression';
import { checkNewParameterName, type NewParameterNameIssue } from '../parameters/parameterTable.js';
import type { PartDocument } from '../part/types.js';
import type {
  MathGeometryCurve,
  MathGeometryFrame,
  MathGeometryPoint,
  MathGeometryQuantity,
  MathGeometryShape,
  MathGeometryTolerance,
} from './mathGeometryTypes.js';

/* ---------------------------------------------------------------------------
 * Coefficient-ID namespace (R61, R22): every math-geometry definition is referenced from a formula
 * the same way a parameter is (`coef(id, label)`), but its ID lives in its own prefixed sub-namespace
 * so it can never collide with a `coefficient:N` parameter ID or a `math-problem:…` unresolved ID.
 * ------------------------------------------------------------------------- */

/** Every math-geometry coefficient ID starts with this. */
export const MATH_GEOMETRY_COEFFICIENT_PREFIX = 'math-geometry:';

/** The coefficient ID a definition is referenced by from inside `coef("name")` (§4(e)). */
export function mathGeometryCoefficientId(definitionId: string): string {
  return `${MATH_GEOMETRY_COEFFICIENT_PREFIX}${definitionId}`;
}

/**
 * The inverse of `mathGeometryCoefficientId`. Any other prefix (a parameter's `coefficient:N`, an
 * unresolved problem's `math-problem:…`, or anything else) is not ours and returns `null`, and so does
 * an empty definition ID (the prefix with nothing after it can never have been issued by us).
 */
export function mathGeometryDefinitionIdOf(coefficientId: string): string | null {
  if (!coefficientId.startsWith(MATH_GEOMETRY_COEFFICIENT_PREFIX)) return null;
  const definitionId = coefficientId.slice(MATH_GEOMETRY_COEFFICIENT_PREFIX.length);
  return definitionId.length > 0 ? definitionId : null;
}

/* ---------------------------------------------------------------------------
 * Default comparison tolerance (Q5=T1, `docs/standards/math-runtime.md` R70)
 * ------------------------------------------------------------------------- */

/**
 * Q5=T1: a display-only comparison margin for parallel/perpendicular-style judgments, matching the
 * existing measurement tools' own margin (`solid/measure.ts`, `solid/measureCommands.ts`). This is
 * **not** a certified arithmetic error bound (R70, rules §10.309) — never fed into
 * `approximation.absoluteError` or similar.
 */
export const DEFAULT_MATH_GEOMETRY_TOLERANCE: MathGeometryTolerance = Object.freeze({
  linearMm: 1e-6,
  angularRadians: 1e-6,
});

/* ---------------------------------------------------------------------------
 * Name rule (R23, R61): definitions share one label namespace with parameters, because `coef(id,
 * label)` resolves either kind of coefficient by the same lookup. Two different IDs must never carry
 * the same label, so a new/renamed name is checked against both parameters and every other definition.
 * ------------------------------------------------------------------------- */

/** The longest name a math-geometry definition may have (matches `UnresolvedMathProblem.name`). */
export const MATH_GEOMETRY_NAME_MAX_LENGTH = 128;

/** `checkNewParameterName`'s reasons, plus the ways this shared name namespace can already be taken. */
export type MathGeometryNameIssue = NewParameterNameIssue | 'duplicateName' | 'tooLong' | 'whitespace';

/**
 * Can `name` become a math-geometry definition's name — either a brand new definition, or renaming
 * the definition `exceptId` (excluded from the duplicate check so renaming to its own current name is
 * never rejected as a duplicate of itself)?
 *
 * The identifier syntax itself (empty / starts with digit / reserved word / invalid character / a
 * length-unit spelling) is `checkNewParameterName`'s job, reused unchanged so both namespaces stay
 * governed by exactly one rule (R24). This adds what parameter names do not need on top of it: a
 * 128-character limit and a rejection of leading/trailing whitespace (both already unreachable through
 * `checkNewParameterName`'s character-by-character check for anything but length, so they are checked
 * first here to produce a more specific reason than `invalidCharacter`), and the duplicate check against
 * both other definitions and every parameter (one shared label space).
 */
export function checkMathGeometryName(
  document: PartDocument,
  name: string,
  exceptId?: string,
): MathGeometryNameIssue | null {
  if (name !== name.trim()) return 'whitespace';
  if (name.length > MATH_GEOMETRY_NAME_MAX_LENGTH) return 'tooLong';
  const parameterIssue = checkNewParameterName(name);
  if (parameterIssue !== null) return parameterIssue;
  if (document.parameters.some((parameter) => parameter.name === name)) return 'duplicateName';
  if ((document.mathGeometry ?? []).some((definition) => definition.id !== exceptId && definition.name === name)) {
    return 'duplicateName';
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Reference extraction (Q2=U1, Q3=V1): a math-geometry value is only ever read from inside a `coef(id,
 * label)` node embedded in a coefficient's current value, a configuration's per-parameter override, or
 * an unresolved problem — the only three surfaces Q2=U1 allows.
 * ------------------------------------------------------------------------- */

/** One `coef(id, label)` reference inside a stored expression that points at a math-geometry definition. */
export interface MathGeometryCoefficientReference {
  /** The full coefficient ID as stored in the expression (`math-geometry:` + `definitionId`). */
  readonly coefficientId: string;
  /** The math-geometry definition's own ID (the coefficient ID with the prefix removed). */
  readonly definitionId: string;
  /** The label exactly as stored at the reference site — may be stale; see the note below. */
  readonly label: string;
}

/**
 * The math-geometry references inside one stored expression, extracted through `collectMathCoefficients`
 * (which already de-duplicates by ID within one expression) and filtered down to the ones whose ID
 * carries our prefix.
 *
 * The returned `label` is whatever was last saved at the reference site; it is not compared against the
 * definition's current `name` here. A stale label (after some other edit renamed the definition without
 * rewriting this particular reference) is still resolved correctly by ID — telling stale from current is
 * the caller's job once it also has `document.mathGeometry` in hand (GR-02's dependency analysis).
 */
export function mathGeometryReferencesOf(
  definition: StoredMathExpression,
): readonly MathGeometryCoefficientReference[] {
  const references: MathGeometryCoefficientReference[] = [];
  for (const reference of collectMathCoefficients(definition.expression)) {
    const definitionId = mathGeometryDefinitionIdOf(reference.id);
    if (definitionId !== null) {
      references.push({ coefficientId: reference.id, definitionId, label: reference.label });
    }
  }
  return references;
}

/**
 * Where a math-geometry definition is used, by name, so a refusal can name every place to fix first
 * (R23, NFR-UX-5; consumed by GR-16's delete guard). Each list only ever contains a name once, even when
 * more than one expression belonging to the same parameter/configuration/problem references the
 * definition, or the same expression does so more than once.
 */
export interface MathGeometryUsage {
  readonly parameterNames: readonly string[];
  readonly configurationNames: readonly string[];
  readonly unresolvedProblemNames: readonly string[];
}

/** No usage found for a definition ID — one frozen, shared instance instead of allocating per lookup. */
export const EMPTY_MATH_GEOMETRY_USAGE: MathGeometryUsage = Object.freeze({
  parameterNames: [],
  configurationNames: [],
  unresolvedProblemNames: [],
});

/**
 * Definition ID → the coefficient names, configuration names, and unresolved-problem names whose stored
 * expression references it. Walks exactly the three surfaces `mathGeometryReferencesOf` documents
 * (parameters' current values, every configuration's overrides, every unresolved problem) and nothing
 * else — a geometry reference cannot appear anywhere other than inside a `coef` reference on one of
 * these (Q2=U1).
 *
 * The active configuration is skipped in the second surface, matching `parameterUsageCounts`
 * (`packages/ui/src/parameters/parameterCommands.ts`) — `part/configurations.ts`'s
 * `synchronizeConfigurations` always keeps the active configuration's `mathDefinitions` a byte-for-byte
 * mirror of the live `document.parameters` values, so counting it too would double-count the exact same
 * reference already recorded above by the parameter's own current value (GR-19c: the panel showed "2
 * か所" — the parameter plus the active configuration's copy of the same formula — for one real usage).
 * A non-active configuration keeps its own, potentially different, formula and is still counted.
 *
 * A definition with no usage is simply absent from the map; callers read `.get(id) ??
 * EMPTY_MATH_GEOMETRY_USAGE` rather than expect a zero-length entry for every known ID.
 */
export function mathGeometryUsage(document: PartDocument): ReadonlyMap<string, MathGeometryUsage> {
  const parameterNames = new Map<string, string[]>();
  const configurationNames = new Map<string, string[]>();
  const unresolvedProblemNames = new Map<string, string[]>();
  const record = (target: Map<string, string[]>, definitionId: string, name: string): void => {
    const names = target.get(definitionId);
    if (names === undefined) target.set(definitionId, [name]);
    else if (!names.includes(name)) names.push(name);
  };
  for (const parameter of document.parameters) {
    if (parameter.value.mathDefinition === undefined) continue;
    for (const reference of mathGeometryReferencesOf(parameter.value.mathDefinition)) {
      record(parameterNames, reference.definitionId, parameter.name);
    }
  }
  for (const configuration of document.configurations) {
    if (configuration.id === document.activeConfigurationId) continue;
    for (const definition of Object.values(configuration.mathDefinitions ?? {})) {
      for (const reference of mathGeometryReferencesOf(definition)) {
        record(configurationNames, reference.definitionId, configuration.name);
      }
    }
  }
  for (const problem of document.unresolvedMathProblems ?? []) {
    for (const reference of mathGeometryReferencesOf(problem.definition)) {
      record(unresolvedProblemNames, reference.definitionId, problem.name);
    }
  }
  const ids = new Set<string>([...parameterNames.keys(), ...configurationNames.keys(), ...unresolvedProblemNames.keys()]);
  const usage = new Map<string, MathGeometryUsage>();
  for (const id of ids) {
    usage.set(id, {
      parameterNames: parameterNames.get(id) ?? [],
      configurationNames: configurationNames.get(id) ?? [],
      unresolvedProblemNames: unresolvedProblemNames.get(id) ?? [],
    });
  }
  return usage;
}

/* ---------------------------------------------------------------------------
 * Quantity targets (§4(d), §4(f)): the one place that branches on `MathGeometryQuantity['kind']` to
 * list what a quantity points at, so dependency analysis, re-select matching, and future quantity kinds
 * do not each re-derive the same switch.
 * ------------------------------------------------------------------------- */

/** The point/curve/shape/frame references used to measure a quantity. */
export type MathGeometryTarget = MathGeometryPoint | MathGeometryCurve | MathGeometryShape | MathGeometryFrame;

/**
 * `quantity`'s targets. `noImplicitReturns` (tsconfig.base.json) fails the build if a case is missing,
 * so when GR-09〜GR-11 add a kind to `MathGeometryQuantity` this switch must grow a matching case before
 * the package compiles — no caller can silently keep branching on the old, incomplete set of kinds.
 */
export function mathGeometryTargetsOf(quantity: MathGeometryQuantity): readonly MathGeometryTarget[] {
  switch (quantity.kind) {
    case 'coordinate':
      return quantity.frame === undefined ? [quantity.point] : [quantity.point, quantity.frame];
    case 'point-distance':
    case 'shape-distance':
    case 'angle':
    case 'plane-angle':
    case 'parallel':
    case 'perpendicular':
    case 'congruent':
    case 'similar':
      return [quantity.first, quantity.second];
    case 'line-plane-angle':
      return [quantity.line, quantity.plane];
    case 'point-angle':
      return [quantity.first, quantity.second, quantity.third];
    case 'length':
    case 'radius':
    case 'central-angle':
      return [quantity.curve];
    case 'contour-length':
      return [{ kind: 'sketch-curve', sketchId: quantity.sketchId, featureId: quantity.featureId }];
    case 'area':
      return [quantity.shape];
    case 'volume':
      return [quantity.body];
  }
}
