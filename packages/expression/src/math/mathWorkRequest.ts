/** Validate and detach requests before they wait in the math queue or cross into its Worker. */
import { MATH_INPUT_LIMITS, MathInputProblem, validateMathSource, validateMathDecimal, hasMathControlCharacters, type StoredMathExpression } from './mathInputContract.js';
import { decodeStoredMathStructure } from './decodeStoredMath.js';
import { decodeCoefficientExpression, type MathCoefficientValue } from './mathCoefficientExpression.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { decodeMathVariableScope, assertMathVariableScope, type MathVariableScope } from './mathVariableScope.js';

export interface MathRequestIdentity {
  readonly documentId:string;readonly documentVersion:number;readonly editorId:string;readonly inputRevision:number;
}
export interface MathWorkRequest {
  readonly identity:MathRequestIdentity;readonly source:string;readonly notation:'text'|'latex';
  readonly angleUnit:'degree'|'radian';
  readonly coefficients:readonly MathCoefficientValue[];
  /** Present only while editing a function definition. It never authorizes adopting a scalar coordinate. */
  readonly functionScope?: MathVariableScope;
  /** Re-evaluation verifies this definition against source before using current coefficient values. */
  readonly definition?:StoredMathExpression;
  /** Explicit presentation conversion; the original request and definition keep their own notation. */
  readonly presentationNotation?: 'text' | 'latex';
  /** Rewrite one coefficient label by stable ID, preserving notation. This request never produces a coordinate. */
  readonly renameCoefficient?: { readonly id: string; readonly label: string };
}

export interface MathWorkEnvelope {
  readonly kind:'evaluate-math';readonly serial:number;readonly request:MathWorkRequest;
}
/** Both sender and receiver use this envelope contract; accepting only its payload is insufficient. */
export function decodeMathWorkEnvelope(value:unknown):MathWorkEnvelope {
  const raw=record(value,['kind','serial','request']);
  if(raw.kind!=='evaluate-math'||typeof raw.serial!=='number'||!Number.isSafeInteger(raw.serial)||raw.serial<1) {
    throw new MathInputProblem('syntax','数式の依頼番号または種類を確認できません。');
  }
  return Object.freeze({kind:'evaluate-math',serial:raw.serial,request:decodeMathWorkRequest(raw.request)});
}
export function createMathWorkEnvelope(serial:number,request:MathWorkRequest):MathWorkEnvelope {
  return decodeMathWorkEnvelope({kind:'evaluate-math',serial,request});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw new MathInputProblem('syntax', '数式の依頼形式が不正です。');
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) throw new MathInputProblem('syntax', '数式の依頼項目が不正です。');
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || hasMathControlCharacters(value)) {
    throw new MathInputProblem('syntax', '数式の名前または識別子が不正です。');
  }
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MathInputProblem('syntax', '数式の編集番号が不正です。');
  return value;
}
export function decodeMathRequestIdentity(value: unknown): MathRequestIdentity {
  const raw = record(value, ['documentId', 'documentVersion', 'editorId', 'inputRevision']);
  return Object.freeze({ documentId: name(raw.documentId), documentVersion: revision(raw.documentVersion),
    editorId: name(raw.editorId), inputRevision: revision(raw.inputRevision) });
}
/** Scalar fields and function geometry share one detached coefficient-value contract. */
export function decodeMathCoefficientValues(value: unknown): MathWorkRequest['coefficients'] {
  if (!Array.isArray(value) || value.length > 256) throw new MathInputProblem('budget', '係数が多すぎます。');
  const ids = new Set<string>(), names = new Set<string>();
  let remaining = MATH_INPUT_LIMITS.nodes;
  const spend = (): void => { if (--remaining < 0) throw new MathInputProblem('budget', '係数の原式の合計が大きすぎます。'); };
  return Object.freeze(value.map((value: unknown) => {
    const entry = record(value, ['id', 'label', 'decimal'], ['exactExpression']);
    const id = name(entry.id), label = name(entry.label);
    if (ids.has(id) || names.has(label)) throw new MathInputProblem('syntax', '係数の識別子または名前が重複しています。');
    if (typeof entry.decimal !== 'string') throw new MathInputProblem('syntax', '係数の数値形式が不正です。');
    validateMathDecimal(entry.decimal);
    ids.add(id); names.add(label);
    const exactExpression = Object.hasOwn(entry, 'exactExpression') ? decodeCoefficientExpression(entry.exactExpression, spend) : undefined;
    return Object.freeze({ id, label, decimal: entry.decimal, ...(exactExpression === undefined ? {} : { exactExpression }) });
  }));
}
export function decodeMathWorkRequest(value: unknown): MathWorkRequest {
  const raw = record(value, ['identity', 'source', 'notation', 'angleUnit', 'coefficients'], ['definition', 'presentationNotation', 'renameCoefficient', 'functionScope']);
  if (typeof raw.source !== 'string' || (raw.notation !== 'text' && raw.notation !== 'latex')
    || (raw.angleUnit !== 'degree' && raw.angleUnit !== 'radian')) throw new MathInputProblem('syntax', '数式の入力設定が不正です。');
  validateMathSource(raw.source);
  if (Object.hasOwn(raw, 'presentationNotation') && raw.presentationNotation !== 'text' && raw.presentationNotation !== 'latex') {
    throw new MathInputProblem('syntax', '数式の変換先を指定してください。');
  }
  const coefficients = decodeMathCoefficientValues(raw.coefficients);
  const functionScope = Object.hasOwn(raw, 'functionScope') ? decodeMathVariableScope(raw.functionScope) : undefined;
  const ids = new Set(coefficients.map(coefficient => coefficient.id));
  let definition: StoredMathExpression | undefined;
  if (Object.hasOwn(raw, 'definition')) {
    definition = decodeStoredMathStructure(raw.definition, {
      operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: ids, declaredIds: new Set(),
    });
    if (definition.source !== raw.source || definition.inputNotation !== raw.notation || definition.angleUnit !== raw.angleUnit) {
      throw new MathInputProblem('syntax', '再計算する数式と入力設定が一致しません。');
    }
    if (functionScope !== undefined) assertMathVariableScope(definition.expression, functionScope);
    // The decoder has bounded and cloned every AST node. Freeze that private tree, never caller objects.
    const pending: object[] = [definition];
    while (pending.length > 0) {
      const item = pending.pop();
      if (!item) break;
      const children: readonly unknown[] = Object.values(item);
      for (const child of children) if (child !== null && typeof child === 'object') pending.push(child);
      Object.freeze(item);
    }
  }
  let renameCoefficient: MathWorkRequest['renameCoefficient'];
  if (Object.hasOwn(raw, 'renameCoefficient')) {
    const entry = record(raw.renameCoefficient, ['id', 'label']);
    const id = name(entry.id), label = name(entry.label);
    if (definition === undefined || raw.presentationNotation !== undefined || !ids.has(id)
      || label.trim() !== label || coefficients.some(coefficient => coefficient.id !== id && coefficient.label === label)) {
      throw new MathInputProblem('syntax', '改名する係数と新しい名前を確認してください。');
    }
    renameCoefficient = Object.freeze({ id, label });
  }
  return Object.freeze({ identity: decodeMathRequestIdentity(raw.identity), source: raw.source,
    notation: raw.notation, angleUnit: raw.angleUnit, coefficients: Object.freeze(coefficients),
    ...(functionScope === undefined ? {} : { functionScope }),
    ...(definition === undefined ? {} : { definition }),
    ...(renameCoefficient === undefined ? {} : { renameCoefficient }),
    ...(raw.presentationNotation === 'text' || raw.presentationNotation === 'latex' ? { presentationNotation: raw.presentationNotation } : {}) });
}
