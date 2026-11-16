import { useEffect, useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';

/** 下書きの確かめの文言(設定の一覧と操作の割り当ての窓で、閉じる相手の名前だけが違う)。 */
export interface DraftPromptTexts {
  readonly message: MessageKey;
  readonly applyFailed: MessageKey;
  readonly applyClose: MessageKey;
  readonly applyCloseGuide: MessageKey;
  readonly discardClose: MessageKey;
  readonly discardCloseGuide: MessageKey;
  readonly continue: MessageKey;
  readonly continueGuide: MessageKey;
}

/** 下書きがある時の確かめ。窓の中に出し、モーダルにしない(NFR-UX-3)。 */
export function SettingsDraftPrompt({ texts, failed, onApply, onDiscard, onContinue }: {
  readonly texts: DraftPromptTexts;
  readonly failed: boolean;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly onContinue: () => void;
}): React.JSX.Element {
  const firstRef = useRef<HTMLButtonElement>(null);
  // 確かめが出たら、キーボードの人がすぐ選べるよう最初の選択へ焦点を移す。
  useEffect(() => { firstRef.current?.focus(); }, []);
  return (
    <div className="pcad-settings__draft" role="group" aria-label={t(texts.message)}>
      <p role="status">{t(texts.message)}</p>
      {failed ? <p role="alert">{t(texts.applyFailed)}</p> : null}
      <div className="pcad-settings__draft-actions">
        <button ref={firstRef} type="button" className="pcad-button" title={t(texts.applyCloseGuide)}
          onClick={onApply}>{t(texts.applyClose)}</button>
        <button type="button" className="pcad-button" title={t(texts.discardCloseGuide)}
          onClick={onDiscard}>{t(texts.discardClose)}</button>
        <button type="button" className="pcad-button" title={t(texts.continueGuide)}
          onClick={onContinue}>{t(texts.continue)}</button>
      </div>
    </div>
  );
}
