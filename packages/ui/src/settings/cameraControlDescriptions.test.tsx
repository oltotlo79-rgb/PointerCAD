import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { CameraControlSettingsForm } from './CameraControlSettingsForm.js';
import { CAMERA_ACTIONS, CAMERA_CONTROL_PRESETS } from './cameraControlSettings.js';

/*
 * Every native control of the camera settings form carries a meaningful description (its title, the settings tooltip
 * convention read by assertRenderedControlDescriptions). Regression of host145 run 20261019-005830, where shortcut-
 * settings case 1 found an empty description on all camera controls (binding selects, Alt/Shift/Ctrl/Meta, sensitivity,
 * inversion, apply, cancel, defaults). The expected control count is derived from the form's own constants.
 */
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

function controls(html: string): { tag: string; title: string }[] {
  return [...html.matchAll(/<(input|select|button)\b([^>]*)>/gu)].map(match => {
    const title = /\stitle="([^"]*)"/u.exec(match[2] ?? '')?.[1] ?? '';
    return { tag: match[1] ?? '', title };
  });
}

describe('camera control settings descriptions', () => {
  const html = (): string => renderToStaticMarkup(<CameraControlSettingsForm />);

  it('gives every select, check box, number field and button a nonempty, translated description', () => {
    const found = controls(html());
    const perBinding = 1 + 4; // the input select and the Alt/Shift/Ctrl/Meta check boxes
    expect(found).toHaveLength(CAMERA_ACTIONS.length * 2 * perBinding + 2 + 2 + CAMERA_CONTROL_PRESETS.length + 3);
    expect(found.filter(control => control.title.trim() === '')).toEqual([]);
    // A missing i18n key would show the key itself instead of a sentence.
    expect(found.filter(control => control.title.startsWith('settings.'))).toEqual([]);
  });

  it('names the action, binding number and modifier in the binding descriptions, so they are not interchangeable', () => {
    const found = controls(html());
    const selects = found.filter(control => control.tag === 'select').map(control => control.title);
    expect(selects).toHaveLength(CAMERA_ACTIONS.length * 2);
    expect(new Set(selects).size).toBe(selects.length);
    for (const action of ['settings.camera.orbit', 'settings.camera.pan', 'settings.camera.zoom'] as const) {
      expect(selects.filter(title => title.includes(t(action)))).toHaveLength(2);
    }
    const modifiers = found.filter(control => control.tag === 'input' && (['alt', 'shift', 'ctrl', 'meta'] as const)
      .some(modifier => control.title.includes(t(`settings.camera.${modifier}`)))).map(control => control.title);
    expect(modifiers).toHaveLength(CAMERA_ACTIONS.length * 2 * 4);
    expect(new Set(modifiers).size).toBe(modifiers.length);
  });

  it('describes each preset by its name and the apply, cancel and default buttons differently', () => {
    const buttons = controls(html()).filter(control => control.tag === 'button').map(control => control.title);
    expect(new Set(buttons).size).toBe(buttons.length);
    for (const key of ['settings.camera.preset.pointercad', 'settings.camera.preset.solidworks', 'settings.camera.preset.fusion',
      'settings.camera.preset.onshape'] as const) {
      expect(buttons.filter(title => title.includes(t(key)))).toHaveLength(1);
    }
  });
});
