import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { analyzeParameters, type LengthUnit, type Parameter } from '@pointercad/model';

import { isPendingFieldError, pendingFieldVariables, referencesPendingVariable } from '../shell/propertyFieldUnits.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { ExpressionInspectionPreview } from '../math/ExpressionInspectionPreview.js';
import { countAffectedFeatures, countParameterUsageSites, inspectInputExpression } from '../math/expressionInspectionContext.js';
import { isCompositionKey } from '../commands/compositionKey.js';
import { completionKey, completionWord, expressionCandidates, insertCompletion } from './expressionCompletion.js';
import { expressionErrorText } from './expressionErrorText.js';
import { ExpressionSuggestions } from './ExpressionSuggestions.js';
import { usesDisplayInputUnit } from './numericFieldUnits.js';
import {
  fieldUnitLabelKey,
  type NumericField,
  type NumericFieldResult,
} from './numericInput.js';
import { fieldValueDisplay, restingFieldValue, stacksFieldLabel } from './numericInputPresentation.js';

export interface ExpressionFieldProps {
  /** Explicit owner parameters for fields outside the active Part, such as assembly analysis. */
  readonly inspectionParameters?: readonly Parameter[];
  /** Canonical physical-unit expression; the original input remains displayed and saved. */
  readonly inspectionSource?: string;
  readonly field: NumericField;
  readonly result: NumericFieldResult;
  /**
   * 画面に出している長さの単位(FR-811)。省くと mm。
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
 * 式が返した理由の後ろに、該当するヒントと候補だけを添える。
 * 評価値は有効 6 桁で出し、全部の桁は `full`(行のツールチップ)へ渡す(UI の点検の指摘 26)。
 */
function fieldMessage(
  field: NumericField,
  result: NumericFieldResult,
  lengthUnit: LengthUnit,
): { readonly text: string; readonly full?: string } {
  if (result.error !== null) {
    return { text: expressionErrorText(result.error) };
  }
  if (result.value === null) {
    return { text: '' };
  }
  // 値だけを表示の単位で出す。**欄の中の式は 1 文字も書き換えない**(FR-202)。
  const shown = fieldValueDisplay(field.unit, result.value, lengthUnit);
  return { text: `= ${shown.text}`, full: `= ${shown.full}` };
}

/**
 * 式を 1 つ入れる欄(FR-201)。入力した式はそのまま残り、評価値は下に淡色で出る(FR-202)。
 * 間違いは打った瞬間に赤で出す。実行してから失敗させない(NFR-UX-5、FR-204)。
 *
 * 表示だけを受け持ち、値も焦点も自分では覚えない(rules/04-設計の規律.md)。
 * 焦点の無い数だけの欄は、input の値(中身)を変えずに、有効 6 桁の見せ方を欄に重ねる(UI の点検の指摘 26・45・48)。
 * 重ねた表示は CSS で焦点が入ると消え、読み上げ(aria-hidden)とポインター(pointer-events)を通すので、
 * 打つ・読む・押すはいつも中身に対して行われる(値を入れ替えると、入ってすぐ打った文字が失われる事があった)。
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
  const [query, setQuery] = useState<{ source: string; caret: number } | null>(null);
  const [selected, setSelected] = useState(-1);
  const insertion = useRef<{ source: string; caret: number } | null>(null);
  const listId = inputId + '-options';
  const analysis = useMemo(() => inspectionParameters === undefined ? partAnalysis : analyzeParameters(inspectionParameters, []),
    [inspectionParameters, partAnalysis]);
  const word = useMemo(() => query?.source === field.source ? completionWord(field.source, query.caret) : null,
    [query, field.source]);
  const candidates = useMemo(() => word === null ? [] : expressionCandidates(word, parameters, analysis.variables),
    [word, parameters, analysis.variables]);
  const open = candidates.length > 0;
  const active = selected < candidates.length ? selected : -1;
  function closeList(): void { setQuery(null); setSelected(-1); }
  function accept(index: number): void {
    const candidate = candidates[index];
    if (word === null || candidate === undefined) return;
    const next = insertCompletion(field.source, word, candidate);
    insertion.current = next;
    closeList();
    onChange(next.source);
  }
  useLayoutEffect(() => {
    const next = insertion.current;
    if (next === null) return;
    insertion.current = null;
    if (next.source === field.source) inputRef.current?.setSelectionRange(next.caret, next.caret);
  });
  const document = useAppStore(state => state.document);
  const pending = inspectionParameters === undefined && (isPendingFieldError(result.error) || referencesPendingVariable(
    field.source.trim() === '' ? field.defaultSource : field.source, pendingVariables, field.mathValue?.mathDefinition ?? result.value?.mathDefinition,
  ));
  const hasError = result.error !== null && !pending;
  // fieldExpressionと同じ条件。内部mmの初期値をinchと表示しない。
  const sourceUnit = usesDisplayInputUnit(field) ? lengthUnit : 'mm';
  // 札を呼び出し側が決める欄(物理量を別に確かめた欄)は、数を表示の単位へ直さない。焦点のある欄には重ねない。
  const resting = focused ? null
    : restingFieldValue(field.source, field.unit, unitLabel === undefined ? sourceUnit : lengthUnit, lengthUnit);
  const label = t(field.labelKey);
  const message = pending ? { text: t('mathGeometry.status.pending') } : fieldMessage(field, result, lengthUnit);
  const rootClass = [hasError ? 'pcad-field pcad-field--error' : 'pcad-field',
    stacksFieldLabel(label) ? 'pcad-field--stacked' : '', resting?.inDisplayUnit === true ? 'pcad-field--resting-unit' : '']
    .filter(name => name !== '').join(' ');
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
    // そのまま打てば上書きになるようにする(NFR-UX-4、「初期焦点」)。
    if (input.ownerDocument.activeElement === input) {
      return;
    }
    input.focus();
    input.select();
  }, [focused]);

  return (
    <div className={rootClass}>
      <label className="pcad-field__label" htmlFor={inputId} title={t(field.tooltipKey)}>
        {label}
      </label>
      <span className="pcad-field__expression-input"><span className="pcad-field__input-box"><input
        ref={inputRef}
        id={inputId}
        className="pcad-field__input"
        type="text"
        // 役割は textbox のまま。一覧の開閉は読み上げに伝わらない(combobox へ移すのは作業の一覧の別の行)。
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? listId + '-' + String(active) : undefined}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        value={field.source}
        aria-invalid={hasError}
        aria-busy={pending || undefined}
        aria-describedby={inspectionVisible ? `${messageId} ${inspectionId}` : messageId}
        title={t(field.tooltipKey)}
        onFocus={onFocus}
        onBlur={closeList}
        onChange={({ currentTarget }) => {
          const source = currentTarget.value;
          setSelected(-1);
          setQuery({ source, caret: currentTarget.selectionStart ?? source.length });
          onChange(source);
        }}
        onSelect={({ currentTarget }) => {
          const caret = currentTarget.selectionStart;
          if (query === null || caret === null) return;
          if (caret !== currentTarget.selectionEnd) { closeList(); return; }
          if (caret !== query.caret) { setSelected(-1); setQuery({ source: currentTarget.value, caret }); }
        }}
        onKeyDown={event => {
          if (isCompositionKey(event.nativeEvent) || event.ctrlKey || event.metaKey || event.altKey) return;
          const action = completionKey(event.key, candidates.length, active);
          if (action.kind === 'pass') {
            if (event.key === 'Tab' || event.key === 'Enter') closeList();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (action.kind === 'select') setSelected(action.index);
          else if (action.kind === 'accept') accept(action.index);
          else closeList();
        }}
      />
      {open && inputRef.current !== null && <ExpressionSuggestions input={inputRef.current} id={listId}
        label={label} candidates={candidates} selected={active} accept={accept}/>}
      {resting === null ? null : (
        <span className="pcad-field__resting" aria-hidden="true">
          {resting.inDisplayUnit ? `${resting.text} ${t(fieldUnitLabelKey(field.unit, lengthUnit))}` : resting.text}
        </span>
      )}</span>
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
        title={message.full !== undefined && message.full !== message.text ? message.full : undefined}
      >
        {message.text}
      </p>
      {inspectionVisible ? <ExpressionInspectionPreview id={inspectionId} context={inspection}
        unitLabel={unitLabel ?? t(fieldUnitLabelKey(field.unit, sourceUnit))} parameterUnits={parameterUnits}
        usageCounts={usageCounts} affectedPartCount={affectedFeatureCount}
        showErrorPosition={hasError}/> : null}
    </div>
  );
}
