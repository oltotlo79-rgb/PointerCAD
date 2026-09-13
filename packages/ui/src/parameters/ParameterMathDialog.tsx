import { evaluateDocumentMath, synchronizeConfigurations, type Parameter, type PartDocument } from '@pointercad/model';
import { MathExpressionDialog } from '../math/MathExpressionDialog.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';

export interface ParameterMathTarget {
  readonly document: PartDocument;
  readonly documentVersion: number;
  readonly parameter: Parameter;
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
    isCurrent={isCurrent} onClose={onClose} onApply={async (value, prepared, signal, client) => {
      const candidate = synchronizeConfigurations({ ...prepared, parameters: prepared.parameters.map(parameter =>
        parameter.name === target.parameter.name ? { ...parameter, value } : parameter) });
      const result = await evaluateDocumentMath(candidate, { client, identity: { documentId: prepared.id, documentVersion: target.documentVersion },
        signal, isCurrent });
      if (!isCurrent() || signal.aborted) return { ok: false, message: t('math.operation.cancelled') };
      if (!result.ok) return { ok: false, message: result.failures[0]?.message ?? t('math.workerFailed') };
      useAppStore.getState().applyDocument(result.document);
      return { ok: true };
    }} />;
}
