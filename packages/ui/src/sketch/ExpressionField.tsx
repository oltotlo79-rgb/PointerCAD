import { useEffect, useId, useRef } from 'react';

import { t } from '../i18n/t.js';
import { UNIT_KEYS, type NumericField, type NumericFieldResult } from './numericInput.js';

export interface ExpressionFieldProps {
  readonly field: NumericField;
  readonly result: NumericFieldResult;
  /**
   * 状態機械が決めた焦点(NumericInputState.focusedIndex)。true になったときだけ
   * 実際の焦点を移す。焦点の正本はストア側の状態で、DOM ではない。
   */
  readonly focused: boolean;
  readonly onChange: (source: string) => void;
  readonly onFocus: () => void;
}

/**
 * 欄の下に出す 1 行。妥当なら評価値(FR-202)、間違いなら理由をそのまま出す(FR-204)。
 * 文言は式エンジンが組み立てた日本語で、位置や文字を差し込んだ文になるため ja.json では持てない。
 */
function fieldMessage(result: NumericFieldResult): string {
  if (result.error !== null) {
    return result.error.message;
  }
  return result.value === null ? '' : `= ${result.value.display}`;
}

/**
 * 式を 1 つ入れる欄(FR-201)。入力した式はそのまま残り、評価値は下に淡色で出る(FR-202)。
 * 間違いは打った瞬間に赤で出す。実行してから失敗させない(NFR-UX-5、FR-204)。
 *
 * 表示だけを受け持ち、値も焦点も自分では覚えない(rules/04-設計の規律.md)。
 */
export function ExpressionField({
  field,
  result,
  focused,
  onChange,
  onFocus,
}: ExpressionFieldProps): React.JSX.Element {
  const inputId = useId();
  const messageId = `${inputId}-message`;
  const inputRef = useRef<HTMLInputElement>(null);
  const hasError = result.error !== null;

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
      <input
        ref={inputRef}
        id={inputId}
        className="pcad-field__input"
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        value={field.source}
        aria-invalid={hasError}
        aria-describedby={messageId}
        title={t(field.tooltipKey)}
        onFocus={onFocus}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <span className="pcad-field__unit">{t(UNIT_KEYS[field.unit])}</span>
      <p
        id={messageId}
        className={
          hasError ? 'pcad-field__message pcad-field__message--error' : 'pcad-field__message'
        }
      >
        {fieldMessage(result)}
      </p>
    </div>
  );
}
