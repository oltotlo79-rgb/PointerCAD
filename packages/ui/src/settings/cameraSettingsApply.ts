import { useAppStore } from '../store/useAppStore.js';
import {
  CAMERA_ACTIONS, cameraBindingKey, isCameraControlSettings, readCameraControlSettings,
  type CameraControlSettings,
} from './cameraControlSettings.js';

function sameSettings(a: CameraControlSettings, b: CameraControlSettings): boolean {
  return a.version === b.version && a.wheelSensitivity === b.wheelSensitivity && a.dragSensitivity === b.dragSensitivity
    && a.invertWheel === b.invertWheel && a.invertDrag === b.invertDrag
    && CAMERA_ACTIONS.every(action => a[action].length === b[action].length
      && a[action].every((binding, index) => {
        const other = b[action][index];
        return other !== undefined && cameraBindingKey(binding) === cameraBindingKey(other);
      }));
}

/** Compare the edited preference only. A stale draft cannot replace another committed camera change. */
export function applyCameraSettings(proposed: unknown, expected: CameraControlSettings): boolean {
  if (!isCameraControlSettings(proposed)) return false;
  const state = useAppStore.getState();
  const current = readCameraControlSettings(state.displaySettings.cameraControls);
  // Reapplying an already committed value is harmless, including after an equivalent reload.
  if (sameSettings(current, proposed)) return true;
  if (!sameSettings(current, expected)) return false;
  state.setDisplaySettings({ ...state.displaySettings, cameraControls: proposed });
  return true;
}
