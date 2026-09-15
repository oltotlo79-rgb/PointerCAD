import { useId, useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { DEFAULT_AUTO_SAVE_MINUTES, parseAutoSaveMinutes, readAutoSaveIntervalMs } from './autoSaveSettings.js';
import './autoSaveSettings.css';

export function AutoSaveIntervalForm(): React.JSX.Element {
  const id = useId(), errorId = `${id}-error`;
  const settings = useAppStore(state => state.displaySettings);
  const savedMinutes = readAutoSaveIntervalMs(settings) / 60_000;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(savedMinutes), minutes = parseAutoSaveMinutes(value);
  const dirty = draft !== null && minutes !== savedMinutes;
  const invalid = minutes === null;
  return <form className="pcad-settings__group pcad-auto-save-settings" aria-label={t('settings.autoSave.title')} data-help-topic="display-settings"
    onSubmit={event => {
      event.preventDefault();
      if (minutes === null) return;
      const state = useAppStore.getState();
      state.setDisplaySettings({ ...state.displaySettings, autoSaveIntervalMs: minutes * 60_000 });
      setDraft(null);
    }}>
    <label className="pcad-settings__label" htmlFor={id}>{t('settings.autoSave.minutes')}</label>
    <input id={id} type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
      className="pcad-field__input" value={value} title={t('settings.autoSave.range')}
      aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined}
      onChange={event => setDraft(event.currentTarget.value)} />
    {invalid ? <p id={errorId} role="alert">{t('settings.autoSave.range')}</p> : null}
    <p>{t('settings.autoSave.current').replace('{minutes}', String(savedMinutes))}</p>
    <div className="pcad-auto-save-settings__actions">
      <button className="pcad-button" type="submit" disabled={!dirty || invalid} title={t('settings.autoSave.apply')}>{t('settings.autoSave.apply')}</button>
      <button className="pcad-button" type="button" disabled={draft === null} title={t('settings.autoSave.cancel')} onClick={() => setDraft(null)}>{t('settings.autoSave.cancel')}</button>
      <button className="pcad-button" type="button" title={t('settings.autoSave.defaults')} onClick={() => setDraft(String(DEFAULT_AUTO_SAVE_MINUTES))}>{t('settings.autoSave.defaults')}</button>
    </div>
    <p>{t('settings.autoSave.hint')}</p>
  </form>;
}
