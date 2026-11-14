import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { DEFAULT_VIEW_CONTROLS, withViewControlPreset } from './viewControlSettings.js';
import { CameraControlSettingsForm } from './CameraControlSettingsForm.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);
// Same static rendering as CameraControlSettingsForm.test.tsx (node environment, actual store snapshot).
function renderForm(): string {
  return renderCurrentStore(CameraControlSettingsForm);
}

describe('camera settings presets and named binding rows', () => {
  it('offers four labelled preset buttons without adding selects, fieldsets or check boxes', () => {
    const markup = renderForm();
    expect(markup.match(/<select\b/g)).toHaveLength(6);
    expect(markup.match(/<fieldset>/g)).toHaveLength(3);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(28);
    expect(markup).toContain(`role="group" aria-label="${t('settings.camera.presets')}"`);
    for (const key of ['pointercad', 'solidworks', 'fusion', 'onshape'] as const) {
      expect(markup).toContain(`>${t(`settings.camera.preset.${key}`)}</button>`);
    }
    expect(markup).toContain(t('settings.camera.presetHint'));
  });

  it('names every binding row so its modifier check boxes are announced with the binding number', () => {
    const markup = renderForm();
    const first = t('settings.camera.binding').replace('{number}', '1');
    const second = t('settings.camera.binding').replace('{number}', '2');
    expect(markup.match(new RegExp(`role="group" aria-label="${first}"`, 'g'))).toHaveLength(3);
    expect(markup.match(new RegExp(`role="group" aria-label="${second}"`, 'g'))).toHaveLength(3);
  });

  it('marks nothing invalid and links no error for valid saved settings', () => {
    const markup = renderForm();
    expect(markup).not.toContain('aria-invalid="true"');
    expect(markup).not.toMatch(/aria-describedby="[^"]*-error"/);
    expect(markup).not.toContain('role="alert"');
  });

  it('renders a saved preset as the current bindings', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, viewControls: withViewControlPreset(DEFAULT_VIEW_CONTROLS, 'onshape') });
    const markup = renderForm();
    const values = [...markup.matchAll(/<option value="([a-z]+)" selected="">/g)].map(match => match[1]);
    // orbit: right, none; pan: middle, right(+Ctrl); zoom: wheel, none.
    expect(values).toEqual(['right', 'none', 'middle', 'right', 'wheel', 'none']);
  });
});
