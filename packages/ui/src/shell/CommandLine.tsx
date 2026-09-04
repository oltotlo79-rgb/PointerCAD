import { useEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  acceptedWordOf,
  commandSuggestions,
  nextFieldLabels,
  pushCommandHistory,
  stepCommandHistory,
  submitCommandLine,
  type CommandLineFailure,
} from './commandLineActions.js';

/** 欄と見出しを結ぶ id。画面に 1 つしか無い欄なので固定の文字でよい。 */
const INPUT_ID = 'pcad-command-line-input';

/** 次に打つものの案内で、欄名をつなぐ区切り。文字そのものは言葉に依らないのでここに置く。 */
const LABEL_SEPARATOR = ' / ';

export interface CommandLineProps {
  /**
   * 断りが変わったときに呼ばれる。理由は帯の 1 文として出す(`statusText.ts` の優先順位へ
   * 割り込ませる)ので、持ち主はステータスバー側(`StatusBar.tsx`)。
   */
  readonly onFailureChange: (failure: CommandLineFailure | null) => void;
}

/**
 * コマンドラインの欄(計画書 docs/plans/P4b-スケッチの仕上げ.md タスク18、§0.a-0.8。FR-208)。
 *
 * ステータスバーの左、ファイル名の右へ埋め込む 1 行の欄。**区画は 5 つのまま**増やさない
 * (rules/04-設計の規律.md、要件§7.1)。打った 1 行の解釈と行き先はすべて
 * `commandLineActions.ts` の関数が決め、この部品は見た目とキーの詰め替えだけを受け持つ。
 *
 * 打ちかけの文字・履歴・履歴をたどっている位置は**表示だけの一時状態**なので、ここで
 * `useState` に持つ(`PropertyPanel.tsx` の打ちかけの下書きと同じ扱い。
 * rules/04-設計の規律.md「useState は表示専用の一時状態だけ」)。履歴は保存しない(§0.a-0.11)。
 *
 * **文書がまるごと差し替わったら(開く・新規・復元・Undo / Redo)欄を空にする。**
 * 焦点が欄にあるまま差し替わると、古い打ちかけが残って新しい文書と食い違うため
 * (docs/報告記録.md 2026-09-04 14:05 の 9b と同じ失敗。判定の材料も同じ `documentVersion`)。
 */
export function CommandLine({ onFailureChange }: CommandLineProps): React.JSX.Element {
  const documentVersion = useAppStore((state) => state.documentVersion);
  // いま開いている段の欄名を「次に打つもの」として出す(同じ文言を 2 か所に書かない)。
  const numericInput = useAppStore((state) => state.numericInput);
  const focusRequestCount = useAppStore((state) => state.commandLineFocusRequestCount);
  const inputRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState('');
  const [history, setHistory] = useState<readonly string[]>([]);
  /** 履歴をたどっている位置。-1 は「いま打っている行」(履歴の外)。 */
  const [historyIndex, setHistoryIndex] = useState(-1);

  useEffect(() => {
    // 文書が差し替わったら書きかけを捨てる(9b)。履歴は打った本人の記録なので残す。
    setText('');
    setHistoryIndex(-1);
    onFailureChange(null);
  }, [documentVersion, onFailureChange]);

  useEffect(() => {
    // Space(`AppShell.tsx`)で欄へ入る要求。焦点を持てるのはこの部品だけなので、
    // 増加に気づいたこちらが移す(`requestViewportFocus` と対になる仕組み)。
    if (focusRequestCount > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusRequestCount]);

  const suggestions = commandSuggestions(text);
  const fieldLabels = nextFieldLabels(numericInput);

  const changeText = (next: string): void => {
    setText(next);
    setHistoryIndex(-1);
    // 打ち直し始めたら古い断りは消す(NFR-UX-5)。
    onFailureChange(null);
  };

  const runSubmit = (): void => {
    const outcome = submitCommandLine(text);
    if (outcome.kind === 'error') {
      // 断ったときは打った文字を残す。直してもう一度 Enter を押せる(NFR-UX-3)。
      onFailureChange({ message: outcome.message, suggestions: outcome.suggestions });
      return;
    }
    onFailureChange(null);
    setHistory(pushCommandHistory(history, text));
    setHistoryIndex(-1);
    setText('');
  };

  const acceptSuggestion = (index: number): void => {
    const word = suggestions[index];
    if (word === undefined) {
      return;
    }
    changeText(acceptedWordOf(word, text));
    inputRef.current?.focus();
  };

  const walkHistory = (backwards: boolean): void => {
    const step = stepCommandHistory(history, historyIndex, backwards);
    setHistoryIndex(step.index);
    setText(step.text);
    onFailureChange(null);
  };

  const leave = (): void => {
    setText('');
    setHistoryIndex(-1);
    onFailureChange(null);
    // 焦点をビューポートへ戻す。canvas を持っているのは attachSketchInteraction だけなので、
    // 要求の数を増やして向こう側に移してもらう(NFR-UX-4)。
    useAppStore.getState().requestViewportFocus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // 日本語入力の変換中の Enter は変換の確定なので、こちらでは扱わない。
    if (event.nativeEvent.isComposing) {
      return;
    }
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        runSubmit();
        return;
      case 'Escape':
        event.preventDefault();
        leave();
        return;
      case 'Tab':
        if (suggestions.length > 0 && !event.shiftKey) {
          // 候補があるときだけ横取りする。無ければ Tab は次の欄へ進む働きのまま。
          event.preventDefault();
          acceptSuggestion(0);
        }
        return;
      case 'ArrowUp':
        event.preventDefault();
        walkHistory(true);
        return;
      case 'ArrowDown':
        event.preventDefault();
        walkHistory(false);
        return;
      default:
        // それ以外は欄へそのまま通す。ここで止めないので、`1`〜`4` はただの文字として入る
        // (ビューポートの割り当ては `AppShell.tsx` の isTextEntry が横取りを止めている)。
        return;
    }
  };

  return (
    <div className="pcad-commandline">
      {suggestions.length === 0 ? null : (
        /* 候補は欄の**上**へ出す(下はステータスバーの外、§0.a-0.11)。 */
        <div
          className="pcad-commandline__suggestions"
          role="listbox"
          aria-label={t('commandLine.suggestionsLabel')}
        >
          {suggestions.map((word, index) => (
            <button
              key={word.tool}
              type="button"
              role="option"
              aria-selected={index === 0}
              className="pcad-button pcad-commandline__suggestion"
              // 押しても欄から焦点を奪わない(NFR-UX-2 と同じ考え)。
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                acceptSuggestion(index);
              }}
            >
              <span className="pcad-commandline__suggestion-name">{t(word.labelKey)}</span>
              <span className="pcad-commandline__suggestion-word">{acceptedWordOf(word, text)}</span>
            </button>
          ))}
        </div>
      )}
      <label className="pcad-commandline__label" htmlFor={INPUT_ID}>
        {t('commandLine.label')}
      </label>
      <input
        id={INPUT_ID}
        ref={inputRef}
        type="text"
        className="pcad-commandline__input"
        value={text}
        title={t('commandLine.tooltip')}
        placeholder={t('commandLine.placeholder')}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          changeText(event.target.value);
        }}
        onFocus={() => {
          useAppStore.getState().setCommandLineFocused(true);
        }}
        onBlur={() => {
          useAppStore.getState().setCommandLineFocused(false);
        }}
        onKeyDown={onKeyDown}
      />
      {fieldLabels.length === 0 ? null : (
        /* 次に打つものは、いま開いている段の欄名をそのまま出す(§0.a-0.11)。 */
        <span className="pcad-commandline__next" aria-live="polite">
          {`${t('commandLine.nextLabel')} ${fieldLabels.join(LABEL_SEPARATOR)}`}
        </span>
      )}
    </div>
  );
}
