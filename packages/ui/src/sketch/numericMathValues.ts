import { bindMathCompositionNames, collectMathCoefficients, collectVariableNames, evaluateExpression, type EvaluateOptions, type ExpressionError, type ExpressionResult, type ExpressionValue } from '@pointercad/expression';
import { MathInputProblem, type StoredMathExpression } from '@pointercad/expression/math/contracts';
import { mathGeometryDerivedParameters, type PartDocument } from '@pointercad/model';
import { t } from '../i18n/t.js';

interface PendingFieldContext {
  readonly document: PartDocument;
  readonly variables: ReadonlyMap<string, number>;
  readonly pendingVariables: ReadonlySet<string>;
}
const NO_PENDING_VARIABLES: ReadonlySet<string> = new Set();
let readPendingContext: () => PendingFieldContext | undefined = () => undefined;
/** propertyFieldUnits がストアの読取を登録する。設定・履歴の純関数からストアへの循環を防ぐ。 */
export function registerPendingFieldContext(read: () => PendingFieldContext): void { readPendingContext = read; }
export function pendingFieldContext(): PendingFieldContext | undefined { return readPendingContext(); }
/**
 * 式が計算待ちの係数名を参照しているか(GR-20)。単位の中の名前(`(w*2)in` の `w`)も数える。
 * 読めない式(構文の誤り)は参照なしとし、評価で誤りの理由をそのまま出させる。
 */
export function referencesPendingVariable(source: string, pending: ReadonlySet<string>, definition?: StoredMathExpression): boolean {
  if (pending.size === 0) return false;
  if (definition !== undefined) {
    try {
      return collectMathCoefficients(definition.expression).some(reference => pending.has(reference.label));
    } catch (error) {
      if (!(error instanceof MathInputProblem)) throw error;
      // 壊れた数式は呼出し側の通常の検証に任せる。
      return false;
    }
  }
  return collectVariableNames(source).some((name) => pending.has(name));
}

/** 既存の error の受け渡しでも失われない、計算待ちの印。通常の誤りの形は変えない。 */
export type PendingFieldError = ExpressionError & { readonly pending: true };
export function isPendingFieldError(error: ExpressionError | null): error is PendingFieldError {
  return error !== null && 'pending' in error && error.pending === true;
}
export function pendingFieldResult(): { readonly ok: false; readonly error: PendingFieldError } {
  return { ok: false, error: { code: 'unknownVariable', message: t('mathGeometry.status.pending'), position: -1, pending: true } };
}

/** 既存の評価入口には現在の変数表と同一のときだけ計算待ちを補う。他文書の評価へ混ぜない。 */
export function pendingVariablesFor(variables: ReadonlyMap<string, number> | undefined): ReadonlySet<string> {
  const context = pendingFieldContext();
  return context !== undefined && variables === context.variables ? context.pendingVariables : NO_PENDING_VARIABLES;
}


/** 単位を整えた式の共通評価。UI の evaluateFieldSource とその場入力から使う。 */
export function evaluatePendingExpression(source: string, options: EvaluateOptions, pending: ReadonlySet<string>): ExpressionResult {
  return referencesPendingVariable(source, pending) ? pendingFieldResult() : evaluateExpression(source, options);
}


interface CoefficientValue { readonly id: string; readonly label: string; readonly decimal: string }
interface MathInputScope {
  readonly value: ExpressionValue;
  readonly documentId: string;
  readonly parameters: PartDocument['parameters'];
  readonly serial: number;
  readonly coefficients: readonly CoefficientValue[];
}
const scopes = new WeakMap<StoredMathExpression, MathInputScope>();
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value); for (const child of Object.values(value)) freeze(child);
}

/** Only the dialog's verified finite-real result enters this transient registry. Files never do. */
export function acceptNumericMath(value: ExpressionValue, prepared: PartDocument,
  coefficients: readonly CoefficientValue[]): ExpressionValue {
  if (value.mathDefinition === undefined || value.source !== value.mathDefinition.source || !Number.isFinite(value.value)) {
    throw new Error('数式の評価結果を確認してください。');
  }
  const context = pendingFieldContext();
  if (context !== undefined && prepared.id === context.document.id && context.pendingVariables.size > 0) {
    // 数式ダイアログの prepared は識別番号を補った文書。別文書の同名係数へ待機を混ぜない。
    const derived = mathGeometryDerivedParameters(prepared.parameters);
    const pending = new Set([...context.pendingVariables].filter(name => derived.has(name)));
    if (referencesPendingVariable(value.source, pending, value.mathDefinition)) throw new Error(pendingFieldResult().error.message);
  }
  const copy = structuredClone(value);
  const definition = copy.mathDefinition;
  if (definition === undefined) throw new Error('数式の定義がありません。');
  const references = collectMathCoefficients(definition.expression);
  const used = references.map(reference => {
    const coefficient = coefficients.find(item => item.id === reference.id && item.label === reference.label);
    if (coefficient === undefined) throw new Error('数式の係数を再確認してください。');
    return { ...coefficient };
  });
  const scope: MathInputScope = { value: copy, documentId: prepared.id,
    parameters: structuredClone(prepared.parameters), serial: prepared.mathParameterSerial ?? 0, coefficients: used };
  bindMathCompositionNames(copy, prepared.parameters.flatMap(parameter => parameter.mathId === undefined ? [] : [{
    id: parameter.mathId, label: parameter.name, kind: parameter.unit === 'mm' ? 'length' : parameter.unit === 'degree' ? 'angle' : 'scalar',
  }]));
  freeze(scope); scopes.set(definition, scope); return copy;
}

export function evaluateNumericMath(value: ExpressionValue, variables: ReadonlyMap<string, number>,
  exactVariables?: ReadonlyMap<string, string>, pending: ReadonlySet<string> = pendingVariablesFor(variables)): ExpressionResult {
  if (referencesPendingVariable(value.source, pending, value.mathDefinition)) return pendingFieldResult();
  const scope = value.mathDefinition === undefined ? undefined : scopes.get(value.mathDefinition);
  if (scope === undefined || scope.value.source !== value.source || scope.value.value !== value.value
      || scope.coefficients.some(item => exactVariables?.get(item.label) !== item.decimal || variables.get(item.label) !== Number(item.decimal))) {
    return { ok: false, error: { code: 'unknownVariable', position: -1,
      message: '数式の係数が変わりました。「数式で入力」で確認してから決定してください。' } };
  }
  return { ok: true, value: scope.value };
}

/** Publish parameter identities only with an actual accepted geometry change, in the same Undo entry. */
export function prepareNumericMathCommit(current: PartDocument, inputs: unknown):
  { readonly ok: true; readonly document: PartDocument } | { readonly ok: false; readonly message: string } {
  const context = pendingFieldContext();
  const pendingVariables = current === context?.document ? context.pendingVariables : NO_PENDING_VARIABLES;
  const used = new Set<MathInputScope>();
  let invalid = false;
  const seen = new Set<object>(), pending: unknown[] = [inputs];
  while (pending.length > 0 && !invalid) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 20_000) { invalid = true; break; }
    if ('mathDefinition' in value && value.mathDefinition !== undefined) {
      const definition: unknown = value.mathDefinition;
      const scope = definition !== null && typeof definition === 'object' ? scopes.get(definition as StoredMathExpression) : undefined;
      if (scope === undefined || !('source' in value) || scope.value.source !== value.source
          || !('value' in value) || scope.value.value !== value.value) invalid = true;
      else {
        if (referencesPendingVariable(scope.value.source, pendingVariables, scope.value.mathDefinition)) {
          return { ok: false, message: pendingFieldResult().error.message };
        }
        used.add(scope);
      }
    } else {
      const children: unknown[] = Object.values(value);
      pending.push(...children);
    }
  }
  let parameters = current.parameters, serial = current.mathParameterSerial ?? 0;
  for (const scope of used) {
    if (scope.documentId !== current.id || scope.parameters.length !== current.parameters.length) { invalid = true; break; }
    for (let index = 0; index < parameters.length; index++) {
      const expected = scope.parameters[index], actual = parameters[index];
      if (expected === undefined || actual === undefined || expected.name !== actual.name || expected.unit !== actual.unit
        || JSON.stringify(expected.value) !== JSON.stringify(actual.value)
        || (actual.mathId !== undefined && actual.mathId !== expected.mathId)) { invalid = true; break; }
    }
    if (invalid) break;
    parameters = parameters.map((parameter, index) => ({ ...parameter, mathId: scope.parameters[index].mathId }));
    serial = Math.max(serial, scope.serial);
  }
  if (invalid) return { ok: false, message: '数式の参照先が変わりました。「数式で入力」で確認してから決定してください。' };
  return { ok: true, document: used.size === 0 ? current : { ...current, parameters, mathParameterSerial: serial } };
}
