import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_CONTROLS } from '../settings/cameraControlSettings.js';
import { cameraDragAction, cameraWheelMatches } from './cameraControlBindings.js';

const modifiers = { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };
describe('exact camera gesture matching', () => {
  it('requires the exact button mask and every modifier', () => {
    const middle = { ...modifiers, pointerType: 'mouse', button: 1, buttons: 4 };
    expect(cameraDragAction(DEFAULT_CAMERA_CONTROLS, middle)).toBe('orbit');
    expect(cameraDragAction(DEFAULT_CAMERA_CONTROLS, { ...middle, shiftKey: true })).toBe('pan');
    expect(cameraDragAction(DEFAULT_CAMERA_CONTROLS, { ...middle, ctrlKey: true })).toBeNull();
    for (const buttons of [0, 1, 5, 6]) expect(cameraDragAction(DEFAULT_CAMERA_CONTROLS, { ...middle, buttons })).toBeNull();
    expect(cameraDragAction(DEFAULT_CAMERA_CONTROLS, { ...middle, pointerType: 'touch' })).toBeNull();
  });
  it('leaves plain and Shift/Ctrl primary selection untouched', () => {
    for (const extra of [{}, { shiftKey: true }, { ctrlKey: true }, { shiftKey: true, ctrlKey: true }]) {
      expect(cameraDragAction(DEFAULT_CAMERA_CONTROLS, { ...modifiers, pointerType: 'mouse', button: 0, buttons: 1, ...extra })).toBeNull();
    }
    expect(cameraDragAction(DEFAULT_CAMERA_CONTROLS, { ...modifiers, pointerType: 'mouse', button: 0, buttons: 1, altKey: true })).toBe('orbit');
  });
  it('does not silently retain the retired third pan or any-modifier wheel', () => {
    expect(cameraDragAction(DEFAULT_CAMERA_CONTROLS, { ...modifiers, pointerType: 'mouse', button: 0, buttons: 1, altKey: true, shiftKey: true })).toBeNull();
    expect(cameraWheelMatches(DEFAULT_CAMERA_CONTROLS, { ...modifiers, buttons: 0 })).toBe(true);
    expect(cameraWheelMatches(DEFAULT_CAMERA_CONTROLS, { ...modifiers, buttons: 0, ctrlKey: true })).toBe(true);
    expect(cameraWheelMatches(DEFAULT_CAMERA_CONTROLS, { ...modifiers, buttons: 0, shiftKey: true })).toBe(false);
    expect(cameraWheelMatches(DEFAULT_CAMERA_CONTROLS, { ...modifiers, buttons: 1 })).toBe(false);
  });
});
