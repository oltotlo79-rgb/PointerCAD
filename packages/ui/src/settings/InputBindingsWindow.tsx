import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { CameraControlSettingsForm } from './CameraControlSettingsForm.js';
import { MouseButtonsForm } from './MouseButtonsForm.js';
import { RadialMenuForm } from './RadialMenuForm.js';
import { settingsCloseRequest, submitSettingsDrafts } from './settingsDrafts.js';
import { SettingsDraftPrompt, type DraftPromptTexts } from './SettingsDraftPrompt.js';
import { ShortcutSettingsForm } from './ShortcutSettingsForm.js';
import './inputBindingsWindow.css';

/**
 * 操作の割り当ての窓(設計 1-4・§6)。動かせる窓(非モーダルの dialog)で、外を押しても閉じないので、開いたまま 3D で試せる。
 * タブ「視点の操作」「キー」「マウスのボタン」(B-08e)の中身は、それぞれ下書きを持つ form(CameraControlSettingsForm・
 * ShortcutSettingsForm・MouseButtonsForm)。
 * タブを替えても下書きを失わないよう、両方の form を置いたまま、見えない方を hidden にする。
 * ×・Esc で閉じる時に下書きがあれば、窓の中で［適用して閉じる］［捨てて閉じる］［続ける］を出す(settingsDrafts.ts の印)。
 */
type BindingsTab = 'view' | 'keys' | 'mouse' | 'radial';
/** 最後に開いたタブ(窓を開き直した時に同じタブで開く。端末には残さない一時の表示の状態)。 */
let lastTab: BindingsTab = 'view';

const WINDOW_DRAFT_TEXTS: DraftPromptTexts = {
  message: 'settings.inputBindings.draft.message', applyFailed: 'settings.inputBindings.draft.applyFailed',
  applyClose: 'settings.inputBindings.draft.applyClose', applyCloseGuide: 'settings.inputBindings.draft.applyCloseGuide',
  discardClose: 'settings.inputBindings.draft.discardClose', discardCloseGuide: 'settings.inputBindings.draft.discardCloseGuide',
  continue: 'settings.inputBindings.draft.continue', continueGuide: 'settings.inputBindings.draft.continueGuide',
};

export function InputBindingsWindow({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const id = useId();
  const [tab, setTab] = useState<BindingsTab>(lastTab);
  const [closing, setClosing] = useState<'confirm' | 'failed' | null>(null);
  /** 「適用して閉じる」で各 form を送った回数。送った後の描画で、下書きが残ったかを確かめる。 */
  const [applyRequest, setApplyRequest] = useState(0);
  const windowRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const choose = (next: BindingsTab): void => { lastTab = next; setTab(next); };
  const requestClose = (): void => {
    if (settingsCloseRequest(windowRef.current) === 'confirm') setClosing('confirm');
    else onClose();
  };
  // 各 form の送信が描画へ反映された後に、下書きが残っていれば閉じずに理由を出す。
  useEffect(() => {
    if (applyRequest === 0) return;
    if (settingsCloseRequest(windowRef.current) === 'confirm') setClosing('failed');
    else onCloseRef.current();
  }, [applyRequest]);
  return (
    <dialog open className="pcad-input-bindings" ref={windowRef} aria-labelledby={`${id}-title`} data-help-topic="shortcuts"
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        // 窓の Esc は窓だけのもの(設定の一覧や 3D の Esc へ渡さない)。確かめが出ている時は「続ける」。
        event.stopPropagation();
        if (closing !== null) setClosing(null);
        else requestClose();
      }}>
      <div className="pcad-input-bindings__header">
        <DraggableWindowTitle as="h2" id={`${id}-title`} className="pcad-input-bindings__title">{t('settings.inputBindings.title')}</DraggableWindowTitle>
        <button type="button" className="pcad-button" title={t('settings.inputBindings.closeGuide')} onClick={requestClose}>
          {t('settings.inputBindings.close')}</button>
      </div>
      {closing === null ? null : <SettingsDraftPrompt texts={WINDOW_DRAFT_TEXTS} failed={closing === 'failed'}
        onApply={() => {
          const element = windowRef.current;
          if (element !== null) submitSettingsDrafts({ querySelectorAll: selectors => element.querySelectorAll<HTMLFormElement>(selectors) });
          setApplyRequest(count => count + 1);
        }}
        onDiscard={onClose} onContinue={() => { setClosing(null); }} />}
      <div className="pcad-panel__tabs" role="tablist" aria-label={t('settings.inputBindings.tabs')}>
        <button type="button" role="tab" className="pcad-tab" id={`${id}-tab-view`} aria-controls={`${id}-panel-view`}
          aria-selected={tab === 'view'} title={t('settings.inputBindings.tab.viewGuide')} onClick={() => { choose('view'); }}>
          {t('settings.inputBindings.tab.view')}</button>
        <button type="button" role="tab" className="pcad-tab" id={`${id}-tab-keys`} aria-controls={`${id}-panel-keys`}
          aria-selected={tab === 'keys'} title={t('settings.inputBindings.tab.keysGuide')} onClick={() => { choose('keys'); }}>
          {t('settings.inputBindings.tab.keys')}</button>
        <button type="button" role="tab" className="pcad-tab" id={`${id}-tab-mouse`} aria-controls={`${id}-panel-mouse`}
          aria-selected={tab === 'mouse'} title={t('settings.inputBindings.tab.mouseGuide')} onClick={() => { choose('mouse'); }}>
          {t('settings.inputBindings.tab.mouse')}</button>
        <button type="button" role="tab" className="pcad-tab" id={`${id}-tab-radial`} aria-controls={`${id}-panel-radial`}
          aria-selected={tab === 'radial'} title={t('settings.inputBindings.tab.radialGuide')} onClick={() => { choose('radial'); }}>
          {t('settings.inputBindings.tab.radial')}</button>
      </div>
      <div role="tabpanel" id={`${id}-panel-view`} aria-labelledby={`${id}-tab-view`} hidden={tab !== 'view'}>
        <CameraControlSettingsForm />
      </div>
      <div role="tabpanel" id={`${id}-panel-keys`} aria-labelledby={`${id}-tab-keys`} hidden={tab !== 'keys'}>
        <ShortcutSettingsForm />
      </div>
      <div role="tabpanel" id={`${id}-panel-mouse`} aria-labelledby={`${id}-tab-mouse`} hidden={tab !== 'mouse'}>
        <MouseButtonsForm />
      </div>
      <div role="tabpanel" id={`${id}-panel-radial`} aria-labelledby={`${id}-tab-radial`} hidden={tab !== 'radial'}>
        <RadialMenuForm />
      </div>
      <p className="pcad-input-bindings__hint">{t('settings.inputBindings.hint')}</p>
    </dialog>
  );
}
