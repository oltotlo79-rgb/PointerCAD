import { useId, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentSnapRadius, SNAP_RADIUS_CHOICES, type SnapRadiusChoice } from './snapRadiusSetting.js';

const CHOICE_KEYS: Readonly<Record<SnapRadiusChoice, MessageKey>> = {
  small: 'settings.snapRadius.small', medium: 'settings.snapRadius.medium', large: 'settings.snapRadius.large',
};

/**
 * 吸着の幅(配置の補助 P-D、操作の割り当ての窓のタブ「マウスのボタン」。吸着を一時止めるキーの下)。小・中(既定)・大から選ぶ。
 * スケッチの点の吸着と、部品の頂点に吸い付く配置(一筆書きなど)の両方に効く。下書きは適用するまで保存しない(SnapPauseForm と同じ形)。
 */
export function SnapRadiusForm(): React.JSX.Element {
  const id = useId();
  const saved = useAppStore(state => currentSnapRadius(state.displaySettings));
  const [draft, setDraft] = useState<SnapRadiusChoice | null>(null);
  const value = draft ?? saved;
  return <form className="pcad-settings__group pcad-camera-settings" aria-label={t('settings.snapRadius.title')}
    aria-describedby={`${id}-hint`} data-settings-draft={draft !== null} onSubmit={event => {
      event.preventDefault();
      if (draft === null) return;
      useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, snapRadius: draft });
      setDraft(null);
    }}>
    <h3>{t('settings.snapRadius.title')}</h3>
    <label>
      {t('settings.snapRadius.label')}
      <select value={value} title={t('settings.snapRadius.guide')} onChange={event => {
        const picked = SNAP_RADIUS_CHOICES.find(item => item === event.currentTarget.value);
        if (picked !== undefined) setDraft(picked === saved ? null : picked);
      }}>
        {SNAP_RADIUS_CHOICES.map(item => <option key={item} value={item}>{t(CHOICE_KEYS[item])}</option>)}
      </select>
    </label>
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.snapRadius.applyGuide')} disabled={draft === null}>
        {t('settings.snapRadius.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.snapRadius.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); }}>{t('settings.snapRadius.cancel')}</button>
    </div>
    <p id={`${id}-hint`}>{t('settings.snapRadius.hint')}</p>
  </form>;
}
