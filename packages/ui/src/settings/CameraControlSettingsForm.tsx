import { useId, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyCameraSettings } from './cameraSettingsApply.js';
import { currentViewControls, DEFAULT_VIEW_CONTROLS, VIEW_ACTIONS, VIEW_CONTROL_PRESETS, VIEW_KEY_GROUP_ACTIONS, VIEW_KEY_GROUPS, viewControlProblems,
  withViewControlPreset, type ViewAction, type ViewControlOptions, type ViewControlPreset, type ViewControlSettings, type ViewKeyGroup,
  type ViewSettingsProblem, type ViewTrigger, viewKeyStepDegrees, ORBIT_CENTERS, viewOrbitCenter, viewZoomCenter, ZOOM_CENTERS, viewLeftEmptyOrbit,
  type OrbitCenter, type ZoomCenter, VIEW_TOUCH_GESTURE_ACTIONS, VIEW_TOUCH_GESTURES, type ViewTouchGesture, hasOneFingerTouch,
  VIEW_PEN_BUTTONS, type ViewPenButton,
} from './viewControlSettings.js';
import { placeViewTrigger, restoreViewAction, swapViewTrigger, takeViewTrigger, viewKeyCollisions } from './inputBindingsDraft.js';
import { commandDefinition } from '../commands/commandDefinitions.js';
import { currentShortcutAssignments } from './shortcutSettings.js';
import { viewTriggerLabel } from './inputCapture.js';
import { InputCapturePad, type CapturePlacement } from './InputCapturePad.js';
import './cameraControlSettings.css';

const ACTION_KEYS: Record<ViewAction, MessageKey> = {
  orbit: 'settings.camera.orbit', pan: 'settings.camera.pan', zoom: 'settings.camera.zoom',
};
const ERROR_KEYS: Record<ViewSettingsProblem['code'], MessageKey> = {
  shape: 'settings.camera.error.binding', 'not-allowed': 'settings.camera.error.binding',
  'left-needs-alt': 'settings.camera.error.primary', duplicate: 'settings.camera.error.collision',
  'mouse-required': 'settings.camera.error.mouseRequired', 'too-many': 'settings.camera.error.count',
  range: 'settings.camera.error.sensitivity',
};
/**
 * The select of one binding row: a mouse button drag, the wheel (a touchpad's two-finger scroll), a key group (B-08)
 * or a touch-screen finger gesture (B-08g).
 */
type SlotInput = 'left' | 'middle' | 'right' | ViewPenButton | 'wheel' | ViewKeyGroup | ViewTouchGesture;
/** マウスのボタン・ホイールと、ペンの側面のボタン・消しゴムの端(B-09 3-4。どの操作にも使える)。 */
const POINTER_INPUTS: readonly SlotInput[] = ['left', 'middle', 'right', 'wheel', ...VIEW_PEN_BUTTONS];
const INPUT_KEYS: Record<SlotInput, MessageKey> = {
  left: 'settings.camera.left', middle: 'settings.camera.middle', right: 'settings.camera.right', wheel: 'settings.camera.wheel',
  penBarrel: 'settings.camera.penBarrel', penEraser: 'settings.camera.penEraser',
  arrows: 'settings.camera.keys.arrows', numpad: 'settings.camera.keys.numpad', plusMinus: 'settings.camera.keys.plusMinus',
  oneFinger: 'settings.camera.touch.oneFinger', twoFinger: 'settings.camera.touch.twoFinger', pinch: 'settings.camera.touch.pinch',
};
/**
 * Mouse inputs for every action, and only the key groups and finger gestures that fit the action (arrows and numpad move,
 * plus/minus zooms; two fingers move, pinching zooms).
 */
function inputsFor(action: ViewAction): readonly SlotInput[] {
  return [...POINTER_INPUTS, ...VIEW_KEY_GROUPS.filter(group => VIEW_KEY_GROUP_ACTIONS[group].includes(action)),
    ...VIEW_TOUCH_GESTURES.filter(gesture => VIEW_TOUCH_GESTURE_ACTIONS[gesture].includes(action))];
}
function isKeyGroup(input: SlotInput): input is ViewKeyGroup {
  return (VIEW_KEY_GROUPS as readonly string[]).includes(input);
}
function isTouchGesture(input: SlotInput): input is ViewTouchGesture {
  return (VIEW_TOUCH_GESTURES as readonly string[]).includes(input);
}
const MODIFIERS = ['alt', 'shift', 'ctrl', 'meta'] as const;
const PRESET_KEYS: Record<ViewControlPreset, MessageKey> = {
  pointercad: 'settings.camera.preset.pointercad', solidworks: 'settings.camera.preset.solidworks',
  fusion: 'settings.camera.preset.fusion', onshape: 'settings.camera.preset.onshape', touchpad: 'settings.camera.preset.touchpad',
  keyboard: 'settings.camera.preset.keyboard', touchscreen: 'settings.camera.preset.touchscreen',
};
/** 4 つまで(viewControlSettings.ts の too-many と同じ数)。 */
const MAX_TRIGGERS = 4;
const PLACE: Record<CapturePlacement, typeof placeViewTrigger> = { place: placeViewTrigger, swap: swapViewTrigger, take: takeViewTrigger };
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
  if (trigger === undefined) return 'none';
  return trigger.kind === 'wheel' ? 'wheel' : trigger.kind === 'keys' ? trigger.keys
    : trigger.kind === 'touch' ? trigger.gesture : trigger.button;
}
/** A new input for a row keeps that row's modifiers; a fresh left drag starts with Alt (plain left is selection). */
function triggerFor(input: SlotInput, previous: ViewTrigger | undefined): ViewTrigger {
  const modifiers = { alt: previous?.alt ?? input === 'left', shift: previous?.shift ?? false,
    ctrl: previous?.ctrl ?? false, meta: previous?.meta ?? false };
  if (isKeyGroup(input)) return { kind: 'keys', keys: input, ...modifiers };
  // Finger gestures take no modifier keys (the row's check boxes are disabled for them).
  if (isTouchGesture(input)) return { kind: 'touch', gesture: input, alt: false, shift: false, ctrl: false, meta: false };
  return input === 'wheel' ? { kind: 'wheel', ...modifiers } : { kind: 'drag', button: input, ...modifiers };
}
/** 視点のキーと命令のキーの重なりの文(キーの組の名前と命令の名前)。 */
function keyCollisionText(trigger: ViewTrigger, commandId: string): string {
  const definition = commandDefinition(commandId);
  return t('settings.camera.error.keyCollision').replace('{keys}', viewTriggerLabel(trigger))
    .replace('{command}', definition === null ? commandId : t(definition.labelKey));
}
const ORBIT_CENTER_KEYS: Record<OrbitCenter, MessageKey> = {
  target: 'settings.camera.center.target', pointer: 'settings.camera.center.pointerShape', selection: 'settings.camera.center.selection',
};
const ZOOM_CENTER_KEYS: Record<ZoomCenter, MessageKey> = { target: 'settings.camera.center.target', pointer: 'settings.camera.center.pointer' };

/** 回転の中心と拡大の中心(B-08d、設計の「速さと向き」の第 2 段)。既定はどちらも画面の中心(今の動き)。 */
function ViewCenterFields({ value, onOrbit, onZoom }: {
  readonly value: ViewControlSettings;
  readonly onOrbit: (center: OrbitCenter) => void;
  readonly onZoom: (center: ZoomCenter) => void;
}): React.JSX.Element {
  return <>
    <label>
      {t('settings.camera.orbitCenter')}
      <select value={viewOrbitCenter(value.options)} title={t('settings.camera.orbitCenterGuide')} onChange={event => {
        const center = ORBIT_CENTERS.find(item => item === event.currentTarget.value);
        if (center !== undefined) onOrbit(center);
      }}>
        {ORBIT_CENTERS.map(center => <option key={center} value={center}>{t(ORBIT_CENTER_KEYS[center])}</option>)}
      </select>
    </label>
    <label>
      {t('settings.camera.zoomCenter')}
      <select value={viewZoomCenter(value.options)} title={t('settings.camera.zoomCenterGuide')} onChange={event => {
        const center = ZOOM_CENTERS.find(item => item === event.currentTarget.value);
        if (center !== undefined) onZoom(center);
      }}>
        {ZOOM_CENTERS.map(center => <option key={center} value={center}>{t(ZOOM_CENTER_KEYS[center])}</option>)}
      </select>
    </label>
  </>;
}

/** 適用を断る理由の文。キーで回す角度の範囲(1〜90)は速さの範囲(0.1〜10)と別の文にする。 */
function problemText(problem: ViewSettingsProblem): string {
  return t(problem.code === 'range' && problem.field === 'keyStepDegrees' ? 'settings.camera.error.keyStep' : ERROR_KEYS[problem.code]);
}
/** At least two rows per action; a stored third or fourth binding stays visible and editable. */
function rowIndexes(value: ViewControlSettings, action: ViewAction): number[] {
  return Array.from({ length: Math.max(2, value.bindings[action].length) }, (_, index) => index);
}

/**
 * 1 つの操作の割当(B-06): 割当の行(入力の選択・札・修飾キー)と、「＋」「既定に戻す」、取り込みの枠。
 * 取り込み中の行はこの部品だけの一時の状態(下書きの値は親の form が持つ)。
 */
function ViewActionFieldset({ id, action, value, bindingError, onReplace, onDraft }: {
  readonly id: string;
  readonly action: ViewAction;
  readonly value: ViewControlSettings;
  readonly bindingError: boolean;
  readonly onReplace: (action: ViewAction, index: number, trigger: ViewTrigger | null) => void;
  readonly onDraft: (value: ViewControlSettings) => void;
}): React.JSX.Element {
  /** 取り込み中の割当の番号(数を超える番号は足す)。 */
  const [capturing, setCapturing] = useState<number | null>(null);
  return <fieldset>
    <legend>{t(ACTION_KEYS[action])}</legend>
    <div className="pcad-camera-settings__actions">
      <button type="button" className="pcad-button" aria-label={bindingGuide('settings.camera.addGuide', action, 0)}
        title={bindingGuide('settings.camera.addGuide', action, 0)} disabled={value.bindings[action].length >= MAX_TRIGGERS}
        onClick={() => { setCapturing(value.bindings[action].length); }}>{t('settings.camera.add')}</button>
      <button type="button" className="pcad-button" title={bindingGuide('settings.camera.restoreActionGuide', action, 0)}
        onClick={() => { onDraft(restoreViewAction(value, action)); }}>{t('settings.camera.restoreAction')}</button>
    </div>
    {capturing === null ? null : <InputCapturePad action={action} actionLabel={t(ACTION_KEYS[action])}
      labelOf={owner => t(ACTION_KEYS[owner])} value={value} onCancel={() => { setCapturing(null); }}
      onPlace={(placement, trigger) => { onDraft(PLACE[placement](value, action, capturing, trigger)); setCapturing(null); }} />}
    {rowIndexes(value, action).map(index => {
      const trigger = value.bindings[action][index];
      // Each row is a named group, so its unchanged Alt/Shift/Ctrl/Meta check boxes are announced with their binding.
      return <div className="pcad-camera-settings__binding" key={index} role="group"
        aria-label={t('settings.camera.binding').replace('{number}', String(index + 1))}>
        <label htmlFor={`${id}-${action}-${index}`}>{t('settings.camera.binding').replace('{number}', String(index + 1))}</label>
        <select id={`${id}-${action}-${index}`} value={slotInput(trigger)}
          title={bindingGuide('settings.camera.bindingGuide', action, index) + (trigger?.kind === 'touch' && trigger.gesture === 'oneFinger'
            ? t('settings.camera.touch.oneFingerNotice') : '')}
          aria-invalid={bindingError} aria-describedby={bindingError ? `${id}-error` : undefined}
          onChange={event => {
            const input = inputsFor(action).find(input => input === event.currentTarget.value);
            onReplace(action, index, input === undefined ? null : triggerFor(input, trigger));
          }}>
          <option value="none">{t('settings.camera.none')}</option>
          {inputsFor(action).map(input => <option key={input} value={input}>{t(INPUT_KEYS[input])}</option>)}
        </select>
        {trigger === undefined ? null : <>
          <button type="button" className="pcad-button pcad-camera-settings__chip"
            title={bindingGuide('settings.camera.chipGuide', action, index)} onClick={() => { setCapturing(index); }}>{viewTriggerLabel(trigger)}</button>
          <button type="button" className="pcad-button pcad-camera-settings__chip-remove"
            aria-label={t('settings.camera.chipRemove').replace('{input}', viewTriggerLabel(trigger))}
            title={bindingGuide('settings.camera.chipRemoveGuide', action, index).replace('{input}', viewTriggerLabel(trigger))}
            onClick={() => { onReplace(action, index, null); }}>×</button>
        </>}
        {MODIFIERS.map(modifier => <label key={modifier}>
          <input type="checkbox" disabled={trigger === undefined || trigger.kind === 'touch'} checked={trigger?.[modifier] ?? false}
            title={bindingGuide('settings.camera.modifierGuide', action, index, t(`settings.camera.${modifier}`))}
            onChange={event => { if (trigger !== undefined) onReplace(action, index, { ...trigger, [modifier]: event.currentTarget.checked }); }} />
          {t(`settings.camera.${modifier}`)}
        </label>)}
      </div>;
    })}
  </fieldset>;
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
  // 視点のキーが命令のキーと同じ押し方になる時は適用しない(設計 §5 の key-collision。キーの割当の窓も同じ判定で断る)。
  const collision = viewKeyCollisions(value, currentShortcutAssignments(saved))[0] ?? null;
  const bindingError = problems.some(problem => problem.code !== 'range');
  const rangeFields = new Set(problems.flatMap(problem => problem.code === 'range' ? [problem.field] : []));
  /** キーの割当(矢印・テンキー)で 1 回に回す角度(B-08)。 */
  const keyStep = viewKeyStepDegrees(value.options);
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
      if (error !== null || collision !== null || draft === null) return;
      if (!applyCameraSettings(value, draft.expected)) { setApplyRefused(true); return; }
      setDraft(null);
      setApplyRefused(false);
    }}>
    <h3>{t('settings.camera.title')}</h3>
    {recovered > 0 ? <p role="status">{t('settings.camera.recovered').replace('{count}', String(recovered))}</p> : null}
    {VIEW_ACTIONS.map(action => <ViewActionFieldset key={action} id={id} action={action}
      value={value} bindingError={bindingError} onReplace={replaceBinding} onDraft={updateDraft} />)}
    {SPEED_FIELDS.map(({ field, label, guide }) => <label key={field}>
      {t(label)}
      <input type="number" min="0.1" max="10" step="0.1" value={Number.isFinite(value.options[field]) ? value.options[field] : ''}
        title={t(guide)}
        aria-invalid={rangeFields.has(field)} aria-describedby={rangeFields.has(field) ? `${id}-error` : undefined}
        onChange={event => updateOption(field, event.currentTarget.valueAsNumber)} />
    </label>)}
    <label>
      {t('settings.camera.keyStepDegrees')}
      <input type="number" min="1" max="90" step="1" value={Number.isFinite(keyStep) ? keyStep : ''} title={t('settings.camera.keyStepDegreesGuide')}
        aria-invalid={rangeFields.has('keyStepDegrees')} aria-describedby={rangeFields.has('keyStepDegrees') ? `${id}-error` : undefined}
        onChange={event => updateOption('keyStepDegrees', event.currentTarget.valueAsNumber)} />
    </label>
    <ViewCenterFields value={value} onOrbit={center => updateOption('orbitCenter', center)} onZoom={center => updateOption('zoomCenter', center)} />
    {/* 何も無い所からの左ドラッグで回す(B-09 3-3。既定は切)。入れている間は、将来の範囲の選択と同じ入力である事を出す。 */}
    <label>
      <input type="checkbox" checked={viewLeftEmptyOrbit(value.options)} title={t('settings.camera.leftEmptyOrbitGuide')}
        onChange={event => updateOption('leftEmptyOrbit', event.currentTarget.checked)} />
      {t('settings.camera.leftEmptyOrbit')}
    </label>
    {viewLeftEmptyOrbit(value.options) ? <p role="note">{t('settings.camera.leftEmptyOrbitNote')}</p> : null}
    {INVERT_FIELDS.map(({ field, label, guide }) => <label key={field}>
      <input type="checkbox" checked={value.options[field]} title={t(guide)}
        onChange={event => updateOption(field, event.currentTarget.checked)} />
      {t(label)}
    </label>)}
    {error === null ? null : <p role="alert" id={`${id}-error`}>{problemText(error)}</p>}
    {collision === null ? null : <p role="alert">{keyCollisionText(collision.trigger, collision.commandId)}</p>}
    {applyRefused ? <p role="alert">{t('settings.camera.applyStale')}</p> : null}
    {/* 1 本指のドラッグを割り当てた下書きを適用する時の注意(B-08h。適用は止めない)。 */}
    {draft !== null && hasOneFingerTouch(value) ? <p role="note">{t('settings.camera.touch.oneFingerNotice')}</p> : null}
    <div role="group" aria-label={t('settings.camera.presets')} aria-describedby={`${id}-preset-hint`} className="pcad-camera-settings__actions">
      {VIEW_CONTROL_PRESETS.map(preset => <button key={preset} type="button" className="pcad-button"
        title={t('settings.camera.presetGuide').replace('{preset}', t(PRESET_KEYS[preset]))}
        onClick={() => updateDraft(withViewControlPreset(value, preset))}>{t(PRESET_KEYS[preset])}</button>)}
    </div>
    <p id={`${id}-preset-hint`}>{t('settings.camera.presetHint')}</p>
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.camera.applyGuide')}
        disabled={draft === null || error !== null || collision !== null}>{t('settings.camera.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.camera.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); setApplyRefused(false); }}>{t('settings.camera.cancel')}</button>
      <button type="button" className="pcad-button" title={t('settings.camera.defaultsGuide')}
        onClick={() => updateDraft(DEFAULT_VIEW_CONTROLS)}>{t('settings.camera.defaults')}</button>
    </div>
    <p id={`${id}-hint`}>{t('settings.camera.hint')}</p>
  </form>;
}
