import { useState } from 'react';
import { bindMathCompositionNames, type ExpressionValue } from '@pointercad/expression';
import { evaluateDocumentMath, evaluatedDocumentMathValue, replaceFeature, replaceSketch, type PartDocument, type SketchFeature } from '@pointercad/model';
import { ExpressionField, type ExpressionFieldProps } from '../sketch/ExpressionField.js';
import { fieldExpression, fieldUnitLabelKey, rangeErrorFor } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AppState } from '../store/appState.js';
import { pendingFieldVariables, referencesPendingVariable } from '../shell/propertyFieldUnits.js';
import { MathExpressionDialog } from './MathExpressionDialog.js';
import { currentMathGeometry, mathGeometryInputsFor } from './mathGeometryResults.js';
import { t } from '../i18n/t.js';

interface PropertyMathFieldProps extends ExpressionFieldProps {
  readonly storedValue: ExpressionValue;
  /** Pure replacement: no store writes until the entire candidate is evaluated. */
  readonly replaceValue: (document: PartDocument, value: ExpressionValue) => PartDocument;
}
interface Target {
  readonly document: PartDocument;
  readonly documentVersion: number;
  readonly initialValue: ExpressionValue;
  readonly replaceValue: PropertyMathFieldProps['replaceValue'];
}

export function replacePropertySketchFeature(document: PartDocument, featureId: string, feature: SketchFeature): PartDocument {
  const sketch = document.sketches.find(candidate => candidate.features.some(item => item.id === featureId));
  if (sketch === undefined) throw new Error(t('propertyPanel.missingSketchFeature'));
  return replaceSketch(document, replaceFeature(sketch, featureId, feature));
}

/** Read confirmed values through the same history/geometry freshness rules as legacy fields. */
function verifiedPropertyValue(state: AppState, value: ExpressionValue): ExpressionValue | null {
  if (state.timelineIndex !== null) return null;
  const pending = pendingFieldVariables(state);
  if (referencesPendingVariable(value.source, pending, value.mathDefinition)) return null;
  const verified = evaluatedDocumentMathValue(state.document, value);
  if (verified !== null) return verified;
  // Appearance edits keep the completed snapshot. Its owner, shape and generation must still match.
  return currentMathGeometry(state).status === 'current' && state.mathGeometryResult !== null
    ? evaluatedDocumentMathValue(state.mathGeometryResult.document, value) : null;
}

/** All property editors share cancellation, coefficient identities, current values, and one Undo. */
export function PropertyMathField({ storedValue, replaceValue, ...props }: PropertyMathFieldProps): React.JSX.Element {
  const [target, setTarget] = useState<Target | null>(null);
  const structured = storedValue.mathDefinition !== undefined && props.field.source === storedValue.source;
  const verified = useAppStore(state => structured ? verifiedPropertyValue(state, storedValue) : null);
  const result = structured ? { key: props.field.key, value: verified,
    error: verified === null ? null : rangeErrorFor(props.field, verified) } : props.result;
  const isCurrent = () => target !== null && useAppStore.getState().document === target.document
    && useAppStore.getState().documentVersion === target.documentVersion;
  return <>
    <ExpressionField {...props} result={result} onMath={() => {
      const current = useAppStore.getState();
      const initialValue = props.field.source === storedValue.source ? storedValue : { ...storedValue, mathDefinition: undefined,
        source: fieldExpression({ ...props.field, typed: true }, props.lengthUnit) };
      setTarget({ document: current.document, documentVersion: current.documentVersion, initialValue, replaceValue });
    }} />
    {structured && verified === null ? <p role="status" className="pcad-field__message">{t('math.calculating')}</p> : null}
    {target === null ? null : <MathExpressionDialog document={target.document} documentVersion={target.documentVersion}
      initialValue={target.initialValue} unitLabel={t(fieldUnitLabelKey(props.field.unit, 'mm'))}
      isCurrent={isCurrent} onClose={() => setTarget(null)} onApply={async (value, prepared, signal, client) => {
        const error = rangeErrorFor(props.field, value);
        if (error !== null) return { ok: false, message: error.message };
        // The prepared candidate is private; measured inputs belong to the original, current document.
        const geometry = mathGeometryInputsFor(useAppStore.getState(), target.document);
        if (geometry === null) return { ok: false, message: t('mathGeometry.editor.pending') };
        bindMathCompositionNames(value, prepared.parameters.flatMap(parameter => parameter.mathId === undefined ? [] : [{
          id: parameter.mathId, label: parameter.name, kind: parameter.unit === 'mm' ? 'length' : parameter.unit === 'degree' ? 'angle' : 'scalar',
        }]));
        const candidate = target.replaceValue(prepared, value);
        const evaluated = await evaluateDocumentMath(candidate, { client, geometry,
          identity: { documentId: prepared.id, documentVersion: target.documentVersion }, signal, isCurrent });
        if (!isCurrent() || signal.aborted) return { ok: false, message: t('math.operation.cancelled') };
        if (mathGeometryInputsFor(useAppStore.getState(), target.document) !== geometry) {
          return { ok: false, message: t('mathGeometry.editor.pending') };
        }
        if (!evaluated.ok) return { ok: false, message: evaluated.failures[0]?.message ?? t('math.workerFailed') };
        useAppStore.getState().applyDocument(evaluated.document);
        return { ok: true };
      }} />}
  </>;
}
