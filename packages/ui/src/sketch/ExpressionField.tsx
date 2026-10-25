import { useEffect, useId, useMemo, useRef } from 'react';

import { analyzeParameters, type LengthUnit, type Parameter } from '@pointercad/model';

import { isPendingFieldError, pendingFieldVariables, referencesPendingVariable } from '../shell/propertyFieldUnits.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { ExpressionInspectionPreview } from '../math/ExpressionInspectionPreview.js';
import { countAffectedFeatures, countParameterUsageSites, inspectInputExpression } from '../math/expressionInspectionContext.js';
import { usesDisplayInputUnit } from './numericFieldUnits.js';
import {
  fieldUnitLabelKey,
  fieldValueText,
  type NumericField,
  type NumericFieldResult,
} from './numericInput.js';

export interface ExpressionFieldProps {
  /** Explicit owner parameters for fields outside the active Part, such as assembly analysis. */
  readonly inspectionParameters?: readonly Parameter[];
  /** Canonical physical-unit expression; the original input remains displayed and saved. */
  readonly inspectionSource?: string;
  readonly field: NumericField;
  readonly result: NumericFieldResult;
  /**
   * 画面に出している長さの単位(FR-811、P6 タスク3b)。省くと mm。
   * 手入力する長さの単位と、下に添える評価値の単位。設定値・クリック値・空欄の
   * 既定値は内部のmmなので、欄の札もmmとする(元の式は変えない)。
   */
  readonly lengthUnit?: LengthUnit;
  /** A caller with a separately validated physical quantity supplies its explicit canonical unit. */
  readonly unitLabel?: string;
  /**
   * 状態機械が決めた焦点(NumericInputState.focusedIndex)。true になったときだけ
   * 実際の焦点を移す。焦点の正本はストア側の状態で、DOM ではない。
   */
  readonly focused: boolean;
  readonly onChange: (source: string) => void;
  readonly onFocus: () => void;
  readonly onMath?: () => void;
}

/**
 * 欄の下に出す 1 行。妥当なら評価値(FR-202)、間違いなら理由をそのまま出す(FR-204)。
 * 文言は式エンジンが組み立てた日本語で、位置や文字を差し込んだ文になるため ja.json では持てない。
 */
function fieldMessage(
  field: NumericField,
  result: NumericFieldResult,
  lengthUnit: LengthUnit,
): string {
  if (result.error !== null) {
    return result.error.message;
  }
  // 値だけを表示の単位で出す。**欄の中の式は 1 文字も書き換えない**(FR-202、タスク3b)。
  return result.value === null ? '' : `= ${fieldValueText(field.unit, result.value, lengthUnit)}`;
}

/**
 * 式を 1 つ入れる欄(FR-201)。入力した式はそのまま残り、評価値は下に淡色で出る(FR-202)。
 * 間違いは打った瞬間に赤で出す。実行してから失敗させない(NFR-UX-5、FR-204)。
 *
 * 表示だけを受け持ち、値も焦点も自分では覚えない(rules/04-設計の規律.md)。
 */
export function ExpressionField({
  inspectionParameters,
  inspectionSource,
  field,
  result,
  lengthUnit = 'mm',
  unitLabel,
  focused,
  onChange,
  onFocus,
  onMath,
}: ExpressionFieldProps): React.JSX.Element {
  const inputId = useId();
  const messageId = `${inputId}-message`;
  const inspectionId = `${inputId}-inspection`;
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingVariables = useAppStore(pendingFieldVariables);
  const partAnalysis = useAppStore(state => state.parameterAnalysis);
  const partParameters = useAppStore(state => state.document.parameters);
  const parameters = inspectionParameters ?? partParameters;
  const analysis = useMemo(() => inspectionParameters === undefined ? partAnalysis : analyzeParameters(inspectionParameters, []),
    [inspectionParameters, partAnalysis]);
  const document = useAppStore(state => state.document);
  const pending = inspectionParameters === undefined && (isPendingFieldError(result.error) || referencesPendingVariable(
    field.source.trim() === '' ? field.defaultSource : field.source, pendingVariables, field.mathValue?.mathDefinition ?? result.value?.mathDefinition,
  ));
  const hasError = result.error !== null && !pending;
  // fieldExpressionと同じ条件。内部mmの初期値をinchと表示しない。
  const sourceUnit = usesDisplayInputUnit(field) ? lengthUnit : 'mm';
  const parameterUnits = useMemo(() => new Map(parameters.map(parameter => [parameter.name, parameter.unit])), [parameters]);
  const inspection = focused && field.mathValue?.mathDefinition === undefined
    ? inspectInputExpression(inspectionSource ?? field.source, {
      variables: analysis.variables, exactVariables: analysis.exactVariables,
      nonLengthVariables: analysis.nonLengthVariables,
    }, pending ? null : result.error, analysis.circular) : null;
  const inspectionVisible = inspection !== null && (inspection.references.length > 0
    || inspection.inspection.units.length > 0 || inspection.errorPosition !== null);
  const usageCounts = useMemo(() => inspectionVisible && inspectionParameters === undefined ? countParameterUsageSites(document) : undefined,
    [document, inspectionVisible, inspectionParameters]);
  const referencedNames = inspection === null ? '' : [...new Set(inspection.references.map(reference => reference.name))].join('\n');
  const affectedFeatureCount = useMemo(() => referencedNames === '' || inspectionParameters !== undefined ? undefined
    : countAffectedFeatures(document, referencedNames.split('\n'), analysis.circular),
  [document, referencedNames, analysis.circular, inspectionParameters]);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null || !focused) {
      return;
    }
    // すでにこの欄へ焦点があるとき(利用者がクリックで入ったとき)は選び直さない。
    // 状態機械が焦点を動かしたとき(開いた直後・Tab・モード切替)だけ全選択にして、
    // そのまま打てば上書きになるようにする(NFR-UX-4、§2.9 の「初期焦点」)。
    if (input.ownerDocument.activeElement === input) {
      return;
    }
    input.focus();
    input.select();
  }, [focused]);

  return (
    <div className={hasError ? 'pcad-field pcad-field--error' : 'pcad-field'}>
      <label className="pcad-field__label" htmlFor={inputId} title={t(field.tooltipKey)}>
        {t(field.labelKey)}
      </label>
      <span className="pcad-field__expression-input"><input
        ref={inputRef}
        id={inputId}
        className="pcad-field__input"
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        value={field.source}
        aria-invalid={hasError}
        aria-busy={pending || undefined}
        aria-describedby={inspectionVisible ? `${messageId} ${inspectionId}` : messageId}
        title={t(field.tooltipKey)}
        onFocus={onFocus}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {onMath === undefined ? null : <button type="button" className="pcad-button pcad-field__math"
        title={`${t(field.labelKey)}: ${t('math.open')}`} aria-label={`${t(field.labelKey)}: ${t('math.open')}`}
        onKeyDown={event => {
          // Keep button activation and native Tab movement out of the parent input handler.
          // File shortcuts and other unhandled keys must reach the application.
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Tab') event.stopPropagation();
        }} onClick={onMath}>ƒx</button>}</span>
      <span className="pcad-field__unit">{unitLabel ?? t(fieldUnitLabelKey(field.unit, sourceUnit))}</span>
      <p
        id={messageId}
        className={
          hasError ? 'pcad-field__message pcad-field__message--error' : 'pcad-field__message'
        }
      >
        {pending ? t('mathGeometry.status.pending') : fieldMessage(field, result, lengthUnit)}
      </p>
      {inspectionVisible ? <ExpressionInspectionPreview id={inspectionId} context={inspection}
        unitLabel={unitLabel ?? t(fieldUnitLabelKey(field.unit, sourceUnit))} parameterUnits={parameterUnits}
        usageCounts={usageCounts} affectedPartCount={affectedFeatureCount}
        showErrorPosition={hasError}/> : null}
    </div>
  );
}
