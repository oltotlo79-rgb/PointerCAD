import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ExpressionField } from './ExpressionField.js';
import {
  applyNumericInputKey,
  COORDINATE_MODES,
  evaluateNumericInput,
  isCoordinateStep,
  MODE_LABEL_KEYS,
  MODE_TOOLTIP_KEYS,
  nextNumericInput,
  NUMERIC_INPUT_KEYS,
  reduceNumericInput,
  STEP_TITLE_KEYS,
  type NumericInputCommit,
  type NumericInputKey,
  type NumericInputState,
  type NumericInputTransition,
} from './numericInput.js';

/** ポップアップを基準点から右下へずらす量(画素)。指やカーソルで隠れないようにする。 */
const OFFSET_PIXELS = 14;
/** ビューポートの端からこれ以上は出さない(画素)。 */
const EDGE_MARGIN_PIXELS = 8;
/** 折り返し判定に使う見込みの大きさ(画素)。css の .pcad-popover の width と揃える。 */
const POPOVER_WIDTH_PIXELS = 260;
/**
 * 高さの見込み(画素)。実際の高さは欄の数と誤り文の折り返しで変わるため、
 * 3 欄+誤り文 1 行のときより少し大きい値を採って下端からはみ出しにくくする。
 */
const POPOVER_HEIGHT_PIXELS = 280;

/** 画面からはみ出さない位置を求める。ビューポートが小さいときは左上の余白を優先する。 */
export function clampAnchor(
  anchor: readonly [number, number],
  viewportWidth: number,
  viewportHeight: number,
): { readonly left: number; readonly top: number } {
  const maxLeft = Math.max(
    EDGE_MARGIN_PIXELS,
    viewportWidth - POPOVER_WIDTH_PIXELS - EDGE_MARGIN_PIXELS,
  );
  const maxTop = Math.max(
    EDGE_MARGIN_PIXELS,
    viewportHeight - POPOVER_HEIGHT_PIXELS - EDGE_MARGIN_PIXELS,
  );
  return {
    left: Math.min(Math.max(anchor[0] + OFFSET_PIXELS, EDGE_MARGIN_PIXELS), maxLeft),
    top: Math.min(Math.max(anchor[1] + OFFSET_PIXELS, EDGE_MARGIN_PIXELS), maxTop),
  };
}

/**
 * ポップアップの中で意味を持つキーだけを取り出す(§2.9)。
 * それ以外は欄へそのまま通す(文字の入力・カーソル移動を邪魔しない)。
 */
function numericInputKeyFor(
  event: React.KeyboardEvent,
  coordinateStep: boolean,
): NumericInputKey | null {
  // 日本語入力の変換中に押した Enter は確定の合図なので、こちらでは扱わない。
  if (event.nativeEvent.isComposing) {
    return null;
  }
  if (event.key === 'Tab') {
    return event.shiftKey ? 'ShiftTab' : 'Tab';
  }
  if (event.key === 'Enter') {
    return 'Enter';
  }
  if (event.key === 'Escape') {
    return 'Escape';
  }
  if (event.altKey && coordinateStep) {
    if (event.key === '1') {
      return 'Alt1';
    }
    if (event.key === '2') {
      return 'Alt2';
    }
    if (event.key === '3') {
      return 'Alt3';
    }
  }
  return null;
}

export interface NumericInputPopoverProps {
  /**
   * 決定されたときに呼ばれる。何を履歴へ積むかはこの部品では決めない
   * (計画書 タスク21 が渡す処理が決める)。
   */
  readonly onCommit: (commit: NumericInputCommit, state: NumericInputState) => void;
  /** ビューポートの大きさ(画素)。端での折り返しに使う。 */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/**
 * ビューポート内に浮かぶその場数値入力(NFR-UX-2)。モーダルではないので、
 * 開いている間も背後の視点操作とホバーはそのまま効く。
 *
 * 状態はストアの `numericInput` 1 本で、この部品は表示とキーの詰め替えだけを受け持つ。
 * 欄の巡回・確定・取消の規則は `numericInput.ts` の純関数が決める(§0.a-0.8)。
 */
export function NumericInputPopover({
  onCommit,
  viewportWidth,
  viewportHeight,
}: NumericInputPopoverProps): React.JSX.Element | null {
  const state = useAppStore((store) => store.numericInput);
  const anchor = useAppStore((store) => store.numericInputAnchor);

  if (state === null || anchor === null) {
    return null;
  }

  const evaluation = evaluateNumericInput(state);
  const position = clampAnchor(anchor, viewportWidth, viewportHeight);
  const coordinateStep = isCoordinateStep(state.step);

  const update = (next: NumericInputState): void => {
    useAppStore.getState().updateNumericInput(next);
  };

  const applyTransition = (transition: NumericInputTransition): void => {
    switch (transition.kind) {
      case 'open':
        update(transition.state);
        return;
      case 'blocked':
        // 決定させず、最初に間違っている欄へ焦点を戻す(NFR-UX-5)。
        update(transition.state);
        return;
      case 'cancelled':
        useAppStore.getState().closeNumericInput();
        return;
      case 'committed': {
        onCommit(transition.commit, transition.state);
        const next = nextNumericInput(transition.state, useAppStore.getState().chaining);
        if (next === null) {
          useAppStore.getState().closeNumericInput();
          return;
        }
        update(next);
        return;
      }
    }
  };

  const handleKey = (key: NumericInputKey): void => {
    applyTransition(applyNumericInputKey(state, key));
  };

  /** ボタンを押しても欄から焦点を奪わない(NFR-UX-2 の「焦点を外へ逃がさない」)。 */
  const keepFocus = (event: React.MouseEvent): void => {
    event.preventDefault();
  };

  return (
    <div
      className="pcad-popover"
      style={{ left: `${String(position.left)}px`, top: `${String(position.top)}px` }}
      role="dialog"
      aria-label={t(STEP_TITLE_KEYS[state.step])}
      onKeyDown={(event) => {
        const key = numericInputKeyFor(event, coordinateStep);
        if (key === null) {
          return;
        }
        // 扱うキーだけを止める。ビューポートの視点操作へは流さない。
        event.preventDefault();
        event.stopPropagation();
        handleKey(key);
      }}
    >
      <div className="pcad-popover__title">{t(STEP_TITLE_KEYS[state.step])}</div>

      {coordinateStep ? (
        <div
          className="pcad-segmented pcad-popover__modes"
          role="group"
          aria-label={t('numericInput.modeGroupLabel')}
        >
          {COORDINATE_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="pcad-button"
              aria-pressed={state.mode === mode}
              title={t(MODE_TOOLTIP_KEYS[mode])}
              onMouseDown={keepFocus}
              onClick={() => {
                update(reduceNumericInput(state, { type: 'setMode', mode }));
              }}
            >
              {t(MODE_LABEL_KEYS[mode])}
            </button>
          ))}
        </div>
      ) : null}

      <div className="pcad-popover__fields">
        {state.fields.map((field, index) => (
          <ExpressionField
            key={field.key}
            field={field}
            result={evaluation.results[index]}
            focused={index === state.focusedIndex}
            onChange={(source) => {
              update(reduceNumericInput(state, { type: 'edit', index, source }));
            }}
            onFocus={() => {
              update(reduceNumericInput(state, { type: 'focus', index }));
            }}
          />
        ))}
      </div>

      <p className="pcad-popover__hint">{t('numericInput.keyHint')}</p>

      <div className="pcad-popover__actions">
        <button
          type="button"
          className="pcad-button pcad-button--action"
          aria-disabled={!evaluation.canCommit}
          title={t(NUMERIC_INPUT_KEYS.commitTooltip)}
          onMouseDown={keepFocus}
          onClick={() => {
            handleKey('Enter');
          }}
        >
          {t(NUMERIC_INPUT_KEYS.commit)}
        </button>
        <button
          type="button"
          className="pcad-button"
          title={t(NUMERIC_INPUT_KEYS.cancelTooltip)}
          onMouseDown={keepFocus}
          onClick={() => {
            handleKey('Escape');
          }}
        >
          {t(NUMERIC_INPUT_KEYS.cancel)}
        </button>
      </div>
    </div>
  );
}
