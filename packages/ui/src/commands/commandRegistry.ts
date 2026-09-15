import { runToolbarCommand } from './toolbarCommandExecution.js';
import { commitDrawingDimension, deleteSelectedDrawingElements } from '../drawing/dimensionCommands.js';
import { commitDrawingDimensionSeries } from '../drawing/dimensionSeriesCommands.js';
import { contextualHelpTopic } from '../help/helpContext.js';
import { createDefaultPartFileDeps, newPart, openPart, savePart } from '../file/partFile.js';
import type { SelectionKind } from '../solid/subShapeSelection.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  commandDefinition,
  type CommandId,
  type CommandKeyContext,
  type CommandKeyInput,
  type CommandPhase,
  type ShortcutBinding,
} from './commandDefinitions.js';
import { EMPTY_SHORTCUT_ASSIGNMENTS, resolveAssignedShortcut, type ShortcutAssignments } from './shortcutAssignments.js';

export type CommandExecutionResult =
  | { readonly status: 'executed'; readonly commandId: CommandId }
  | { readonly status: 'disabled'; readonly commandId: CommandId }
  | { readonly status: 'unregistered'; readonly requestedId: string }
  | { readonly status: 'unmatched' };

export interface CommandRuntimeState {
  readonly shortcutAssignments?: ShortcutAssignments;
  readonly documentKind: 'part' | 'assembly' | 'drawing';
  readonly helpOpen: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly strengthOpen: boolean;
  readonly measurementOpen: boolean;
  readonly drawingTool: string;
}

export interface CommandActions {
  readonly toolbarCommand?: (id: string) => boolean;
  readonly newFile: () => void;
  readonly openFile: () => void;
  readonly saveFile: (saveAs: boolean) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly setSelectionKind: (kind: SelectionKind) => void;
  readonly focusCommandLine: () => void;
  readonly cancelDrawingTool: () => void;
  readonly commitDrawingDimension: () => void;
  readonly commitDrawingDimensionSeries: () => void;
  readonly deleteDrawingSelection: () => void;
  readonly openContextualHelp: (explicitTopic: string | null, textEntry: boolean) => void;
  readonly closeStrength: () => void;
  readonly clearMeasurement: () => void;
}

export interface CommandEnvironment {
  readonly state: () => CommandRuntimeState;
  readonly actions: CommandActions;
}

function browserRuntimeState(): CommandRuntimeState {
  const state = useAppStore.getState();
  return {
    shortcutAssignments: state.displaySettings.shortcutAssignments ?? EMPTY_SHORTCUT_ASSIGNMENTS,
    documentKind: activeDocumentKind(state),
    helpOpen: state.helpTopicId !== null,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    strengthOpen: state.strengthSession !== null,
    measurementOpen: state.measurement !== null || state.massProperties !== null,
    drawingTool: state.drawingTool,
  };
}

const browserActions: CommandActions = {
  toolbarCommand: runToolbarCommand,
  newFile: () => { void newPart(createDefaultPartFileDeps()); },
  openFile: () => { void openPart(createDefaultPartFileDeps()); },
  saveFile: (saveAs) => { void savePart(createDefaultPartFileDeps(), saveAs); },
  undo: () => { useAppStore.getState().undo(); },
  redo: () => { useAppStore.getState().redo(); },
  setSelectionKind: (kind) => { useAppStore.getState().setSelectionKind(kind); },
  focusCommandLine: () => { useAppStore.getState().requestCommandLineFocus(); },
  cancelDrawingTool: () => { useAppStore.getState().setDrawingTool('select'); },
  commitDrawingDimension: () => { commitDrawingDimension(); },
  commitDrawingDimensionSeries: () => { void commitDrawingDimensionSeries(); },
  deleteDrawingSelection: () => { deleteSelectedDrawingElements(); },
  openContextualHelp: (explicitTopic, textEntry) => {
    const state = useAppStore.getState();
    state.openHelpTopic(contextualHelpTopic(state, explicitTopic, textEntry));
  },
  closeStrength: () => { useAppStore.getState().closeStrength(); },
  clearMeasurement: () => { useAppStore.getState().clearMeasurement(); },
};

export const browserCommandEnvironment: CommandEnvironment = {
  state: browserRuntimeState,
  actions: browserActions,
};

function isEnabled(id: string, runtime: CommandRuntimeState): boolean {
  const definition = commandDefinition(id);
  if (definition === null) return false;
  if (!definition.documentKinds.includes(runtime.documentKind)) return false;
  if (runtime.helpOpen && id !== 'help.contextual') return false;
  switch (definition.enabledBy) {
    case 'always': return true;
    case 'undo': return runtime.canUndo;
    case 'redo': return runtime.canRedo;
    case 'strength': return runtime.strengthOpen;
    case 'measurement': return runtime.measurementOpen;
  }
}

function run(id: CommandId, environment: CommandEnvironment, runtime: CommandRuntimeState): boolean {
  const action = environment.actions;
  switch (id) {
    case 'file.new': action.newFile(); return true;
    case 'file.open': action.openFile(); return true;
    case 'file.save': action.saveFile(false); return true;
    case 'file.saveAs': action.saveFile(true); return true;
    case 'history.undo': action.undo(); return true;
    case 'history.redo': action.redo(); return true;
    case 'selection.vertex': action.setSelectionKind('vertex'); return true;
    case 'selection.edge': action.setSelectionKind('edge'); return true;
    case 'selection.face': action.setSelectionKind('face'); return true;
    case 'selection.body': action.setSelectionKind('body'); return true;
    case 'commandLine.focus': action.focusCommandLine(); return true;
    case 'drawing.cancelTool': action.cancelDrawingTool(); return true;
    case 'drawing.commitDimension':
      if (runtime.drawingTool === 'dimensionSeries') action.commitDrawingDimensionSeries();
      else action.commitDrawingDimension();
      return true;
    case 'drawing.deleteSelection': action.deleteDrawingSelection(); return true;
    case 'help.contextual': action.openContextualHelp(null, false); return true;
    case 'workspace.closeStrength': action.closeStrength(); return true;
    case 'workspace.clearMeasurement': action.clearMeasurement(); return true;
    default: return action.toolbarCommand?.(id) ?? false;
  }
}

export function executeCommand(
  requestedId: string,
  environment: CommandEnvironment = browserCommandEnvironment,
): CommandExecutionResult {
  const definition = commandDefinition(requestedId);
  if (definition === null) return { status: 'unregistered', requestedId };
  const runtime = environment.state();
  if (!isEnabled(definition.id, runtime)) return { status: 'disabled', commandId: definition.id };
  return { status: run(definition.id, environment, runtime) ? 'executed' : 'disabled', commandId: definition.id };
}

export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}

export function isActivatedBySpace(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest('button, select, summary, a[href], [role="switch"], [role="menuitem"], [role="option"], [role="tab"]') !== null;
}

export function isInsideMenu(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.pcad-menu, .pcad-name-search') !== null;
}

export function isInsideDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('dialog[open]') !== null;
}

function keyInput(event: KeyboardEvent): CommandKeyInput {
  return { key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey,
    shift: event.shiftKey, repeat: event.repeat };
}

function keyContext(event: KeyboardEvent, phase: CommandPhase, runtime: CommandRuntimeState): CommandKeyContext {
  return {
    documentKind: runtime.documentKind,
    phase,
    helpOpen: runtime.helpOpen,
    textEntry: isTextEntry(event.target),
    composing: event.isComposing || event.keyCode === 229 || event.key === 'Process',
    activatedBySpace: isActivatedBySpace(event.target),
    insideMenu: isInsideMenu(event.target),
    insideDialog: isInsideDialog(event.target),
  };
}

function applyEventResult(event: KeyboardEvent, binding: ShortcutBinding): void {
  if (binding.preventDefault) event.preventDefault();
  if (binding.stopPropagation === true) event.stopPropagation();
}

export function dispatchCommandKey(
  event: KeyboardEvent,
  phase: CommandPhase,
  environment: CommandEnvironment = browserCommandEnvironment,
): CommandExecutionResult {
  if (event.getModifierState('AltGraph')) return { status: 'unmatched' };
  const runtime = environment.state();
  const resolved = resolveAssignedShortcut(keyInput(event), keyContext(event, phase, runtime),
    runtime.shortcutAssignments ?? EMPTY_SHORTCUT_ASSIGNMENTS, (definition) =>
    definition.enabledBy !== 'strength' && definition.enabledBy !== 'measurement'
      ? true
      : isEnabled(definition.id, runtime),
  );
  if (resolved === null) return { status: 'unmatched' };
  const assigned = runtime.shortcutAssignments?.[resolved.commandId];
  if (assigned !== undefined && assigned !== null && event.target instanceof Element
    && event.target.closest('[role="dialog"], [aria-modal="true"]') !== null) return { status: 'unmatched' };
  // Existing file shortcuts remain available during numeric editing. Custom keys respect handled input.
  if (event.defaultPrevented && resolved.binding.allowInTextEntry !== true && phase === 'bubble') return { status: 'unmatched' };
  applyEventResult(event, resolved.binding);
  if (!isEnabled(resolved.commandId, runtime)) return { status: 'disabled', commandId: resolved.commandId };
  if (resolved.commandId === 'help.contextual') {
    const target = event.target instanceof HTMLElement
      ? event.target.closest('[data-help-topic], [data-command-id]') : null;
    const explicit = target?.getAttribute('data-help-topic')
      ?? commandDefinition(target?.getAttribute('data-command-id') ?? '')?.helpTopic ?? null;
    environment.actions.openContextualHelp(explicit, isTextEntry(event.target));
    return { status: 'executed', commandId: resolved.commandId };
  }
  return { status: run(resolved.commandId, environment, runtime) ? 'executed' : 'disabled', commandId: resolved.commandId };
}
