import type { ModifierKeys } from './snapPauseSetting.js';

export const SELECTION_MODIFIERS = ['local', 'shiftOrCtrl', 'shift', 'ctrl'] as const;
export type SelectionModifier = (typeof SELECTION_MODIFIERS)[number];
export const DEFAULT_SELECTION_MODIFIER: SelectionModifier = 'local';

/**
 * Existing behavior at the input surfaces, also used by their drag guards. 'ctrl' here is the drawing tree's
 * Ctrl or Cmd; the other local modes never include Cmd.
 */
export const LOCAL_SELECTION_MODIFIERS = {
  partViewport: 'shiftOrCtrl', assemblyViewport: 'shift', drawingCanvas: 'shiftOrCtrl',
  featureTree: 'shiftOrCtrl', assemblyTree: 'shift', radialMenu: 'shiftOrCtrl', drawingTree: 'ctrl',
} as const;
type LocalSelectionModifier = (typeof LOCAL_SELECTION_MODIFIERS)[keyof typeof LOCAL_SELECTION_MODIFIERS];

export function selectionModifierOf(raw: unknown): SelectionModifier | null {
  return SELECTION_MODIFIERS.find(value => value === raw) ?? null;
}

export function currentSelectionModifier(settings: { readonly selectionModifier?: unknown } | undefined): SelectionModifier {
  return selectionModifierOf(settings?.selectionModifier) ?? DEFAULT_SELECTION_MODIFIER;
}

/** Cmd participates only when the user explicitly chooses a mode that includes Ctrl. */
export function selectionUsesMeta(modifier: SelectionModifier | undefined): boolean {
  return modifier === 'ctrl' || modifier === 'shiftOrCtrl';
}

export function addsToSelection(modifier: SelectionModifier | undefined, keys: ModifierKeys, local: LocalSelectionModifier): boolean {
  const explicit = modifier !== undefined && modifier !== 'local';
  const mode = explicit ? modifier : local;
  const meta = explicit ? selectionUsesMeta(modifier) : local === 'ctrl';
  if (mode === 'shift') return keys.shiftKey;
  return (mode === 'shiftOrCtrl' && keys.shiftKey) || keys.ctrlKey || (meta && keys.metaKey);
}
