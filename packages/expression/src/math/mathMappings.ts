import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const MAPPING_DEFINITIONS = [
  ['mapping', 'Mapping', 3], ['mapping-value', 'MapAt', 2],
  ['mapping-compose', 'ComposeMaps', 2], ['mapping-inverse', 'InverseMap', 1],
  ['mapping-image', 'MapImage', 2], ['mapping-preimage', 'MapPreimage', 2],
] as const;
const IDS: ReadonlySet<string> = new Set(MAPPING_DEFINITIONS.map(([id]) => id));

export function mappingFunction(node: MathNode): Extract<MathNode, { kind: 'binder' }> {
  if (node.kind !== 'operation' || node.operation !== 'mapping' || node.operands.length !== 3) {
    throw new MathInputProblem('syntax', '写像の式、変数、定義域と出力先の集合を指定してください。');
  }
  const fn = node.operands[0];
  if (fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length !== 1
    || fn.bindings[0].domain.kind !== 'unrestricted') {
    throw new MathInputProblem('syntax', '写像の式で使う変数を一つ指定してください。');
  }
  return fn;
}

/** Only a declared map, its composition, or its inverse can have a function result. */
export function isMappingSource(node: MathNode): boolean {
  if (node.kind !== 'operation') return false;
  if (node.operation === 'mapping') { mappingFunction(node); return true; }
  return node.operation === 'mapping-compose' && node.operands.length === 2 && node.operands.every(isMappingSource)
    || node.operation === 'mapping-inverse' && node.operands.length === 1 && isMappingSource(node.operands[0]);
}

export function containsMappingCalculation(source: MathNode): boolean {
  const pending = [source];
  while (pending.length > 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (node.kind === 'operation') {
      if (IDS.has(node.operation)) return true;
      pending.push(...node.operands);
    } else if (node.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper);
          if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return false;
}
