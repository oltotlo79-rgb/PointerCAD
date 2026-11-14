import { useAppStore } from '../store/useAppStore.js';
import { currentViewControls, isViewControlSettings, sameViewControls, type ViewControlSettings } from './viewControlSettings.js';

/**
 * Compare the edited preference only. A stale draft cannot replace another committed camera change.
 * Only the v2 `viewControls` is written; the frozen v1 `cameraControls` keeps the bytes it was read with.
 */
export function applyCameraSettings(proposed: unknown, expected: ViewControlSettings): boolean {
  if (!isViewControlSettings(proposed)) return false;
  const state = useAppStore.getState();
  const current = currentViewControls(state.displaySettings);
  // Reapplying an already committed value is harmless, including after an equivalent reload.
  if (sameViewControls(current, proposed)) return true;
  if (!sameViewControls(current, expected)) return false;
  // Applying reviewed settings also retires the startup notice about unreadable parts.
  state.setDisplaySettings({ ...state.displaySettings, viewControls: proposed, viewControlsRecovered: undefined });
  return true;
}
