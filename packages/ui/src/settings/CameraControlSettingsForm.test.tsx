import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { DEFAULT_CAMERA_CONTROLS } from './cameraControlSettings.js';
import { CameraControlSettingsForm } from './CameraControlSettingsForm.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);
function renderForm(): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(CameraControlSettingsForm)); }
  finally { snapshot.mockRestore(); }
}
describe('camera settings accessible form', () => {
  it('renders exactly two independently labelled bindings for each action and leaves document untouched', () => {
    const before = useAppStore.getState();
    const markup = renderForm();
    expect(markup.match(/<fieldset>/g)).toHaveLength(3);
    expect(markup.match(/<select\b/g)).toHaveLength(6);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(26);
    expect(markup).toContain(t('settings.camera.title'));
    expect(markup).toContain(t('settings.camera.hint'));
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(useAppStore.getState()).toBe(before);
  });
  it('renders the current saved sensitivity/inversion instead of resetting it', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, cameraControls: {
      ...DEFAULT_CAMERA_CONTROLS, wheelSensitivity: 2.5, dragSensitivity: 3, invertWheel: true,
    } });
    const markup = renderForm();
    expect(markup).toContain('value="2.5"');
    expect(markup).toContain('value="3"');
    expect(markup).toContain(t('settings.camera.invertWheel'));
  });
});
