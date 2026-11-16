import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { DEFAULT_VIEW_CONTROLS } from './viewControlSettings.js';
import { CameraControlSettingsForm } from './CameraControlSettingsForm.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);
function renderForm(): string {
  return renderCurrentStore(CameraControlSettingsForm);
}
describe('camera settings accessible form', () => {
  it('renders exactly two independently labelled bindings for each action and leaves document untouched', () => {
    const before = useAppStore.getState();
    const markup = renderForm();
    expect(markup.match(/<fieldset>/g)).toHaveLength(3);
    // Two binding rows per action, and the rotation and zoom centers (B-08d).
    expect(markup.match(/<select\b/g)).toHaveLength(6 + 2);
    // 6 rows x Alt/Shift/Ctrl/Meta, plus the rotation left-right/up-down and the wheel/drag zoom inversions.
    expect(markup.match(/type="checkbox"/g)).toHaveLength(28);
    // Rotation, pan, wheel zoom and drag zoom speeds, and the key rotation step (B-08).
    expect(markup.match(/type="number"/g)).toHaveLength(5);
    expect(markup).toContain(t('settings.camera.title'));
    expect(markup).toContain(t('settings.camera.hint'));
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(markup).not.toContain('role="status"');
    expect(useAppStore.getState()).toBe(before);
  });
  it('renders the current saved speeds and inversions instead of resetting them', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, viewControls: { ...DEFAULT_VIEW_CONTROLS, options: {
      ...DEFAULT_VIEW_CONTROLS.options, wheelSensitivity: 2.5, zoomDragSensitivity: 3, invertWheel: true,
      orbitSensitivity: 1.5, panSensitivity: 0.4, invertOrbitY: true,
    } } });
    const markup = renderForm();
    for (const value of ['2.5', '3', '1.5', '0.4']) expect(markup).toContain(`value="${value}"`);
    for (const key of ['invertWheel', 'invertOrbitX', 'invertOrbitY', 'orbitSensitivity', 'panSensitivity'] as const) {
      expect(markup).toContain(t(`settings.camera.${key}`));
    }
    // Only check boxes carry `checked`: the three default Alt/Shift/Ctrl rows plus the two saved inversions.
    expect(markup.match(/\schecked=""/g)).toHaveLength(2 + 3);
  });
  it('offers the wheel for rotation and pan too, and keeps a stored third binding visible', () => {
    const state = useAppStore.getState();
    const wheel = { kind: 'wheel', alt: false, shift: true, ctrl: false, meta: false } as const;
    state.setDisplaySettings({ ...state.displaySettings, viewControls: { ...DEFAULT_VIEW_CONTROLS, bindings: {
      ...DEFAULT_VIEW_CONTROLS.bindings, pan: [...DEFAULT_VIEW_CONTROLS.bindings.pan, wheel] } } });
    const markup = renderForm();
    expect(markup.match(/<select\b/g)).toHaveLength(7 + 2);
    expect(markup.match(new RegExp(`<option value="wheel"[^>]*>${t('settings.camera.wheel')}</option>`, 'g'))).toHaveLength(7);
    // Zoom rows 1 and 2 and the stored third pan row.
    expect(markup.match(/<option value="wheel" selected="">/g)).toHaveLength(3);
  });
  it('tells once that unreadable saved parts were reset, without an alert', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, viewControlsRecovered: 4 });
    const markup = renderForm();
    expect(markup).toContain(`<p role="status">${t('settings.camera.recovered').replace('{count}', '4')}</p>`);
    expect(markup).not.toContain('role="alert"');
  });
});

describe('タッチの指の割当(B-08g・B-08h)', () => {
  it('指の操作は合う操作の選択にだけ出し、1 本指の行の説明に引っぱる操作の注意を出す。下書きが無い時は窓の注意を出さない', () => {
    const state = useAppStore.getState(), base = DEFAULT_VIEW_CONTROLS.bindings;
    const off = { alt: false, shift: false, ctrl: false, meta: false } as const;
    state.setDisplaySettings({ ...state.displaySettings, viewControls: { ...DEFAULT_VIEW_CONTROLS, bindings: { ...base,
      orbit: [...base.orbit, { kind: 'touch', gesture: 'oneFinger', ...off }] } } });
    const markup = renderForm();
    // 行は回転 3(既定の 2＋1 本指)・平行移動 2・拡大縮小 2。1 本指・2 本指は回転と平行移動の選択に、つまむは拡大縮小の選択にだけ出る。
    expect(markup.match(/<option value="oneFinger"/gu)).toHaveLength(5);
    expect(markup.match(/<option value="twoFinger"/gu)).toHaveLength(5);
    expect(markup.match(/<option value="pinch"/gu)).toHaveLength(2);
    expect(markup).toContain('<option value="oneFinger" selected="">');
    expect(markup).toContain(t('settings.camera.touch.oneFingerNotice'));
    expect(markup).not.toContain('role="note"');
  });
});
