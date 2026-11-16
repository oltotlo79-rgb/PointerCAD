import { useAppStore } from '../store/useAppStore.js';
import type { ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { ShortcutAssignmentsForm } from './ShortcutAssignmentsForm.js';
import { currentShortcutAssignments, prepareShortcutSettings } from './shortcutSettings.js';
import { currentViewControls } from './viewControlSettings.js';

export function applyShortcutSettings(proposed: ShortcutAssignments, expected: ShortcutAssignments): boolean {
  const state = useAppStore.getState();
  const settings = prepareShortcutSettings(state.displaySettings, expected, proposed);
  if (settings === null) return false;
  state.setDisplaySettings(settings);
  return true;
}

export function ShortcutSettingsForm(): React.JSX.Element {
  const current = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const recovered = useAppStore(state => state.displaySettings.shortcutAssignmentsRecovered ?? 0);
  const viewControls = useAppStore(state => currentViewControls(state.displaySettings));
  return <ShortcutAssignmentsForm current={current} onApply={applyShortcutSettings} recovered={recovered} viewControls={viewControls} />;
}
