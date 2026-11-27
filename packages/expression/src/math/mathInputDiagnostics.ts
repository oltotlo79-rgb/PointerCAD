import { isRecord } from './mathRecord.js';

/** The Worker can send only a known key with its declared argument names. */
const DIAGNOSTIC_FIELDS = {
  'assembly.error.internal': [],
  'math.input.functionIndefiniteIntegral': [],
  'math.input.functionPlusMinus': [],
  'math.input.argumentLimit': ['limit'],
  'math.input.axisScope': ['name'],
  'math.input.bars': ['position'],
  'math.input.bindingArguments': ['position', 'name'],
  'math.input.bindingName': ['position', 'name'],
  'math.input.bracketDepth': ['position', 'limit'],
  'math.input.closedIntegralArguments': ['position'],
  'math.input.coefficientArguments': ['position'],
  'math.input.coefficientCoordinate': [],
  'math.input.coefficientDeclaration': ['name'],
  'math.input.coefficientExpansionLimit': ['nodes', 'depth'],
  'math.input.coefficientOpen': [],
  'math.input.coefficientReference': ['name'],
  'math.input.coefficientScopeLimit': ['limit'],
  'math.input.coefficientString': ['position'],
  'math.input.compositionDefinition': [],
  'math.input.compositionCoefficient': [],
  'math.input.compositionNonFinite': [],
  'math.input.complementArguments': ['position'],
  'math.input.controlCharacter': [],
  'math.input.cubeRootArguments': ['position', 'name'],
  'math.input.dataFormat': [],
  'math.input.dataKind': [],
  'math.input.dataValue': [],
  'math.input.decimalDigits': ['limit'],
  'math.input.decimalExponent': ['value', 'limit'],
  'math.input.decimalFormat': ['value'],
  'math.input.derivativeArguments': ['position', 'name'],
  'math.input.differentialEquationArguments': ['position', 'name'],
  'math.input.emptySource': [],
  'math.input.equationArguments': ['position', 'name'],
  'math.input.expansionArguments': ['position', 'name'],
  'math.input.expectedToken': ['position', 'value'],
  'math.input.explicitCoefficient': ['name'],
  'math.input.extremeLimitArguments': ['position', 'name'],
  'math.input.forbiddenOperation': [],
  'math.input.fourierArguments': ['position', 'name'],
  'math.input.innerProductArguments': ['position'],
  'math.input.invalidCoefficientQuote': ['position'],
  'math.input.limitArguments': ['position', 'name'],
  'math.input.lineIntegralArguments': ['position', 'name'],
  'math.input.mappingArguments': ['position', 'name'],
  'math.input.missingOperand': ['position'],
  'math.input.missingOperator': ['position'],
  'math.input.nablaLaplacian': ['position'],
  'math.input.nablaVariables': ['position'],
  'math.input.nonFiniteLiteral': [],
  'math.input.numericalRootsArguments': ['position', 'name'],
  'math.input.operationArity': ['name', 'count', 'min', 'max'],
  'math.input.operationName': [],
  'math.input.parameterScope': ['name'],
  'math.input.probabilityArguments': ['position', 'name'],
  'math.input.quantifierArguments': ['position', 'name'],
  'math.input.ratioDefinition': ['position'],
  'math.input.ratioInList': ['position'],
  'math.input.ratioTerms': ['position'],
  'math.input.ratioTime': ['position', 'value'],
  'math.input.rawStructure': ['nodes', 'depth'],
  'math.input.regionIntegralArguments': ['position', 'name'],
  'math.input.repeatingDecimal': [],
  'math.input.repeatingDecimalAt': ['position'],
  'math.input.repeatingDecimalDigits': ['count', 'limit'],
  'math.input.savedMeaning': [],
  'math.input.sequenceArguments': ['position', 'name'],
  'math.input.sequenceIndex': ['position', 'name'],
  'math.input.sourceDigits': ['position', 'limit'],
  'math.input.sourceLength': ['count', 'limit'],
  'math.input.symbolLength': ['count', 'limit'],
  'math.input.syntaxDepth': ['limit'],
  'math.input.syntaxNodeLimit': ['limit'],
  'math.input.systemArguments': ['position', 'name'],
  'math.input.tokenLimit': ['limit'],
  'math.input.transformArguments': ['position', 'name'],
  'math.input.unclosedCoefficientQuote': ['position'],
  'math.input.unexpectedOperand': ['position', 'value'],
  'math.input.unknownCoefficient': ['name'],
  'math.input.unknownSymbol': ['name'],
  'math.input.unsupportedFunction': ['name', 'position'],
  'math.input.unsupportedOperation': ['name'],
  'math.input.unsupportedSymbol': ['position', 'value'],
  'math.input.vectorAtArguments': ['position', 'name'],
} as const;

export type MathInputDiagnosticKey = keyof typeof DIAGNOSTIC_FIELDS;
export interface MathInputDiagnostic {
  readonly key: MathInputDiagnosticKey;
  readonly parameters: Readonly<Record<string, string>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function decodeMathInputDiagnostic(value: unknown, readText: (value: unknown) => string): MathInputDiagnostic {
  if (!isPlainRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'key')
    || !Object.hasOwn(value, 'parameters') || typeof value.key !== 'string'
    || !Object.hasOwn(DIAGNOSTIC_FIELDS, value.key) || !isPlainRecord(value.parameters)) {
    throw new TypeError('Invalid math input diagnostic');
  }
  const key = value.key as MathInputDiagnosticKey;
  const raw = value.parameters;
  const fields: readonly string[] = DIAGNOSTIC_FIELDS[key];
  if (Object.keys(raw).length !== fields.length || fields.some(field => !Object.hasOwn(raw, field))) {
    throw new TypeError('Invalid math input diagnostic parameters');
  }
  return { key, parameters: Object.fromEntries(fields.map(field => [field, readText(raw[field])])) };
}
