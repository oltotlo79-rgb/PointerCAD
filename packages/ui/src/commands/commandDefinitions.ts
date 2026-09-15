import { TOOLBAR_COMMAND_CATALOG, type ToolbarCommandId } from './toolbarCommandCatalog.js';
import type { MessageKey } from '../i18n/t.js';

export type CommandDocumentKind = 'part' | 'assembly' | 'drawing';
export type CommandPhase = 'capture' | 'bubble';
export type PrimaryModifier = 'none' | 'ctrl' | 'ctrl-or-meta' | 'any';
export type ShiftRequirement = 'forbidden' | 'required' | 'either';

export interface CommandKeyInput {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly repeat: boolean;
}

export interface CommandKeyContext {
  readonly documentKind: CommandDocumentKind;
  readonly phase: CommandPhase;
  readonly helpOpen: boolean;
  readonly textEntry: boolean;
  readonly composing: boolean;
  readonly activatedBySpace: boolean;
  readonly insideMenu: boolean;
  readonly insideDialog: boolean;
}

export interface ShortcutBinding {
  readonly key: string;
  readonly display: string;
  readonly contextLabelKey: MessageKey;
  readonly phase: CommandPhase;
  readonly primary: PrimaryModifier;
  readonly shift: ShiftRequirement;
  readonly documentKinds: readonly CommandDocumentKind[];
  readonly allowWhenHelpOpen?: boolean;
  readonly allowInTextEntry?: boolean;
  readonly allowDuringComposition?: boolean;
  readonly allowInDialog?: boolean;
  readonly allowInMenu?: boolean;
  readonly allowAlt?: boolean;
  readonly rejectSpaceActivation?: boolean;
  readonly rejectRepeat?: boolean;
  readonly preventDefault: boolean;
  readonly stopPropagation?: boolean;
}

export interface CommandDefinition {
  readonly id: string;
  readonly documentKinds: readonly CommandDocumentKind[];
  readonly labelKey: MessageKey;
  readonly helpTopic: string;
  readonly enabledBy: 'always' | 'undo' | 'redo' | 'strength' | 'measurement';
  readonly shortcuts: readonly ShortcutBinding[];
}

const PART_AND_ASSEMBLY: readonly CommandDocumentKind[] = ['part', 'assembly'];
const EVERY_DOCUMENT: readonly CommandDocumentKind[] = ['part', 'assembly', 'drawing'];
const DRAWING_ONLY: readonly CommandDocumentKind[] = ['drawing'];

export const CORE_COMMAND_DEFINITIONS = [
  {
    id: 'help.contextual', documentKinds: EVERY_DOCUMENT, labelKey: 'command.help.contextual', helpTopic: 'help-reader', enabledBy: 'always',
    shortcuts: [{ key: 'f1', display: 'F1', contextLabelKey: 'command.context.all', phase: 'capture',
      primary: 'any', shift: 'either', documentKinds: EVERY_DOCUMENT, allowWhenHelpOpen: true,
      allowInTextEntry: true, allowDuringComposition: true, allowInDialog: true, allowInMenu: true,
      allowAlt: true, preventDefault: true, stopPropagation: true }],
  },
  {
    id: 'workspace.closeStrength', documentKinds: EVERY_DOCUMENT, labelKey: 'command.workspace.closeStrength', helpTopic: 'strength', enabledBy: 'strength',
    shortcuts: [{ key: 'escape', display: 'Esc', contextLabelKey: 'command.context.strength', phase: 'capture',
      primary: 'any', shift: 'either', documentKinds: EVERY_DOCUMENT, allowAlt: true,
      preventDefault: true, stopPropagation: true }],
  },
  {
    id: 'workspace.clearMeasurement', documentKinds: EVERY_DOCUMENT, labelKey: 'command.workspace.clearMeasurement', helpTopic: 'measure', enabledBy: 'measurement',
    shortcuts: [{ key: 'escape', display: 'Esc', contextLabelKey: 'command.context.measurement', phase: 'capture',
      primary: 'any', shift: 'either', documentKinds: EVERY_DOCUMENT, allowAlt: true,
      preventDefault: true, stopPropagation: true }],
  },
  {
    id: 'file.saveAs', documentKinds: EVERY_DOCUMENT, labelKey: 'toolbar.file.saveAs', helpTopic: 'print-save-as', enabledBy: 'always',
    shortcuts: [{ key: 's', display: 'Ctrl/Cmd+Shift+S', contextLabelKey: 'command.context.file', phase: 'bubble',
      primary: 'ctrl-or-meta', shift: 'required', documentKinds: EVERY_DOCUMENT, allowInTextEntry: true,
      allowDuringComposition: true, preventDefault: true }],
  },
  {
    id: 'file.save', documentKinds: EVERY_DOCUMENT, labelKey: 'toolbar.file.save', helpTopic: 'save-and-open', enabledBy: 'always',
    shortcuts: [{ key: 's', display: 'Ctrl/Cmd+S', contextLabelKey: 'command.context.file', phase: 'bubble',
      primary: 'ctrl-or-meta', shift: 'forbidden', documentKinds: EVERY_DOCUMENT, allowInTextEntry: true,
      allowDuringComposition: true, preventDefault: true }],
  },
  {
    id: 'file.open', documentKinds: EVERY_DOCUMENT, labelKey: 'toolbar.file.open', helpTopic: 'save-and-open', enabledBy: 'always',
    shortcuts: [{ key: 'o', display: 'Ctrl/Cmd+O', contextLabelKey: 'command.context.file', phase: 'bubble',
      primary: 'ctrl-or-meta', shift: 'forbidden', documentKinds: EVERY_DOCUMENT, allowInTextEntry: true,
      allowDuringComposition: true, preventDefault: true }],
  },
  {
    id: 'file.new', documentKinds: EVERY_DOCUMENT, labelKey: 'toolbar.file.new', helpTopic: 'save-and-open', enabledBy: 'always',
    shortcuts: [{ key: 'n', display: 'Ctrl/Cmd+N', contextLabelKey: 'command.context.file', phase: 'bubble',
      primary: 'ctrl-or-meta', shift: 'forbidden', documentKinds: EVERY_DOCUMENT, allowInTextEntry: true,
      allowDuringComposition: true, preventDefault: true }],
  },
  {
    id: 'history.undo', documentKinds: EVERY_DOCUMENT, labelKey: 'toolbar.history.undo', helpTopic: 'feature-tree', enabledBy: 'undo',
    shortcuts: [
      { key: 'z', display: 'Ctrl/Cmd+Z', contextLabelKey: 'command.context.drawing', phase: 'bubble', primary: 'ctrl-or-meta',
        shift: 'forbidden', documentKinds: DRAWING_ONLY, preventDefault: true },
      { key: 'z', display: 'Ctrl+Z', contextLabelKey: 'command.context.partAssembly', phase: 'bubble', primary: 'ctrl',
        shift: 'forbidden', documentKinds: PART_AND_ASSEMBLY, preventDefault: true },
    ],
  },
  {
    id: 'history.redo', documentKinds: EVERY_DOCUMENT, labelKey: 'toolbar.history.redo', helpTopic: 'feature-tree', enabledBy: 'redo',
    shortcuts: [
      { key: 'y', display: 'Ctrl/Cmd+Y', contextLabelKey: 'command.context.drawing', phase: 'bubble', primary: 'ctrl-or-meta',
        shift: 'either', documentKinds: DRAWING_ONLY, preventDefault: true },
      { key: 'z', display: 'Ctrl/Cmd+Shift+Z', contextLabelKey: 'command.context.drawing', phase: 'bubble', primary: 'ctrl-or-meta',
        shift: 'required', documentKinds: DRAWING_ONLY, preventDefault: true },
      { key: 'y', display: 'Ctrl+Y', contextLabelKey: 'command.context.partAssembly', phase: 'bubble', primary: 'ctrl',
        shift: 'either', documentKinds: PART_AND_ASSEMBLY, preventDefault: true },
      { key: 'z', display: 'Ctrl+Shift+Z', contextLabelKey: 'command.context.partAssembly', phase: 'bubble', primary: 'ctrl',
        shift: 'required', documentKinds: PART_AND_ASSEMBLY, preventDefault: true },
    ],
  },
  {
    id: 'drawing.cancelTool', documentKinds: DRAWING_ONLY, labelKey: 'command.drawing.cancelTool', helpTopic: 'drawing', enabledBy: 'always',
    shortcuts: [{ key: 'escape', display: 'Esc', contextLabelKey: 'command.context.drawing', phase: 'bubble', primary: 'none',
      shift: 'either', documentKinds: DRAWING_ONLY, preventDefault: true }],
  },
  {
    id: 'drawing.commitDimension', documentKinds: DRAWING_ONLY, labelKey: 'command.drawing.commitDimension', helpTopic: 'dimension', enabledBy: 'always',
    shortcuts: [{ key: 'enter', display: 'Enter', contextLabelKey: 'command.context.dimension', phase: 'bubble', primary: 'none',
      shift: 'either', documentKinds: DRAWING_ONLY, rejectSpaceActivation: true, rejectRepeat: true, preventDefault: true }],
  },
  {
    id: 'drawing.deleteSelection', documentKinds: DRAWING_ONLY, labelKey: 'command.drawing.deleteSelection', helpTopic: 'drawing', enabledBy: 'always',
    shortcuts: [
      { key: 'delete', display: 'Delete', contextLabelKey: 'command.context.drawing', phase: 'bubble', primary: 'none',
        shift: 'either', documentKinds: DRAWING_ONLY, preventDefault: true },
      { key: 'backspace', display: 'Backspace', contextLabelKey: 'command.context.drawing', phase: 'bubble', primary: 'none',
        shift: 'either', documentKinds: DRAWING_ONLY, preventDefault: true },
    ],
  },
  {
    id: 'selection.vertex', documentKinds: PART_AND_ASSEMBLY, labelKey: 'command.selection.vertex', helpTopic: 'select-subshape', enabledBy: 'always',
    shortcuts: [{ key: '1', display: '1', contextLabelKey: 'command.context.partAssembly', phase: 'bubble', primary: 'none',
      shift: 'forbidden', documentKinds: PART_AND_ASSEMBLY, preventDefault: true }],
  },
  {
    id: 'selection.edge', documentKinds: PART_AND_ASSEMBLY, labelKey: 'command.selection.edge', helpTopic: 'select-subshape', enabledBy: 'always',
    shortcuts: [{ key: '2', display: '2', contextLabelKey: 'command.context.partAssembly', phase: 'bubble', primary: 'none',
      shift: 'forbidden', documentKinds: PART_AND_ASSEMBLY, preventDefault: true }],
  },
  {
    id: 'selection.face', documentKinds: PART_AND_ASSEMBLY, labelKey: 'command.selection.face', helpTopic: 'select-subshape', enabledBy: 'always',
    shortcuts: [{ key: '3', display: '3', contextLabelKey: 'command.context.partAssembly', phase: 'bubble', primary: 'none',
      shift: 'forbidden', documentKinds: PART_AND_ASSEMBLY, preventDefault: true }],
  },
  {
    id: 'selection.body', documentKinds: PART_AND_ASSEMBLY, labelKey: 'command.selection.body', helpTopic: 'select-subshape', enabledBy: 'always',
    shortcuts: [{ key: '4', display: '4', contextLabelKey: 'command.context.partAssembly', phase: 'bubble', primary: 'none',
      shift: 'forbidden', documentKinds: PART_AND_ASSEMBLY, preventDefault: true }],
  },
  {
    id: 'commandLine.focus', documentKinds: PART_AND_ASSEMBLY, labelKey: 'command.commandLine.focus', helpTopic: 'command-line', enabledBy: 'always',
    shortcuts: [{ key: ' ', display: 'Space', contextLabelKey: 'command.context.viewport', phase: 'bubble',
      primary: 'none', shift: 'forbidden', documentKinds: PART_AND_ASSEMBLY, rejectSpaceActivation: true, preventDefault: true }],
  },
] as const satisfies readonly CommandDefinition[];

export type CoreCommandId = (typeof CORE_COMMAND_DEFINITIONS)[number]['id'];
export type CommandId = CoreCommandId | ToolbarCommandId;
export type RegisteredCommandDefinition = CommandDefinition & { readonly id: CommandId };
const coreIds: ReadonlySet<string> = new Set(CORE_COMMAND_DEFINITIONS.map(item => item.id));
export const COMMAND_DEFINITIONS: readonly RegisteredCommandDefinition[] = Object.freeze([
  ...CORE_COMMAND_DEFINITIONS,
  ...TOOLBAR_COMMAND_CATALOG.filter(item => !coreIds.has(item.id)).map(item => ({
    id: item.id, documentKinds: item.documentKinds, labelKey: item.labelKey, helpTopic: item.helpTopic,
    enabledBy: 'always' as const, shortcuts: [],
  })),
]);

function primaryMatches(binding: ShortcutBinding, input: CommandKeyInput): boolean {
  if (binding.primary === 'any') return true;
  if (binding.primary === 'none') return !input.ctrl && !input.meta;
  if (binding.primary === 'ctrl') return input.ctrl && !input.meta;
  return input.ctrl || input.meta;
}

export function shortcutMatches(
  binding: ShortcutBinding,
  input: CommandKeyInput,
  context: CommandKeyContext,
): boolean {
  if (binding.phase !== context.phase || binding.key !== input.key.toLowerCase()) return false;
  if (input.alt && binding.allowAlt !== true) return false;
  if (!primaryMatches(binding, input)) return false;
  if (binding.shift === 'required' && !input.shift) return false;
  if (binding.shift === 'forbidden' && input.shift) return false;
  if (!binding.documentKinds.includes(context.documentKind)) return false;
  if (context.helpOpen && binding.allowWhenHelpOpen !== true) return false;
  if (context.textEntry && binding.allowInTextEntry !== true) return false;
  if (context.composing && binding.allowDuringComposition !== true) return false;
  if (context.insideDialog && binding.allowInDialog !== true) return false;
  if (context.insideMenu && binding.allowInMenu !== true
    && (context.phase === 'capture' || binding.allowInMenu === false)) return false;
  if (binding.rejectSpaceActivation === true && context.activatedBySpace) return false;
  if (binding.rejectRepeat === true && input.repeat) return false;
  return true;
}

export interface ResolvedShortcut {
  readonly commandId: CommandId;
  readonly binding: ShortcutBinding;
}

export function resolveShortcut(
  input: CommandKeyInput,
  context: CommandKeyContext,
  eligible: (definition: CommandDefinition) => boolean = () => true,
): ResolvedShortcut | null {
  for (const definition of COMMAND_DEFINITIONS) {
    if (!eligible(definition)) continue;
    for (const binding of definition.shortcuts) {
      if (shortcutMatches(binding, input, context)) return { commandId: definition.id, binding };
    }
  }
  return null;
}

export function commandDefinition(id: string): (typeof COMMAND_DEFINITIONS)[number] | null {
  return COMMAND_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}

export interface ShortcutListEntry {
  readonly commandId: CommandId;
  readonly labelKey: MessageKey;
  readonly shortcut: string;
  readonly contextKey: MessageKey;
  readonly helpTopic: string;
}

export function currentShortcutList(
  bindingsFor: (definition: (typeof COMMAND_DEFINITIONS)[number]) => readonly ShortcutBinding[] = definition => definition.shortcuts,
): readonly ShortcutListEntry[] {
  return COMMAND_DEFINITIONS.flatMap((definition) => bindingsFor(definition).map((binding) => ({
    commandId: definition.id,
    labelKey: definition.labelKey,
    shortcut: binding.display,
    contextKey: binding.contextLabelKey,
    helpTopic: definition.helpTopic,
  })));
}
