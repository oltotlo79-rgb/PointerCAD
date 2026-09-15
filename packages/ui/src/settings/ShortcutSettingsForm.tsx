import { useAppStore } from '../store/useAppStore.js';
import type { ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { ShortcutAssignmentsForm } from './ShortcutAssignmentsForm.js';
import { currentShortcutAssignments, prepareShortcutSettings } from './shortcutSettings.js';

export function applyShortcutSettings(proposed: ShortcutAssignments, expected: ShortcutAssignments): boolean {
  const state = useAppStore.getState();
  const settings = prepareShortcutSettings(state.displaySettings, expected, proposed);
  if (settings === null) return false;
  state.setDisplaySettings(settings);
  return true;
}

export function ShortcutSettingsForm(): React.JSX.Element {
  const current = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  return <ShortcutAssignmentsForm current={current} onApply={applyShortcutSettings} />;
}
