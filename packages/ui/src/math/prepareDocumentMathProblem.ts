import type { StoredMathExpression } from '@pointercad/expression';
import type { DocumentMathContext, PartDocument } from '@pointercad/model';
import { prepareDocumentMathEnvironment } from './prepareDocumentMathEditor.js';

/** Retain an equation and its conditions without manufacturing a scalar value. */
export async function prepareDocumentMathProblem(document: PartDocument,
  definition: StoredMathExpression | undefined, context: DocumentMathContext) {
  const environment = await prepareDocumentMathEnvironment(document, context);
  return { ...environment, purpose: 'problem' as const,
    source: definition?.source ?? 'pde([diff(u,t)=diff(u,x,x)],[x,t],[u],[[u,[0,t],0]])',
    notation: definition?.inputNotation ?? 'text' as const,
    angleUnit: definition?.angleUnit ?? 'degree' as const };
}
