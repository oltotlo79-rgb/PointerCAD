import { useId, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyCameraSettings } from './cameraSettingsApply.js';
import { CAMERA_ACTIONS, CAMERA_CONTROL_PRESETS, DEFAULT_CAMERA_CONTROLS, cameraSettingsError, readCameraControlSettings,
  withCameraControlPreset, type CameraControlPreset,
  type CameraAction, type CameraBinding, type CameraControlSettings, type CameraSettingsError } from './cameraControlSettings.js';
import './cameraControlSettings.css';

const ACTION_KEYS: Record<CameraAction, MessageKey> = {
  orbit: 'settings.camera.orbit', pan: 'settings.camera.pan', zoom: 'settings.camera.zoom',
};
const ERROR_KEYS: Record<CameraSettingsError, MessageKey> = {
  count: 'settings.camera.error.count', binding: 'settings.camera.error.binding', collision: 'settings.camera.error.collision',
  primary: 'settings.camera.error.primary', sensitivity: 'settings.camera.error.sensitivity',
};
const INPUTS: readonly CameraBinding['input'][] = ['left', 'middle', 'right', 'wheel'];
const INPUT_KEYS: Record<CameraBinding['input'], MessageKey> = {
  left: 'settings.camera.left', middle: 'settings.camera.middle', right: 'settings.camera.right', wheel: 'settings.camera.wheel',
};
const MODIFIERS = ['alt', 'shift', 'ctrl', 'meta'] as const;
const PRESET_KEYS: Record<CameraControlPreset, MessageKey> = {
  pointercad: 'settings.camera.preset.pointercad', solidworks: 'settings.camera.preset.solidworks',
  fusion: 'settings.camera.preset.fusion', onshape: 'settings.camera.preset.onshape',
};
/** Errors that belong to the binding selects; a sensitivity error marks only the sensitivity fields. */
const BINDING_ERRORS: ReadonlySet<CameraSettingsError> = new Set<CameraSettingsError>(['count', 'binding', 'collision', 'primary']);
/** The description (native title, the settings tooltip convention) of one binding control, naming its action and row. */
function bindingGuide(key: MessageKey, action: CameraAction, index: number, modifier = ''): string {
  return t(key).replace('{action}', t(ACTION_KEYS[action])).replace('{number}', String(index + 1)).replace('{modifier}', modifier);
}

export function CameraControlSettingsForm(): React.JSX.Element {
  const id = useId();
  const saved = useAppStore(state => state.displaySettings.cameraControls);
  const [draft, setDraft] = useState<{ value: CameraControlSettings; expected: CameraControlSettings } | null>(null);
  const [applyRefused, setApplyRefused] = useState(false);
  const value = draft?.value ?? readCameraControlSettings(saved);
  const error = cameraSettingsError(value);
  const bindingError = error !== null && BINDING_ERRORS.has(error);
  function updateDraft(value: CameraControlSettings): void {
    setDraft(previous => ({ value, expected: previous?.expected ?? readCameraControlSettings(saved) }));
    setApplyRefused(false);
  }
  function replaceBinding(action: CameraAction, index: number, binding: CameraBinding | null): void {
    const bindings = [...value[action]];
    if (binding === null) bindings.splice(index, 1);
    else bindings[index] = binding;
    updateDraft({ ...value, [action]: bindings });
  }
  return <form className="pcad-settings__group pcad-camera-settings" aria-label={t('settings.camera.title')}
    aria-describedby={`${id}-hint`} onSubmit={event => {
      event.preventDefault();
      if (error !== null || draft === null) return;
      if (!applyCameraSettings(value, draft.expected)) { setApplyRefused(true); return; }
      setDraft(null);
      setApplyRefused(false);
    }}>
    <h3>{t('settings.camera.title')}</h3>
    {CAMERA_ACTIONS.map(action => <fieldset key={action}>
      <legend>{t(ACTION_KEYS[action])}</legend>
      {[0, 1].map(index => {
        const binding = value[action][index];
        // Each row is a named group, so its unchanged Alt/Shift/Ctrl/Meta check boxes are announced with their binding.
        return <div className="pcad-camera-settings__binding" key={index} role="group"
          aria-label={t('settings.camera.binding').replace('{number}', String(index + 1))}>
          <label htmlFor={`${id}-${action}-${index}`}>{t('settings.camera.binding').replace('{number}', String(index + 1))}</label>
          <select id={`${id}-${action}-${index}`} value={binding?.input ?? 'none'}
            title={bindingGuide('settings.camera.bindingGuide', action, index)}
            aria-invalid={bindingError} aria-describedby={bindingError ? `${id}-error` : undefined}
            onChange={event => {
              const input = INPUTS.find(input => input === event.currentTarget.value);
              replaceBinding(action, index, input === undefined ? null : {
                input, alt: binding?.alt ?? input === 'left', shift: binding?.shift ?? false,
                ctrl: binding?.ctrl ?? false, meta: binding?.meta ?? false,
              });
            }}>
            <option value="none">{t('settings.camera.none')}</option>
            {INPUTS.filter(input => action === 'zoom' || input !== 'wheel').map(input =>
              <option key={input} value={input}>{t(INPUT_KEYS[input])}</option>)}
          </select>
          {MODIFIERS.map(modifier => <label key={modifier}>
            <input type="checkbox" disabled={binding === undefined} checked={binding?.[modifier] ?? false}
              title={bindingGuide('settings.camera.modifierGuide', action, index, t(`settings.camera.${modifier}`))}
              onChange={event => { if (binding !== undefined) replaceBinding(action, index, { ...binding, [modifier]: event.currentTarget.checked }); }} />
            {t(`settings.camera.${modifier}`)}
          </label>)}
        </div>;
      })}
    </fieldset>)}
    {(['wheelSensitivity', 'dragSensitivity'] as const).map(key => <label key={key}>
      {t(`settings.camera.${key}`)}
      <input type="number" min="0.1" max="10" step="0.1" value={Number.isFinite(value[key]) ? value[key] : ''}
        title={t(`settings.camera.${key}Guide`)}
        aria-invalid={error === 'sensitivity'} aria-describedby={error === 'sensitivity' ? `${id}-error` : undefined}
        onChange={event => updateDraft({ ...value, [key]: event.currentTarget.valueAsNumber })} />
    </label>)}
    {(['invertWheel', 'invertDrag'] as const).map(key => <label key={key}>
      <input type="checkbox" checked={value[key]} title={t(`settings.camera.${key}Guide`)}
        onChange={event => updateDraft({ ...value, [key]: event.currentTarget.checked })} />
      {t(`settings.camera.${key}`)}
    </label>)}
    {error === null ? null : <p role="alert" id={`${id}-error`}>{t(ERROR_KEYS[error])}</p>}
    {applyRefused ? <p role="alert">{t('settings.camera.applyStale')}</p> : null}
    <div role="group" aria-label={t('settings.camera.presets')} aria-describedby={`${id}-preset-hint`} className="pcad-camera-settings__actions">
      {CAMERA_CONTROL_PRESETS.map(preset => <button key={preset} type="button" className="pcad-button"
        title={t('settings.camera.presetGuide').replace('{preset}', t(PRESET_KEYS[preset]))}
        onClick={() => updateDraft(withCameraControlPreset(value, preset))}>{t(PRESET_KEYS[preset])}</button>)}
    </div>
    <p id={`${id}-preset-hint`}>{t('settings.camera.presetHint')}</p>
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.camera.applyGuide')}
        disabled={draft === null || error !== null}>{t('settings.camera.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.camera.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); setApplyRefused(false); }}>{t('settings.camera.cancel')}</button>
      <button type="button" className="pcad-button" title={t('settings.camera.defaultsGuide')}
        onClick={() => updateDraft(DEFAULT_CAMERA_CONTROLS)}>{t('settings.camera.defaults')}</button>
    </div>
    <p id={`${id}-hint`}>{t('settings.camera.hint')}</p>
  </form>;
}
