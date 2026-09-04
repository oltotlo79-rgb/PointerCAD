import { useEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ExpressionField } from './ExpressionField.js';
import {
  applyNumericInputKey,
  chooseNumericInput,
  COORDINATE_MODES,
  evaluateNumericInput,
  focusedTarget,
  asksCoordinate,
  MODE_LABEL_KEYS,
  MODE_TOOLTIP_KEYS,
  nextNumericInput,
  NUMERIC_INPUT_KEYS,
  numericChoiceOptionLabel,
  reduceNumericInput,
  splineFinishStateFrom,
  STEP_TITLE_KEYS,
  toggleNumericInput,
  type NumericChoice,
  type NumericFocusTarget,
  type NumericInputCommit,
  type NumericInputKey,
  type NumericInputState,
  type NumericInputTransition,
  type ReferenceInputCommit,
  type SolidInputCommit,
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

/**
 * 選択肢の一覧をこの個数を超えて持つときは、横並びのボタンではなく畳んだ一覧にする
 * (計画書タスク24「呼び径のような長い一覧は畳んだ一覧にする」)。呼び径(28個)だけが該当し、
 * 軸・向き・系列・決め方・巻き方向・求める値(いずれも4個以下)は横並びのままにする。
 */
const LONG_CHOICE_OPTION_THRESHOLD = 6;

/** 焦点の置き場所を、依存配列へ入れられる素の値で表す。 */
type FocusKind = NumericFocusTarget['kind'] | 'none';

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
 *
 * Space と ← → は、焦点がつまみ・選択肢にあるときだけ拾う。欄に焦点があるときに
 * 拾うと、空白が打てなくなり、カーソルも動かせなくなるため。
 */
function numericInputKeyFor(
  event: React.KeyboardEvent,
  coordinateStep: boolean,
  focusKind: FocusKind,
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
  if (event.key === ' ' && focusKind === 'toggle') {
    return 'Space';
  }
  if (focusKind === 'choice') {
    if (event.key === 'ArrowLeft') {
      return 'ArrowLeft';
    }
    if (event.key === 'ArrowRight') {
      return 'ArrowRight';
    }
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

interface ChoiceGroupProps {
  readonly choice: NumericChoice;
  /** 現在フォーカスがある要素(選択肢の並び1つぶん)へ入れる ref。 */
  readonly registerRef: (element: HTMLButtonElement | null) => void;
  readonly onSelect: (value: string) => void;
  /** ボタンを押しても欄から焦点を奪わない(NFR-UX-2)。 */
  readonly keepFocus: (event: React.MouseEvent) => void;
}

/**
 * 選択肢1つぶんの見出しと並び(計画書タスク24 §2.11)。
 * 短い一覧(4個以下)は横並びのボタン、長い一覧(呼び径28個)は畳んだ一覧
 * (Toolbar.tsx の吸着の種別の一覧と同じ pcad-menu の作り)にする。
 *
 * 開閉は見た目だけの一時状態なのでここでだけ持つ
 * (rules/04-設計の規律.md「useState は表示専用の一時状態だけ」)。
 */
function ChoiceGroup({ choice, registerRef, onSelect, keepFocus }: ChoiceGroupProps): React.JSX.Element {
  const isLong = choice.options.length > LONG_CHOICE_OPTION_THRESHOLD;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const groupLabel = t(choice.labelKey);

  useEffect(() => {
    if (!open) {
      return;
    }
    // 外を押したら閉じる。モーダルの覆いを作らないので、押した先の操作はそのまま通る。
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  if (!isLong) {
    return (
      <div className="pcad-popover__choice">
        <span className="pcad-popover__choice-label">{groupLabel}</span>
        <div
          className="pcad-segmented pcad-popover__choice-options"
          role="group"
          aria-label={groupLabel}
        >
          {choice.options.map((option) => (
            <button
              key={option.value}
              ref={option.value === choice.value ? registerRef : null}
              type="button"
              className="pcad-button"
              aria-pressed={option.value === choice.value}
              onMouseDown={keepFocus}
              onClick={() => {
                onSelect(option.value);
              }}
            >
              {numericChoiceOptionLabel(option)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const selected = choice.options.find((option) => option.value === choice.value) ?? null;

  return (
    <div className="pcad-popover__choice">
      <span className="pcad-popover__choice-label">{groupLabel}</span>
      <div className="pcad-menu" ref={containerRef}>
        <button
          ref={registerRef}
          type="button"
          className="pcad-button pcad-menu__trigger"
          aria-haspopup="true"
          aria-expanded={open}
          onMouseDown={keepFocus}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <span className="pcad-menu__count">{selected === null ? '' : numericChoiceOptionLabel(selected)}</span>
        </button>
        {open ? (
          <div className="pcad-menu__panel" role="group" aria-label={groupLabel}>
            {choice.options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                className="pcad-button pcad-menu__item"
                aria-pressed={option.value === choice.value}
                onMouseDown={keepFocus}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
              >
                {numericChoiceOptionLabel(option)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface NumericInputPopoverProps {
  /**
   * 決定されたときに呼ばれる。何を履歴へ積むかはこの部品では決めない
   * (計画書 タスク21 が渡す処理が決める)。
   */
  readonly onCommit: (commit: NumericInputCommit, state: NumericInputState) => void;
  /**
   * ソリッド(押し出し・回転・縫合・P3 の加工6種・ばね)を決めたときに呼ばれる。
   * 渡さなければソリッドの決定は捨てられる(ポップアップは閉じる)。
   */
  readonly onSolidCommit?: (commit: SolidInputCommit, state: NumericInputState) => void;
  /**
   * 基準ジオメトリ(作業平面・基準軸・基準点・座標系、FR-328、FR-329)を決めたときに
   * 呼ばれる。渡さなければ決定は捨てられる(ポップアップは閉じる)。
   */
  readonly onReferenceCommit?: (commit: ReferenceInputCommit, state: NumericInputState) => void;
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
 *
 * P3 で選択肢(choices)が配列になり(§2.11)、ばね(FR-414)は2段構えになった。
 * ばねの1段目の確定は `kind: 'open'` で返る(まだ利用者へ渡す完成した加工ではないため)。
 */
export function NumericInputPopover({
  onCommit,
  onSolidCommit,
  onReferenceCommit,
  viewportWidth,
  viewportHeight,
}: NumericInputPopoverProps): React.JSX.Element | null {
  const state = useAppStore((store) => store.numericInput);
  const anchor = useAppStore((store) => store.numericInputAnchor);

  // つまみと選択肢は入力欄ではないので、焦点は状態機械の指示でこちらから移す。
  const toggleRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const choiceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const target = state === null ? null : focusedTarget(state);
  const focusKind: FocusKind = target === null ? 'none' : target.kind;
  const focusToggleIndex = target !== null && target.kind === 'toggle' ? target.index : -1;
  const focusChoiceIndex = target !== null && target.kind === 'choice' ? target.index : -1;

  useEffect(() => {
    const element =
      focusKind === 'toggle'
        ? (toggleRefs.current[focusToggleIndex] ?? null)
        : focusKind === 'choice'
          ? (choiceRefs.current[focusChoiceIndex] ?? null)
          : null;
    if (element === null || element.ownerDocument.activeElement === element) {
      return;
    }
    element.focus();
  }, [focusKind, focusToggleIndex, focusChoiceIndex]);

  if (state === null || anchor === null) {
    return null;
  }

  const evaluation = evaluateNumericInput(state);
  const position = clampAnchor(anchor, viewportWidth, viewportHeight);
  const coordinateStep = asksCoordinate(state.step);
  // 欄が1つだけの段(押し出し・回転・縫合・R面取り)は、見出しの幅を内容に合わせる
  // (css の .pcad-popover__fields--wide の意図どおり)。2欄以上の段は P1 の座標と同じ
  // 固定幅に揃える(欄ごとに見出しの長さが大きく違っても列がずれないようにするため)。
  const wideFields = state.fields.length === 1;

  const update = (next: NumericInputState): void => {
    useAppStore.getState().updateNumericInput(next);
  };

  /** 押した先へ焦点の印も移す。Tab の続きが押した場所から始まるようにする。 */
  const updateAndFocus = (next: NumericInputState, index: number): void => {
    update(reduceNumericInput(next, { type: 'focus', index }));
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
      case 'solidCommitted':
        // ソリッドは(ばねの1段目を除き)1段で終わるので、決めたら必ず閉じる
        // (nextNumericInput も null を返す)。
        onSolidCommit?.(transition.commit, transition.state);
        useAppStore.getState().closeNumericInput();
        return;
      case 'referenceCommitted': {
        // 基準ジオメトリは 1 つ作ったら閉じる段と、次の点を聞く段がある(タスク13)。
        // どちらかは nextNumericInput が決めるので、スケッチと同じ流れで扱う。
        onReferenceCommit?.(transition.commit, transition.state);
        const next = nextNumericInput(transition.state, useAppStore.getState().chaining);
        if (next === null) {
          useAppStore.getState().closeNumericInput();
          return;
        }
        update(next);
        return;
      }
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
        const key = numericInputKeyFor(event, coordinateStep, focusKind);
        if (key === null) {
          return;
        }
        // 扱うキーだけを止める。ビューポートの視点操作へは流さない。
        // つまみの上での Space / Enter は、ここで止めることで押下が二重に起きない。
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

      {/*
        欄を持たない段(P4 のスプラインの決め方)では入れ物ごと出さない。
        .pcad-popover は縦並びの gap を持つので、空の入れ物を置くと見出しと選択肢の間に
        すき間が 1 つ余分に空くため(タスク11 で欄が 0 個の段ができた)。
      */}
      {state.fields.length === 0 ? null : (
        <div className={wideFields ? 'pcad-popover__fields pcad-popover__fields--wide' : 'pcad-popover__fields'}>
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
      )}

      {state.choices.map((choice, choiceIndex) => (
        <ChoiceGroup
          key={choice.key}
          choice={choice}
          keepFocus={keepFocus}
          registerRef={(element) => {
            choiceRefs.current[choiceIndex] = element;
          }}
          onSelect={(value) => {
            // 選んだ後の欄の数で焦点位置を数える。C面取りは「等距離」で欄が1つに
            // 減る(numericInput.ts の chamferFieldDefinitions)ため、選ぶ前の
            // state.fields.length を使うと輪の位置がずれる。
            const next = chooseNumericInput(state, choice.key, value);
            updateAndFocus(next, next.fields.length + choiceIndex);
          }}
        />
      ))}

      {state.toggles.length === 0 ? null : (
        <div className="pcad-popover__toggles">
          {state.toggles.map((toggle, index) => (
            <button
              key={toggle.key}
              ref={(element) => {
                toggleRefs.current[index] = element;
              }}
              type="button"
              role="switch"
              className="pcad-switch"
              aria-checked={toggle.value}
              onClick={() => {
                updateAndFocus(
                  toggleNumericInput(state, toggle.key),
                  state.fields.length + state.choices.length + index,
                );
              }}
            >
              <span className="pcad-switch__track" aria-hidden="true">
                <span className="pcad-switch__thumb" />
              </span>
              <span>{t(toggle.labelKey)}</span>
            </button>
          ))}
        </div>
      )}

      <p className="pcad-popover__hint">{t('numericInput.keyHint')}</p>

      <div className="pcad-popover__actions">
        {/*
          スプラインだけは「点をいくつ置くか」が決まっていないので、Enter は点を 1 つ置く
          合図のままにして、置き終えたことを伝えるボタンをここへ出す(FR-317、タスク12)。
          押すと「決め方」の段(通過点/制御点・閉じる)へ進む。
        */}
        {state.step === 'splinePoint' ? (
          <button
            type="button"
            className="pcad-button pcad-button--action"
            title={t('numericInput.splineFinishTooltip')}
            onMouseDown={keepFocus}
            onClick={() => {
              update(splineFinishStateFrom(state));
            }}
          >
            {t('numericInput.splineFinish')}
          </button>
        ) : null}
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
