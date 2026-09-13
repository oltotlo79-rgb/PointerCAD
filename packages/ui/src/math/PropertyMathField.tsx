import { useState } from 'react';
import { bindMathCompositionNames, type ExpressionValue } from '@pointercad/expression';
import { evaluateDocumentMath, evaluatedDocumentMathValue, replaceFeature, replaceSketch, type PartDocument, type SketchFeature } from '@pointercad/model';
import { ExpressionField, type ExpressionFieldProps } from '../sketch/ExpressionField.js';
import { fieldExpression, fieldUnitLabelKey, rangeErrorFor } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { MathExpressionDialog } from './MathExpressionDialog.js';
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

/** All property editors share cancellation, coefficient identities, current values, and one Undo. */
export function PropertyMathField({ storedValue, replaceValue, ...props }: PropertyMathFieldProps): React.JSX.Element {
  const part = useAppStore(state => state.document);
  // Completed recomputation publishes this object even when the saved document is unchanged.
  const analysis = useAppStore(state => state.parameterAnalysis);
  const [target, setTarget] = useState<Target | null>(null);
  const structured = storedValue.mathDefinition !== undefined && props.field.source === storedValue.source;
  const verified = structured && analysis !== null ? evaluatedDocumentMathValue(part, storedValue) : null;
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
        bindMathCompositionNames(value, prepared.parameters.flatMap(parameter => parameter.mathId === undefined ? [] : [{
          id: parameter.mathId, label: parameter.name, kind: parameter.unit === 'mm' ? 'length' : parameter.unit === 'degree' ? 'angle' : 'scalar',
        }]));
        const candidate = target.replaceValue(prepared, value);
        const evaluated = await evaluateDocumentMath(candidate, { client,
          identity: { documentId: prepared.id, documentVersion: target.documentVersion }, signal, isCurrent });
        if (!isCurrent() || signal.aborted) return { ok: false, message: t('math.operation.cancelled') };
        if (!evaluated.ok) return { ok: false, message: evaluated.failures[0]?.message ?? t('math.workerFailed') };
        useAppStore.getState().applyDocument(evaluated.document);
        return { ok: true };
      }} />}
  </>;
}
