import { useId, useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  currentGridSetting, GRID_MODES, validGridCount, validGridStep, type GridMode, type GridSetting,
} from './gridSetting.js';

interface GridDraft {
  readonly mode: GridMode;
  readonly step: string;
  readonly count: string;
}

const draftOf = (setting: GridSetting): GridDraft => ({ mode: setting.mode, step: String(setting.stepMm), count: String(setting.count) });

/** 下書きを設定にする。幅・数が読めない時は null(固定の時だけ確かめる。自動の時は今の幅・数を残す)。 */
function settingOf(draft: GridDraft, saved: GridSetting): GridSetting | null {
  if (draft.mode === 'auto') return { ...saved, mode: 'auto' };
  const stepMm = Number(draft.step), count = Number(draft.count);
  return draft.step.trim() !== '' && validGridStep(stepMm) && validGridCount(count) ? { mode: 'fixed', stepMm, count } : null;
}

/**
 * 方眼の幅と数(配置の補助 P-C、設定の一覧の「表示」の節)。自動(既定)か固定かを選び、固定の時は幅(mm)と原点から片側の線の数を入れる。
 * 固定の方眼は、スケッチの方眼への吸着と、一筆書きの点・部品のドラッグの方眼への吸着にも効く。下書きは適用するまで保存しない。
 */
export function GridSettingsForm(): React.JSX.Element {
  const id = useId(), errorId = `${id}-error`;
  const saved = useAppStore(state => currentGridSetting(state.displaySettings));
  const [draft, setDraft] = useState<GridDraft | null>(null);
  const value = draft ?? draftOf(saved);
  const next = settingOf(value, saved);
  const invalid = next === null;
  const edit = (patch: Partial<GridDraft>): void => { setDraft({ ...value, ...patch }); };
  return <form className="pcad-settings__group pcad-camera-settings" aria-label={t('settings.grid.title')} data-help-topic="display-settings"
    data-settings-draft={draft !== null} onSubmit={event => {
      event.preventDefault();
      if (next === null) return;
      const state = useAppStore.getState();
      state.setDisplaySettings({ ...state.displaySettings, grid: next });
      setDraft(null);
    }}>
    <h3>{t('settings.grid.title')}</h3>
    <label>
      {t('settings.grid.mode')}
      <select value={value.mode} title={t('settings.grid.modeGuide')} onChange={event => {
        const mode = GRID_MODES.find(item => item === event.currentTarget.value);
        if (mode !== undefined) edit({ mode });
      }}>
        {GRID_MODES.map(item => <option key={item} value={item}>{t(`settings.grid.mode.${item}`)}</option>)}
      </select>
    </label>
    <label>
      {t('settings.grid.step')}
      <input type="text" inputMode="decimal" autoComplete="off" spellCheck={false} className="pcad-field__input" value={value.step}
        title={t('settings.grid.stepGuide')} disabled={value.mode === 'auto'} aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined} onChange={event => { edit({ step: event.currentTarget.value }); }} />
      <span className="pcad-field__unit">mm</span>
    </label>
    <label>
      {t('settings.grid.count')}
      <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} className="pcad-field__input" value={value.count}
        title={t('settings.grid.countGuide')} disabled={value.mode === 'auto'} aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined} onChange={event => { edit({ count: event.currentTarget.value }); }} />
    </label>
    {invalid ? <p id={errorId} role="alert">{t('settings.grid.range')}</p> : null}
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.grid.applyGuide')} disabled={draft === null || invalid}>
        {t('settings.grid.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.grid.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); }}>{t('settings.grid.cancel')}</button>
    </div>
    <p>{t('settings.grid.hint')}</p>
  </form>;
}
