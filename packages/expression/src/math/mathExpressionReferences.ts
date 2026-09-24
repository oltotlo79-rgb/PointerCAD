/** Shared coefficient traversal for dependencies and transactional renaming. Bound variables keep their identity. */
import { MATH_INPUT_LIMITS, MathInputProblem, hasMathControlCharacters,
  type MathNode, type MathSymbolReference, type StoredMathExpression } from './mathInputContract.js';
import { convertMathNotation } from './mathNotationConversion.js';
import { decodeMathDeclarations, referencedMathDeclarations } from './mathDeclarations.js';

type Coefficient = Extract<MathSymbolReference, { role: 'coefficient' }>;

export function mapMathSymbols(expression: MathNode, replace: (reference: MathSymbolReference) => MathNode): MathNode {
  let remaining = MATH_INPUT_LIMITS.nodes;
  function visit(node: MathNode, depth: number): MathNode {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '数式の参照が複雑すぎます。');
    if (node.kind === 'symbol') return replace(node.reference);
    if (node.kind === 'number' || node.kind === 'constant') return node;
    if (node.kind === 'operation') return { ...node, operands: node.operands.map(child => visit(child, depth + 1)) };
    return { ...node, bindings: node.bindings.map(binding => {
      const domain = binding.domain;
      if (domain.kind === 'unrestricted') return binding;
      if (domain.kind === 'set') return { ...binding, domain: { ...domain, value: visit(domain.value, depth + 1) } };
      return { ...binding, domain: { ...domain, lower: visit(domain.lower, depth + 1), upper: visit(domain.upper, depth + 1),
        step: domain.step === null ? null : visit(domain.step, depth + 1) } };
    }), body: visit(node.body, depth + 1) };
  }
  return visit(expression, 0);
}

export function mapMathCoefficients(expression: MathNode, replace: (reference: Coefficient) => Coefficient): MathNode {
  return mapMathSymbols(expression, reference => ({ kind: 'symbol',
    reference: reference.role === 'coefficient' ? replace(reference) : reference }));
}

export function collectMathCoefficients(expression: MathNode): readonly Coefficient[] {
  const references = new Map<string, Coefficient>();
  mapMathCoefficients(expression, reference => {
    const previous = references.get(reference.id);
    if (previous !== undefined && previous.label !== reference.label) throw new MathInputProblem('syntax', '同じ係数の参照名が一致しません。');
    references.set(reference.id, reference);
    return reference;
  });
  return [...references.values()];
}

/** Formatting and parsing run in the math Worker. A failure returns no partial definition to the document. */
export function renameMathCoefficient(definition: StoredMathExpression, id: string, label: string, codec: {
  readonly format: (expression: MathNode, notation: StoredMathExpression['inputNotation']) => string;
  readonly parse: (source: string, notation: StoredMathExpression['inputNotation']) => MathNode;
}): StoredMathExpression {
  if (label.trim().length === 0 || label.length > 128 || hasMathControlCharacters(label)) {
    throw new MathInputProblem('syntax', '係数の新しい名前を確認してください。');
  }
  let changed = false;
  const expression = mapMathCoefficients(definition.expression, reference => {
    if (reference.id !== id || reference.label === label) return reference;
    changed = true;
    return { ...reference, label };
  });
  if (!changed) return definition;
  const converted = convertMathNotation(expression, node => codec.format(node, definition.inputNotation),
    source => codec.parse(source, definition.inputNotation));
  // Semantic equivalence checks IDs. Also enforce current labels so a stale formatter cannot display the old name.
  const expected = new Map(collectMathCoefficients(expression).map(reference => [reference.id, reference.label]));
  if (collectMathCoefficients(converted.expression).some(reference => expected.get(reference.id) !== reference.label)) {
    throw new MathInputProblem('syntax', '変更した係数名と表示される数式が一致しません。');
  }
  return { ...definition, source: converted.source, expression: converted.expression };
}

/** Rename only the declaration's stable reference; reparsing rejects capture by a local bound variable. */
export function renameMathDeclaration(definition: StoredMathExpression, id: string, label: string, codec: {
  readonly format: (expression: MathNode, notation: StoredMathExpression['inputNotation']) => string;
  readonly parse: (source: string, notation: StoredMathExpression['inputNotation']) => MathNode;
}): StoredMathExpression {
  if (!definition.declarations?.some(value => value.id === id)) {
    throw new MathInputProblem('syntax', '改名する記号の定義がありません。');
  }
  const declarations = decodeMathDeclarations(definition.declarations.map(value => value.id === id ? { ...value, label } : value));
  const expression = mapMathSymbols(definition.expression, reference => ({ kind: 'symbol',
    reference: reference.role === 'declared' && reference.id === id ? { ...reference, label } : reference }));
  const converted = convertMathNotation(expression, node => codec.format(node, definition.inputNotation),
    source => codec.parse(source, definition.inputNotation));
  referencedMathDeclarations(converted.expression, declarations);
  return { ...definition, declarations, source: converted.source, expression: converted.expression };
}
