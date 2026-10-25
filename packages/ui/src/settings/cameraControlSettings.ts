export const CAMERA_ACTIONS = ['orbit', 'pan', 'zoom'] as const;
export type CameraAction = typeof CAMERA_ACTIONS[number];
export interface CameraBinding {
  readonly input: 'left' | 'middle' | 'right' | 'wheel';
  readonly alt: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}
export interface CameraControlSettings {
  readonly version: 1;
  readonly orbit: readonly CameraBinding[];
  readonly pan: readonly CameraBinding[];
  readonly zoom: readonly CameraBinding[];
  readonly wheelSensitivity: number;
  readonly dragSensitivity: number;
  readonly invertWheel: boolean;
  readonly invertDrag: boolean;
}
export type CameraSettingsError = 'count' | 'binding' | 'collision' | 'primary' | 'sensitivity';
const binding = (input: CameraBinding['input'], alt = false, shift = false, ctrl = false): CameraBinding =>
  ({ input, alt, shift, ctrl, meta: false });
/** Migration deliberately drops the third legacy pan (Alt+Shift+left). */
export const DEFAULT_CAMERA_CONTROLS: CameraControlSettings = {
  version: 1,
  orbit: [binding('middle'), binding('left', true)],
  pan: [binding('right'), binding('middle', false, true)],
  zoom: [binding('wheel'), binding('wheel', false, false, true)],
  wheelSensitivity: 1, dragSensitivity: 1, invertWheel: false, invertDrag: false,
};
/** Mouse bindings modelled on other CAD tools (their main view-drag/wheel bindings only; keyboard shortcuts,
 * view-cube and spin-center behavior of those programs are not reproduced). Sensitivity and inversion are user
 * preferences and are kept when a preset is chosen. Every preset satisfies cameraSettingsError (tested). */
export const CAMERA_CONTROL_PRESETS = ['pointercad', 'solidworks', 'fusion', 'onshape'] as const;
export type CameraControlPreset = typeof CAMERA_CONTROL_PRESETS[number];
const PRESET_BINDINGS: Readonly<Record<CameraControlPreset, Pick<CameraControlSettings, CameraAction>>> = {
  pointercad: { orbit: DEFAULT_CAMERA_CONTROLS.orbit, pan: DEFAULT_CAMERA_CONTROLS.pan, zoom: DEFAULT_CAMERA_CONTROLS.zoom },
  solidworks: { orbit: [binding('middle')], pan: [binding('middle', false, false, true)], zoom: [binding('wheel'), binding('middle', false, true)] },
  fusion: { orbit: [binding('middle', false, true)], pan: [binding('middle')], zoom: [binding('wheel')] },
  onshape: { orbit: [binding('right')], pan: [binding('middle'), binding('right', false, false, true)], zoom: [binding('wheel')] },
};
export function withCameraControlPreset(settings: CameraControlSettings, preset: CameraControlPreset): CameraControlSettings {
  const bindings = PRESET_BINDINGS[preset];
  return { ...settings, orbit: [...bindings.orbit], pan: [...bindings.pan], zoom: [...bindings.zoom] };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isCameraBinding(value: unknown): value is CameraBinding {
  return isRecord(value) && typeof value.input === 'string' && ['left', 'middle', 'right', 'wheel'].includes(value.input)
    && typeof value.alt === 'boolean' && typeof value.shift === 'boolean'
    && typeof value.ctrl === 'boolean' && typeof value.meta === 'boolean';
}
export function cameraBindingKey(value: CameraBinding): string {
  return [value.input, value.alt, value.shift, value.ctrl, value.meta].join(':');
}
export function cameraSettingsError(value: unknown): CameraSettingsError | null {
  if (!isRecord(value) || value.version !== 1) return 'binding';
  const seen = new Set<string>();
  for (const action of CAMERA_ACTIONS) {
    const bindings: unknown = value[action];
    if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 2) return 'count';
    for (const stored of bindings) {
      const item: unknown = stored;
      if (!isCameraBinding(item) || (action !== 'zoom' && item.input === 'wheel')) return 'binding';
      if (item.input === 'left' && !item.alt) return 'primary';
      const key = cameraBindingKey(item);
      if (seen.has(key)) return 'collision';
      seen.add(key);
    }
  }
  for (const key of ['wheelSensitivity', 'dragSensitivity']) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0.1 || number > 10) return 'sensitivity';
  }
  return typeof value.invertWheel === 'boolean' && typeof value.invertDrag === 'boolean' ? null : 'binding';
}
export function isCameraControlSettings(value: unknown): value is CameraControlSettings {
  return cameraSettingsError(value) === null;
}
/** Missing or corrupt camera settings recover locally, preserving other settings. */
export function readCameraControlSettings(value: unknown): CameraControlSettings {
  return isCameraControlSettings(value) ? value : DEFAULT_CAMERA_CONTROLS;
}
