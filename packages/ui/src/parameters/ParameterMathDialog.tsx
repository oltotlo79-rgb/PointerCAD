import { evaluateDocumentMath, synchronizeConfigurations, type DocumentMathContext, type Parameter, type PartDocument } from '@pointercad/model';
import type { ExpressionValue } from '@pointercad/expression';
import { MathExpressionDialog } from '../math/MathExpressionDialog.js';
import { mathGeometryEditorCandidate, mathGeometryEditorProblem } from '../math/prepareDocumentMathEditor.js';
import { mathGeometryInputsFor } from '../math/mathGeometryResults.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';

export interface ParameterMathTarget {
  readonly document: PartDocument;
  readonly documentVersion: number;
  readonly parameter: Parameter;
}

/** Validate against one current measurement snapshot and publish exactly one undoable edit. */
export async function applyParameterMath(target: ParameterMathTarget, value: ExpressionValue, prepared: PartDocument,
  context: DocumentMathContext): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const ownerIsCurrent = () => !context.signal?.aborted && context.isCurrent()
    && useAppStore.getState().document === target.document && useAppStore.getState().documentVersion === target.documentVersion;
  if (!ownerIsCurrent()) return { ok: false, message: t('math.operation.cancelled') };
  const candidate = synchronizeConfigurations(mathGeometryEditorCandidate(prepared, target.parameter.name, value));
  const problem = mathGeometryEditorProblem(candidate);
  if (problem !== null) return { ok: false, message: problem };
  const geometry = mathGeometryInputsFor(useAppStore.getState(), target.document);
  if (geometry === null) return { ok: false, message: t('mathGeometry.editor.pending') };
  const isCurrent = () => ownerIsCurrent() && mathGeometryInputsFor(useAppStore.getState(), target.document) === geometry;
  const result = await evaluateDocumentMath(candidate, { ...context, geometry, isCurrent });
  if (!isCurrent()) return { ok: false, message: t('math.operation.cancelled') };
  if (!result.ok) return { ok: false, message: result.failures[0]?.message ?? t('math.workerFailed') };
  useAppStore.getState().applyDocument(result.document);
  return { ok: true };
}

export function ParameterMathDialog({ target, onClose }: {
  readonly target: ParameterMathTarget; readonly onClose: () => void;
}): React.JSX.Element {
  const isCurrent = () => useAppStore.getState().document === target.document
    && useAppStore.getState().documentVersion === target.documentVersion;
  const unitLabel = target.parameter.unit === 'none' ? t('parameterPanel.unit.none')
    : target.parameter.unit === 'degree' ? t('math.degree') : 'mm';
  return <MathExpressionDialog document={target.document} documentVersion={target.documentVersion}
    initialValue={target.parameter.value} unitLabel={unitLabel} excludedCoefficient={target.parameter.name}
    geometry={{ coefficientName: target.parameter.name, unit: target.parameter.unit }}
    isCurrent={isCurrent} onClose={onClose} onApply={(value, prepared, signal, client) => applyParameterMath(target, value, prepared,
      { client, identity: { documentId: prepared.id, documentVersion: target.documentVersion }, signal, isCurrent })} />;
}
