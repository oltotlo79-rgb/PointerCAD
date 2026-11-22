import { useId, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentSelectionModifier, SELECTION_MODIFIERS, selectionModifierOf, type SelectionModifier } from './selectionModifierSetting.js';

const CHOICE_KEYS: Readonly<Record<SelectionModifier, MessageKey>> = {
  local: 'settings.selectionModifier.local', shiftOrCtrl: 'settings.selectionModifier.shiftOrCtrl',
  shift: 'settings.selectionModifier.shift', ctrl: 'settings.selectionModifier.ctrl',
};

export function SelectionModifierForm(): React.JSX.Element {
  const hint = useId();
  const saved = useAppStore(state => currentSelectionModifier(state.displaySettings));
  const [draft, setDraft] = useState<SelectionModifier | null>(null);
  return <form className="pcad-settings__group pcad-camera-settings" aria-label={t('settings.selectionModifier.title')}
    aria-describedby={hint} data-settings-draft={draft !== null} onSubmit={event => {
      event.preventDefault();
      if (draft === null) return;
      const store = useAppStore.getState();
      store.setDisplaySettings({ ...store.displaySettings, selectionModifier: draft });
      setDraft(null);
    }}>
    <h3>{t('settings.selectionModifier.title')}</h3>
    <label>
      {t('settings.selectionModifier.label')}
      <select value={draft ?? saved} title={t('settings.selectionModifier.guide')} onChange={event => {
        const picked = selectionModifierOf(event.currentTarget.value);
        if (picked !== null) setDraft(picked === saved ? null : picked);
      }}>
        {SELECTION_MODIFIERS.map(item => <option key={item} value={item}>{t(CHOICE_KEYS[item])}</option>)}
      </select>
    </label>
    <p id={hint}>{t('settings.selectionModifier.guide')}</p>
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.selectionModifier.applyGuide')} disabled={draft === null}>
        {t('settings.selectionModifier.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.snapPause.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); }}>{t('settings.snapPause.cancel')}</button>
    </div>
  </form>;
}
