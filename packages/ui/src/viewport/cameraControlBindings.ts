import { CAMERA_ACTIONS, type CameraAction, type CameraBinding, type CameraControlSettings } from '../settings/cameraControlSettings.js';

type Modifiers = Pick<MouseEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;
export function cameraModifiersMatch(binding: CameraBinding, event: Modifiers): boolean {
  return binding.alt === event.altKey && binding.shift === event.shiftKey
    && binding.ctrl === event.ctrlKey && binding.meta === event.metaKey;
}
export function cameraDragAction(settings: CameraControlSettings, event: Modifiers & Pick<PointerEvent, 'pointerType' | 'button' | 'buttons'>): CameraAction | null {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return null;
  const input = event.button === 0 ? 'left' : event.button === 1 ? 'middle' : event.button === 2 ? 'right' : null;
  const buttons = input === 'left' ? 1 : input === 'middle' ? 4 : input === 'right' ? 2 : 0;
  if (input === null || event.buttons !== buttons) return null;
  return CAMERA_ACTIONS.find(action => settings[action].some(binding => binding.input === input
    && cameraModifiersMatch(binding, event))) ?? null;
}
export function cameraWheelMatches(settings: CameraControlSettings, event: Modifiers & Pick<WheelEvent, 'buttons'>): boolean {
  return event.buttons === 0 && settings.zoom.some(binding => binding.input === 'wheel' && cameraModifiersMatch(binding, event));
}
