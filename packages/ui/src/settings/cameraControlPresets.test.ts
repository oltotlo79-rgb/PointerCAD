import { describe, expect, it } from 'vitest';
import { cameraDragAction, cameraWheelMatches } from '../viewport/cameraControlBindings.js';
import { CAMERA_CONTROL_PRESETS, DEFAULT_CAMERA_CONTROLS, cameraSettingsError, readCameraControlSettings, withCameraControlPreset,
  type CameraControlSettings } from './cameraControlSettings.js';

type Button = 'left' | 'middle' | 'right';
const BUTTON = { left: [0, 1], middle: [1, 4], right: [2, 2] } as const;
function drag(settings: CameraControlSettings, input: Button, keys: { alt?: boolean; shift?: boolean; ctrl?: boolean } = {}) {
  const [button, buttons] = BUTTON[input];
  return cameraDragAction(settings, { pointerType: 'mouse', button, buttons, altKey: keys.alt ?? false,
    shiftKey: keys.shift ?? false, ctrlKey: keys.ctrl ?? false, metaKey: false });
}
const wheel = (settings: CameraControlSettings, ctrl = false) =>
  cameraWheelMatches(settings, { buttons: 0, altKey: false, shiftKey: false, ctrlKey: ctrl, metaKey: false });
const custom: CameraControlSettings = { ...DEFAULT_CAMERA_CONTROLS, wheelSensitivity: 2.5, dragSensitivity: 0.5, invertWheel: true, invertDrag: true };

describe('other-CAD camera presets through the actual binding resolver', () => {
  it('are all valid saved settings with at most two bindings per action and keep sensitivity and inversion', () => {
    for (const preset of CAMERA_CONTROL_PRESETS) {
      const value = withCameraControlPreset(custom, preset);
      expect(cameraSettingsError(value), preset).toBeNull();
      expect(readCameraControlSettings(JSON.parse(JSON.stringify(value)))).toEqual(value);
      expect([value.wheelSensitivity, value.dragSensitivity, value.invertWheel, value.invertDrag]).toEqual([2.5, 0.5, true, true]);
      for (const action of ['orbit', 'pan', 'zoom'] as const) expect(value[action].length).toBeLessThanOrEqual(2);
    }
  });

  it('PointerCAD preset is the shipped default bindings (Blender-like, FR-101)', () => {
    const value = withCameraControlPreset(custom, 'pointercad');
    expect(drag(value, 'middle')).toBe('orbit');
    expect(drag(value, 'middle', { shift: true })).toBe('pan');
    expect(wheel(value)).toBe(true);
    expect({ orbit: value.orbit, pan: value.pan, zoom: value.zoom })
      .toEqual({ orbit: DEFAULT_CAMERA_CONTROLS.orbit, pan: DEFAULT_CAMERA_CONTROLS.pan, zoom: DEFAULT_CAMERA_CONTROLS.zoom });
  });

  it('SolidWorks-like: middle rotates, Ctrl+middle pans, Shift+middle and the wheel zoom', () => {
    const value = withCameraControlPreset(custom, 'solidworks');
    expect(drag(value, 'middle')).toBe('orbit');
    expect(drag(value, 'middle', { ctrl: true })).toBe('pan');
    expect(drag(value, 'middle', { shift: true })).toBe('zoom');
    expect(wheel(value)).toBe(true);
    expect(drag(value, 'right')).toBeNull();
  });

  it('Fusion-like: Shift+middle rotates, middle pans, the wheel zooms', () => {
    const value = withCameraControlPreset(custom, 'fusion');
    expect(drag(value, 'middle', { shift: true })).toBe('orbit');
    expect(drag(value, 'middle')).toBe('pan');
    expect(wheel(value)).toBe(true);
    expect(wheel(value, true)).toBe(false);
  });

  it('Onshape-like: right rotates, middle and Ctrl+right pan, the wheel zooms', () => {
    const value = withCameraControlPreset(custom, 'onshape');
    expect(drag(value, 'right')).toBe('orbit');
    expect(drag(value, 'right', { ctrl: true })).toBe('pan');
    expect(drag(value, 'middle')).toBe('pan');
    expect(wheel(value)).toBe(true);
  });

  it('never takes plain or Shift/Ctrl left clicks away from selection and sketching', () => {
    for (const preset of CAMERA_CONTROL_PRESETS) {
      const value = withCameraControlPreset(custom, preset);
      for (const keys of [{}, { shift: true }, { ctrl: true }]) expect(drag(value, 'left', keys), preset).toBeNull();
    }
  });

  it('does not change the settings it was given', () => {
    const before = JSON.stringify(custom);
    withCameraControlPreset(custom, 'onshape');
    expect(JSON.stringify(custom)).toBe(before);
  });
});
