import { exactExpressionValueFromNumber } from '@pointercad/expression';
import type { PartDocument } from '@pointercad/model';
import { MathExpressionDialog } from '../math/MathExpressionDialog.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { acceptNumericMath } from './numericMathValues.js';
import { fieldExpression, fieldUnitLabelKey, type NumericInputState, type DisplayUnitOptions } from './numericInput.js';

export interface NumericMathTarget {
  readonly document: PartDocument;
  readonly documentVersion: number;
  readonly input: NumericInputState;
  readonly index: number;
  readonly lengthUnit: DisplayUnitOptions['lengthUnit'];
}
export function NumericMathDialog({ target, onClose }: {
  readonly target: NumericMathTarget; readonly onClose: () => void;
}): React.JSX.Element | null {
  const field = target.input.fields[target.index];
  if (field === undefined) return null;
  const isCurrent = () => useAppStore.getState().document === target.document
    && useAppStore.getState().documentVersion === target.documentVersion
    && useAppStore.getState().numericInput === target.input;
  const initialValue = field.mathValue ?? { ...exactExpressionValueFromNumber(0), source: fieldExpression(field, target.lengthUnit) };
  const unitLabel = t(fieldUnitLabelKey(field.unit, 'mm'));
  return <MathExpressionDialog document={target.document} documentVersion={target.documentVersion}
    initialValue={initialValue} unitLabel={unitLabel} isCurrent={isCurrent} onClose={onClose}
    onApply={(value, prepared, signal, _client, coefficients) => {
      if (!isCurrent() || signal.aborted) return Promise.resolve({ ok: false, message: t('math.operation.cancelled') });
      const accepted = acceptNumericMath(value, prepared, coefficients);
      const fields = target.input.fields.map((entry, index) => index === target.index
        ? { ...entry, source: accepted.source, typed: false, mathValue: accepted } : entry);
      useAppStore.getState().updateNumericInput({ ...target.input, fields, focusedIndex: target.index });
      return Promise.resolve({ ok: true });
    }} />;
}
