import { useId, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyCameraSettings } from './cameraSettingsApply.js';
import { CAMERA_CONTROL_PRESETS, type CameraControlPreset } from './cameraControlSettings.js';
import { currentViewControls, DEFAULT_VIEW_CONTROLS, VIEW_ACTIONS, viewControlProblems, withViewControlPreset,
  type ViewAction, type ViewControlOptions, type ViewControlSettings, type ViewSettingsProblem, type ViewTrigger } from './viewControlSettings.js';
import './cameraControlSettings.css';

const ACTION_KEYS: Record<ViewAction, MessageKey> = {
  orbit: 'settings.camera.orbit', pan: 'settings.camera.pan', zoom: 'settings.camera.zoom',
};
const ERROR_KEYS: Record<ViewSettingsProblem['code'], MessageKey> = {
  shape: 'settings.camera.error.binding', 'not-allowed': 'settings.camera.error.binding',
  'left-needs-alt': 'settings.camera.error.primary', duplicate: 'settings.camera.error.collision',
  'mouse-required': 'settings.camera.error.count', 'too-many': 'settings.camera.error.count',
  range: 'settings.camera.error.sensitivity',
};
/** The select of one binding row: a mouse button drag or the wheel (a touchpad's two-finger scroll), for every action. */
type SlotInput = 'left' | 'middle' | 'right' | 'wheel';
const INPUTS: readonly SlotInput[] = ['left', 'middle', 'right', 'wheel'];
const INPUT_KEYS: Record<SlotInput, MessageKey> = {
  left: 'settings.camera.left', middle: 'settings.camera.middle', right: 'settings.camera.right', wheel: 'settings.camera.wheel',
};
const MODIFIERS = ['alt', 'shift', 'ctrl', 'meta'] as const;
const PRESET_KEYS: Record<CameraControlPreset, MessageKey> = {
  pointercad: 'settings.camera.preset.pointercad', solidworks: 'settings.camera.preset.solidworks',
  fusion: 'settings.camera.preset.fusion', onshape: 'settings.camera.preset.onshape',
};
type SpeedField = 'orbitSensitivity' | 'panSensitivity' | 'wheelSensitivity' | 'zoomDragSensitivity';
type InvertField = 'invertOrbitX' | 'invertOrbitY' | 'invertWheel' | 'invertZoomDrag';
/** Label and description keys; the zoom fields keep their v1 wording and keys. */
const SPEED_FIELDS: readonly { readonly field: SpeedField; readonly label: MessageKey; readonly guide: MessageKey }[] = [
  { field: 'orbitSensitivity', label: 'settings.camera.orbitSensitivity', guide: 'settings.camera.orbitSensitivityGuide' },
  { field: 'panSensitivity', label: 'settings.camera.panSensitivity', guide: 'settings.camera.panSensitivityGuide' },
  { field: 'wheelSensitivity', label: 'settings.camera.wheelSensitivity', guide: 'settings.camera.wheelSensitivityGuide' },
  { field: 'zoomDragSensitivity', label: 'settings.camera.dragSensitivity', guide: 'settings.camera.dragSensitivityGuide' },
];
const INVERT_FIELDS: readonly { readonly field: InvertField; readonly label: MessageKey; readonly guide: MessageKey }[] = [
  { field: 'invertOrbitX', label: 'settings.camera.invertOrbitX', guide: 'settings.camera.invertOrbitXGuide' },
  { field: 'invertOrbitY', label: 'settings.camera.invertOrbitY', guide: 'settings.camera.invertOrbitYGuide' },
  { field: 'invertWheel', label: 'settings.camera.invertWheel', guide: 'settings.camera.invertWheelGuide' },
  { field: 'invertZoomDrag', label: 'settings.camera.invertDrag', guide: 'settings.camera.invertDragGuide' },
];
/** The description (native title, the settings tooltip convention) of one binding control, naming its action and row. */
function bindingGuide(key: MessageKey, action: ViewAction, index: number, modifier = ''): string {
  return t(key).replace('{action}', t(ACTION_KEYS[action])).replace('{number}', String(index + 1)).replace('{modifier}', modifier);
}
function slotInput(trigger: ViewTrigger | undefined): SlotInput | 'none' {
  return trigger === undefined ? 'none' : trigger.kind === 'wheel' ? 'wheel' : trigger.button;
}
/** A new input for a row keeps that row's modifiers; a fresh left drag starts with Alt (plain left is selection). */
function triggerFor(input: SlotInput, previous: ViewTrigger | undefined): ViewTrigger {
  const modifiers = { alt: previous?.alt ?? input === 'left', shift: previous?.shift ?? false,
    ctrl: previous?.ctrl ?? false, meta: previous?.meta ?? false };
  return input === 'wheel' ? { kind: 'wheel', ...modifiers } : { kind: 'drag', button: input, ...modifiers };
}
/** At least two rows per action; a stored third or fourth binding stays visible and editable. */
function rowIndexes(value: ViewControlSettings, action: ViewAction): number[] {
  return Array.from({ length: Math.max(2, value.bindings[action].length) }, (_, index) => index);
}

export function CameraControlSettingsForm(): React.JSX.Element {
  const id = useId();
  const saved = useAppStore(state => state.displaySettings);
  const recovered = useAppStore(state => state.displaySettings.viewControlsRecovered ?? 0);
  const [draft, setDraft] = useState<{ value: ViewControlSettings; expected: ViewControlSettings } | null>(null);
  const [applyRefused, setApplyRefused] = useState(false);
  const value = draft?.value ?? currentViewControls(saved);
  const problems = viewControlProblems(value);
  const error = problems[0] ?? null;
  const bindingError = problems.some(problem => problem.code !== 'range');
  const rangeFields = new Set(problems.flatMap(problem => problem.code === 'range' ? [problem.field] : []));
  function updateDraft(value: ViewControlSettings): void {
    setDraft(previous => ({ value, expected: previous?.expected ?? currentViewControls(saved) }));
    setApplyRefused(false);
  }
  function replaceBinding(action: ViewAction, index: number, trigger: ViewTrigger | null): void {
    const bindings = [...value.bindings[action]];
    if (trigger === null) bindings.splice(index, 1);
    else if (index >= bindings.length) bindings.push(trigger);
    else bindings[index] = trigger;
    updateDraft({ ...value, bindings: { ...value.bindings, [action]: bindings } });
  }
  function updateOption<K extends keyof ViewControlOptions>(key: K, option: ViewControlOptions[K]): void {
    updateDraft({ ...value, options: { ...value.options, [key]: option } });
  }
  return <form className="pcad-settings__group pcad-camera-settings" aria-label={t('settings.camera.title')}
    aria-describedby={`${id}-hint`} data-settings-draft={draft !== null} onSubmit={event => {
      event.preventDefault();
      if (error !== null || draft === null) return;
      if (!applyCameraSettings(value, draft.expected)) { setApplyRefused(true); return; }
      setDraft(null);
      setApplyRefused(false);
    }}>
    <h3>{t('settings.camera.title')}</h3>
    {recovered > 0 ? <p role="status">{t('settings.camera.recovered').replace('{count}', String(recovered))}</p> : null}
    {VIEW_ACTIONS.map(action => <fieldset key={action}>
      <legend>{t(ACTION_KEYS[action])}</legend>
      {rowIndexes(value, action).map(index => {
        const trigger = value.bindings[action][index];
        // Each row is a named group, so its unchanged Alt/Shift/Ctrl/Meta check boxes are announced with their binding.
        return <div className="pcad-camera-settings__binding" key={index} role="group"
          aria-label={t('settings.camera.binding').replace('{number}', String(index + 1))}>
          <label htmlFor={`${id}-${action}-${index}`}>{t('settings.camera.binding').replace('{number}', String(index + 1))}</label>
          <select id={`${id}-${action}-${index}`} value={slotInput(trigger)}
            title={bindingGuide('settings.camera.bindingGuide', action, index)}
            aria-invalid={bindingError} aria-describedby={bindingError ? `${id}-error` : undefined}
            onChange={event => {
              const input = INPUTS.find(input => input === event.currentTarget.value);
              replaceBinding(action, index, input === undefined ? null : triggerFor(input, trigger));
            }}>
            <option value="none">{t('settings.camera.none')}</option>
            {INPUTS.map(input => <option key={input} value={input}>{t(INPUT_KEYS[input])}</option>)}
          </select>
          {MODIFIERS.map(modifier => <label key={modifier}>
            <input type="checkbox" disabled={trigger === undefined} checked={trigger?.[modifier] ?? false}
              title={bindingGuide('settings.camera.modifierGuide', action, index, t(`settings.camera.${modifier}`))}
              onChange={event => { if (trigger !== undefined) replaceBinding(action, index, { ...trigger, [modifier]: event.currentTarget.checked }); }} />
            {t(`settings.camera.${modifier}`)}
          </label>)}
        </div>;
      })}
    </fieldset>)}
    {SPEED_FIELDS.map(({ field, label, guide }) => <label key={field}>
      {t(label)}
      <input type="number" min="0.1" max="10" step="0.1" value={Number.isFinite(value.options[field]) ? value.options[field] : ''}
        title={t(guide)}
        aria-invalid={rangeFields.has(field)} aria-describedby={rangeFields.has(field) ? `${id}-error` : undefined}
        onChange={event => updateOption(field, event.currentTarget.valueAsNumber)} />
    </label>)}
    {INVERT_FIELDS.map(({ field, label, guide }) => <label key={field}>
      <input type="checkbox" checked={value.options[field]} title={t(guide)}
        onChange={event => updateOption(field, event.currentTarget.checked)} />
      {t(label)}
    </label>)}
    {error === null ? null : <p role="alert" id={`${id}-error`}>{t(ERROR_KEYS[error.code])}</p>}
    {applyRefused ? <p role="alert">{t('settings.camera.applyStale')}</p> : null}
    <div role="group" aria-label={t('settings.camera.presets')} aria-describedby={`${id}-preset-hint`} className="pcad-camera-settings__actions">
      {CAMERA_CONTROL_PRESETS.map(preset => <button key={preset} type="button" className="pcad-button"
        title={t('settings.camera.presetGuide').replace('{preset}', t(PRESET_KEYS[preset]))}
        onClick={() => updateDraft(withViewControlPreset(value, preset))}>{t(PRESET_KEYS[preset])}</button>)}
    </div>
    <p id={`${id}-preset-hint`}>{t('settings.camera.presetHint')}</p>
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.camera.applyGuide')}
        disabled={draft === null || error !== null}>{t('settings.camera.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.camera.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); setApplyRefused(false); }}>{t('settings.camera.cancel')}</button>
      <button type="button" className="pcad-button" title={t('settings.camera.defaultsGuide')}
        onClick={() => updateDraft(DEFAULT_VIEW_CONTROLS)}>{t('settings.camera.defaults')}</button>
    </div>
    <p id={`${id}-hint`}>{t('settings.camera.hint')}</p>
  </form>;
}
