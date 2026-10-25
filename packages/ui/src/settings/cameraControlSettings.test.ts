import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_CONTROLS, cameraSettingsError, readCameraControlSettings } from './cameraControlSettings.js';
import { DEFAULT_DISPLAY_SETTINGS, loadSettings, saveSettings } from './settings.js';

describe('camera bindings validation and migration', () => {
  it('migrates old records locally to two explicit bindings per action', () => {
    const old = { theme: 'lightModern', uiScale: 125 };
    const loaded = loadSettings({ getItem: () => JSON.stringify(old), setItem: () => undefined });
    expect(loaded.theme).toBe(old.theme);
    expect(loaded.uiScale).toBe(125);
    expect(loaded.cameraControls).toEqual(DEFAULT_CAMERA_CONTROLS);
    expect(DEFAULT_CAMERA_CONTROLS.pan).toHaveLength(2);
    expect(DEFAULT_CAMERA_CONTROLS.pan.some(binding => binding.input === 'left')).toBe(false);
    expect(cameraSettingsError(DEFAULT_CAMERA_CONTROLS)).toBeNull();
  });
  it('rejects collisions, a third binding, reserved primary selection and invalid sensitivity', () => {
    expect(cameraSettingsError({ ...DEFAULT_CAMERA_CONTROLS, pan: DEFAULT_CAMERA_CONTROLS.orbit })).toBe('collision');
    expect(cameraSettingsError({ ...DEFAULT_CAMERA_CONTROLS, pan: [...DEFAULT_CAMERA_CONTROLS.pan, DEFAULT_CAMERA_CONTROLS.orbit[0]] })).toBe('count');
    expect(cameraSettingsError({ ...DEFAULT_CAMERA_CONTROLS, orbit: [{ input: 'left', alt: false, shift: true, ctrl: true, meta: false }] })).toBe('primary');
    for (const value of [0, 11, NaN, Infinity]) {
      expect(cameraSettingsError({ ...DEFAULT_CAMERA_CONTROLS, wheelSensitivity: value })).toBe('sensitivity');
    }
  });
  it('recovers malformed camera storage without resetting unrelated preferences', () => {
    for (const cameraControls of [null, {}, [], { ...DEFAULT_CAMERA_CONTROLS, orbit: [] },
      { ...DEFAULT_CAMERA_CONTROLS, zoom: [null] }, { ...DEFAULT_CAMERA_CONTROLS, invertWheel: 'yes' }]) {
      const loaded = loadSettings({ getItem: () => JSON.stringify({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'light', cameraControls }), setItem: () => undefined });
      expect(loaded.theme).toBe('light');
      expect(loaded.cameraControls).toEqual(DEFAULT_CAMERA_CONTROLS);
      expect(readCameraControlSettings(cameraControls)).toEqual(DEFAULT_CAMERA_CONTROLS);
    }
  });
  it('roundtrips one record and refuses invalid camera settings before any write', () => {
    const records = new Map<string, string>();
    const storage = { getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => { records.set(key, value); } };
    const configured = { ...DEFAULT_DISPLAY_SETTINGS, cameraControls: { ...DEFAULT_CAMERA_CONTROLS, invertWheel: true, dragSensitivity: 2 } };
    saveSettings(configured, storage);
    expect(loadSettings(storage)).toEqual(configured);
    expect([...records.keys()]).toEqual(['pointercad.settings']);
    const before = records.get('pointercad.settings');
    saveSettings({ ...configured, cameraControls: { ...DEFAULT_CAMERA_CONTROLS, pan: [] } }, storage);
    expect(records.get('pointercad.settings')).toBe(before);
  });
});
