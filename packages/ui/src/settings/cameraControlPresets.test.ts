import { describe, expect, it } from 'vitest';
import { viewDragAction, viewWheelAction } from '../viewport/cameraControlBindings.js';
import { CAMERA_CONTROL_PRESETS } from './cameraControlSettings.js';
import { DEFAULT_VIEW_CONTROLS, readStoredViewControls, viewControlProblems, withViewControlPreset,
  type ViewControlSettings } from './viewControlSettings.js';

type Button = 'left' | 'middle' | 'right';
const BUTTON = { left: [0, 1], middle: [1, 4], right: [2, 2] } as const;
function drag(settings: ViewControlSettings, input: Button, keys: { alt?: boolean; shift?: boolean; ctrl?: boolean } = {}) {
  const [button, buttons] = BUTTON[input];
  return viewDragAction(settings, { pointerType: 'mouse', button, buttons, altKey: keys.alt ?? false,
    shiftKey: keys.shift ?? false, ctrlKey: keys.ctrl ?? false, metaKey: false });
}
const wheel = (settings: ViewControlSettings, ctrl = false) =>
  viewWheelAction(settings, { buttons: 0, altKey: false, shiftKey: false, ctrlKey: ctrl, metaKey: false }) === 'zoom';
const custom: ViewControlSettings = { ...DEFAULT_VIEW_CONTROLS, options: { ...DEFAULT_VIEW_CONTROLS.options,
  wheelSensitivity: 2.5, zoomDragSensitivity: 0.5, invertWheel: true, invertZoomDrag: true, orbitSensitivity: 3, invertOrbitX: true } };

describe('other-CAD camera presets through the actual binding resolver', () => {
  it('are all valid saved settings with at most two bindings per action and keep speeds and inversions', () => {
    for (const preset of CAMERA_CONTROL_PRESETS) {
      const value = withViewControlPreset(custom, preset);
      expect(viewControlProblems(value), preset).toEqual([]);
      expect(readStoredViewControls({ viewControls: JSON.parse(JSON.stringify(value)) as unknown })).toEqual({ settings: value, dropped: 0 });
      expect(value.options).toEqual(custom.options);
      for (const action of ['orbit', 'pan', 'zoom'] as const) expect(value.bindings[action].length).toBeLessThanOrEqual(2);
    }
  });

  it('PointerCAD preset is the shipped default bindings (Blender-like, FR-101)', () => {
    const value = withViewControlPreset(custom, 'pointercad');
    expect(drag(value, 'middle')).toBe('orbit');
    expect(drag(value, 'middle', { shift: true })).toBe('pan');
    expect(wheel(value)).toBe(true);
    expect(value.bindings).toEqual(DEFAULT_VIEW_CONTROLS.bindings);
  });

  it('SolidWorks-like: middle rotates, Ctrl+middle pans, Shift+middle and the wheel zoom', () => {
    const value = withViewControlPreset(custom, 'solidworks');
    expect(drag(value, 'middle')).toBe('orbit');
    expect(drag(value, 'middle', { ctrl: true })).toBe('pan');
    expect(drag(value, 'middle', { shift: true })).toBe('zoom');
    expect(wheel(value)).toBe(true);
    expect(drag(value, 'right')).toBeNull();
  });

  it('Fusion-like: Shift+middle rotates, middle pans, the wheel zooms', () => {
    const value = withViewControlPreset(custom, 'fusion');
    expect(drag(value, 'middle', { shift: true })).toBe('orbit');
    expect(drag(value, 'middle')).toBe('pan');
    expect(wheel(value)).toBe(true);
    expect(wheel(value, true)).toBe(false);
  });

  it('Onshape-like: right rotates, middle and Ctrl+right pan, the wheel zooms', () => {
    const value = withViewControlPreset(custom, 'onshape');
    expect(drag(value, 'right')).toBe('orbit');
    expect(drag(value, 'right', { ctrl: true })).toBe('pan');
    expect(drag(value, 'middle')).toBe('pan');
    expect(wheel(value)).toBe(true);
  });

  it('never takes plain or Shift/Ctrl left clicks away from selection and sketching', () => {
    for (const preset of CAMERA_CONTROL_PRESETS) {
      const value = withViewControlPreset(custom, preset);
      for (const keys of [{}, { shift: true }, { ctrl: true }]) expect(drag(value, 'left', keys), preset).toBeNull();
    }
  });

  it('does not change the settings it was given', () => {
    const before = JSON.stringify(custom);
    withViewControlPreset(custom, 'onshape');
    expect(JSON.stringify(custom)).toBe(before);
  });
});
