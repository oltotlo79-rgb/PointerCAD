/** Pure name resolution draft; the UI must insert explicit references for coefficients. */
import { MathInputProblem, hasMathControlCharacters, type MathAxis, type MathParameter, type MathSymbolReference,
  type MathNode } from './mathInputContract.js';

type BoundReference = Extract<MathSymbolReference, { readonly role: 'bound' }>;
type CoefficientReference = Extract<MathSymbolReference, { readonly role: 'coefficient' }>;
type DeclaredReference = Extract<MathSymbolReference, { readonly role: 'declared' }>;
type ConstantName = Extract<MathNode, { readonly kind: 'constant' }>['name'];

export interface MathNameContext {
  readonly axes: ReadonlySet<MathAxis>;
  readonly parameters: ReadonlySet<MathParameter>;
  readonly coefficients: readonly CoefficientReference[];
  readonly declared: readonly DeclaredReference[];
}

const CONSTANTS: ReadonlyMap<string, ConstantName> = new Map([
  ['Pi', 'pi'], ['ExponentialE', 'e'], ['ImaginaryUnit', 'imaginary-unit'],
  ['PositiveInfinity', 'infinity'], ['True', 'true'], ['False', 'false'],
  ['RealNumbers', 'real-numbers'], ['ComplexNumbers', 'complex-numbers'],
  ['Integers', 'integers'], ['NonNegativeIntegers', 'naturals'], ['RationalNumbers', 'rationals'],
  ['EmptySet', 'empty-set'],
]);
const TEXT_CONSTANTS: ReadonlyMap<string,ConstantName>=new Map([
  ['pi','pi'],['π','pi'],['e','e'],['i','imaginary-unit'],['ⅈ','imaginary-unit'],['∞','infinity'],
  ['true','true'],['false','false'],['ℝ','real-numbers'],['ℂ','complex-numbers'],['ℤ','integers'],
  ['ℕ','naturals'],['ℚ','rationals'],['∅','empty-set'],
]);

function axisOf(name: string): MathAxis | null {
  return name === 'X' || name === 'Y' || name === 'Z' ? name : null;
}
function parameterOf(name: string): MathParameter | null {
  return name === 'T' || name === 'U' || name === 'V' ? name : null;
}

/** Context validation is separate from expression parsing, so duplicates are never last-write-wins. */
function indexReferences<T extends CoefficientReference | DeclaredReference>(references: readonly T[]): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  const ids = new Set<string>();
  for (const reference of references) {
    if (reference.label.trim().length === 0 || reference.label.length > 128 || reference.id.length === 0
      || reference.id.length > 128 || hasMathControlCharacters(reference.label)) {
      throw new MathInputProblem('syntax', '名前と参照先の指定を確認してください。');
    }
    if (ids.has(reference.id) || result.has(reference.label)) {
      throw new MathInputProblem('syntax', `名前「${reference.label}」または参照先が重複しています。`);
    }
    ids.add(reference.id);
    result.set(reference.label, reference);
  }
  return result;
}

export class MathSymbolScope {
  private readonly coefficients: ReadonlyMap<string, CoefficientReference>;
  private readonly declared: ReadonlyMap<string, DeclaredReference>;
  private readonly frames: readonly ReadonlyMap<string, BoundReference>[];
  private readonly context: MathNameContext;
  constructor(
    context: MathNameContext,
    frames: readonly ReadonlyMap<string, BoundReference>[] = [],
  ) {
    this.context = context;
    this.coefficients = indexReferences(context.coefficients);
    this.declared = indexReferences(context.declared);
    this.frames = frames;
    for (const name of this.declared.keys()) {
      if (CONSTANTS.has(name) || TEXT_CONSTANTS.has(name) || axisOf(name) || parameterOf(name)) {
        throw new MathInputProblem('syntax', `「${name}」は軸・媒介変数・定数と異なる名前を指定してください。`);
      }
    }
  }

  coefficient(label: string): MathNode {
    const reference = this.coefficients.get(label);
    if (!reference) throw new MathInputProblem('syntax', `係数「${label}」を係数一覧へ登録してください。`);
    return { kind: 'symbol', reference };
  }

  /** Binding keys are assigned by the parser from the AST path, never from Date or random state. */
  bind(label: string, bindingKey: string): { scope: MathSymbolScope; variable: BoundReference } {
    if (label.length === 0 || label.length > 128 || CONSTANTS.has(label) || hasMathControlCharacters(label)) {
      throw new MathInputProblem('syntax', '積分や総和の変数を定数とは異なる記号で指定してください。');
    }
    if (!/^[0-9]+(?:\.[0-9]+)*$/u.test(bindingKey)) {
      throw new MathInputProblem('syntax', '束縛変数の位置を確認できません。');
    }
    // An explicit local declaration may shadow axis X or parameter T; its identity and UI scope remain distinct.
    const variable: BoundReference = { role: 'bound', id: `bound:${bindingKey}`, label };
    return { scope: new MathSymbolScope(this.context, [...this.frames, new Map([[label, variable]])]), variable };
  }

  resolve(name: string,notation:'text'|'engine'='engine'): MathNode {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const reference = this.frames[index]?.get(name);
      if (reference) return { kind: 'symbol', reference };
    }
    const constant = CONSTANTS.get(name)??(notation==='text'?TEXT_CONSTANTS.get(name):undefined);
    if (constant) return { kind: 'constant', name: constant };
    const axis = axisOf(name);
    if (axis) {
      if (!this.context.axes.has(axis)) throw new MathInputProblem('syntax', `この式では軸${axis}の値を指定してください。`);
      return { kind: 'symbol', reference: { role: 'axis', name: axis } };
    }
    const parameter = parameterOf(name);
    if (parameter) {
      if (!this.context.parameters.has(parameter)) throw new MathInputProblem('syntax', `この式では媒介変数${parameter}を使用しません。`);
      return { kind: 'symbol', reference: { role: 'parameter', name: parameter } };
    }
    const declared = this.declared.get(name);
    if (declared) return { kind: 'symbol', reference: declared };
    if (this.coefficients.has(name)) {
      throw new MathInputProblem('syntax', `係数「${name}」は係数一覧から挿入してください。`);
    }
    throw new MathInputProblem('syntax', `記号「${name}」の意味を指定してください。`);
  }
}

/** Engine symbols are opaque; names that resemble axes or constants cannot change the meaning. */
export function engineSymbolOf(reference: MathSymbolReference): string {
  switch (reference.role) {
    case 'axis': return `pcadAxis${reference.name}`;
    case 'parameter': return `pcadParameter${reference.name}`;
    case 'coefficient': return `pcadCoefficient${hexUtf16(reference.id)}`;
    case 'declared': return `pcadDeclared${hexUtf16(reference.id)}`;
    case 'bound': return `pcadBound${hexUtf16(reference.id)}`;
  }
}

function hexUtf16(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) result += value.charCodeAt(index).toString(16).padStart(4, '0');
  return result;
}
