import { useId, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentSnapPauseModifier, SNAP_PAUSE_MODIFIERS, type SnapPauseModifier } from './snapPauseSetting.js';

const CHOICE_KEYS: Readonly<Record<SnapPauseModifier, MessageKey>> = {
  none: 'settings.snapPause.none', shift: 'settings.snapPause.shift', ctrl: 'settings.snapPause.ctrl',
};
/** 選んだキーが今ほかに何をしているか(点を置く道具の中で)。黙って働きを変えないよう、選ぶ前に示す。 */
const NOTE_KEYS: Readonly<Record<SnapPauseModifier, MessageKey>> = {
  none: 'settings.snapPause.noneNote', shift: 'settings.snapPause.shiftNote', ctrl: 'settings.snapPause.ctrlNote',
};

/**
 * 吸着を一時止める修飾キー(設計 B-09 3-2、操作の割り当ての窓のタブ「マウスのボタン」)。なし(既定)・Shift・Ctrl から選ぶ。
 * 下書きは適用するまで保存しない(窓を閉じる時の確かめは data-settings-draft で行う)。
 */
export function SnapPauseForm(): React.JSX.Element {
  const id = useId();
  const saved = useAppStore(state => currentSnapPauseModifier(state.displaySettings));
  const [draft, setDraft] = useState<SnapPauseModifier | null>(null);
  const value = draft ?? saved;
  return <form className="pcad-settings__group pcad-camera-settings" aria-label={t('settings.snapPause.title')}
    aria-describedby={`${id}-hint`} data-settings-draft={draft !== null} onSubmit={event => {
      event.preventDefault();
      if (draft === null) return;
      useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, snapPauseModifier: draft });
      setDraft(null);
    }}>
    <h3>{t('settings.snapPause.title')}</h3>
    <label>
      {t('settings.snapPause.label')}
      <select value={value} title={t('settings.snapPause.guide')} onChange={event => {
        const picked = SNAP_PAUSE_MODIFIERS.find(item => item === event.currentTarget.value);
        if (picked !== undefined) setDraft(picked === saved ? null : picked);
      }}>
        {SNAP_PAUSE_MODIFIERS.map(item => <option key={item} value={item}>{t(CHOICE_KEYS[item])}</option>)}
      </select>
    </label>
    <p role="note">{t(NOTE_KEYS[value])}</p>
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.snapPause.applyGuide')} disabled={draft === null}>
        {t('settings.snapPause.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.snapPause.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); }}>{t('settings.snapPause.cancel')}</button>
    </div>
    <p id={`${id}-hint`}>{t('settings.snapPause.hint')}</p>
  </form>;
}
