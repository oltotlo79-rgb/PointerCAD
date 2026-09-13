/** Saved formulas and derived surface plans are deliberately separate. */
import type { SolidFeatureBase } from '../part/featureIdentity.js';
import { nextSolidId, nextSolidName } from '../part/createPartDocument.js';
import type { PartDocument } from '../part/types.js';
import type { FunctionSurfaceInput } from '@pointercad/kernel';
import type { FunctionDefinition } from './functionDefinitionTypes.js';

export interface FunctionSurfaceFeature extends SolidFeatureBase {
  readonly kind: 'functionSurface';
  readonly definition: FunctionDefinition;
}
export interface FunctionSurfacePlan {
  readonly kind: 'functionSurface';
  /** Validated mathematical inputs at full precision, without request/generation identity. */
  readonly inputSignature: string;
  readonly geometry: FunctionSurfaceInput;
}
export function createFunctionSurface(document: PartDocument, definition: FunctionDefinition): FunctionSurfaceFeature {
  const kind = definition.formula.kind;
  if (kind !== 'coordinate-surface' && kind !== 'parametric-surface' && kind !== 'implicit-surface') {
    throw new Error('面を描く関数の形式を選んでください。');
  }
  return { id: nextSolidId(document, 'functionSurface'), name: nextSolidName(document, 'functionSurface'),
    kind: 'functionSurface', suppressed: false, definition };
}
