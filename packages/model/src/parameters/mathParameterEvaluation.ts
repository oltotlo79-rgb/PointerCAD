/** Ephemeral evaluation owned by immutable parameter snapshots. Never serialized or accepted from JSON. */
import type { Parameter, ParameterAnalysis } from './types.js';

const evaluated = new WeakMap<readonly Parameter[], Omit<ParameterAnalysis, 'unused'>>();

export function rememberMathParameterEvaluation(parameters: readonly Parameter[], analysis: ParameterAnalysis): void {
  evaluated.set(parameters, { variables: analysis.variables, exactVariables: analysis.exactVariables,
    ...(analysis.mathCoefficients === undefined ? {} : { mathCoefficients: analysis.mathCoefficients }),
    nonLengthVariables: analysis.nonLengthVariables, circular: analysis.circular, failures: analysis.failures });
}

export function knownMathParameterEvaluation(parameters: readonly Parameter[]): Omit<ParameterAnalysis, 'unused'> | undefined {
  return evaluated.get(parameters);
}
