import { executeToolbarCommand, type ToolbarCommandExecutionResult } from './toolbarCommandExecution.js';
import type { MessageKey } from '../i18n/t.js';
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
  | { readonly status: 'executed'; readonly commandId: CommandId; readonly ready: true; readonly reasonKey: null }
  | { readonly status: 'disabled'; readonly commandId: CommandId; readonly ready: false; readonly reasonKey: MessageKey }
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
  readonly toolbarCommand?: (id: string) => ToolbarCommandExecutionResult;
  /** Null starts a new command; a reason replaces its notice without touching input or computation. */
  readonly commandFeedback?: (reasonKey: MessageKey | null) => void;
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
    measurementOpen: state.measurement !== null || state.massProperties !== null || state.measurementRequest !== null,
    drawingTool: state.drawingTool,
  };
}

const browserActions: CommandActions = {
  toolbarCommand: executeToolbarCommand,
  commandFeedback: (reasonKey) => {
    const state = useAppStore.getState();
    if (reasonKey !== null) state.setFileMessage({ key: reasonKey, failed: true });
    else if (state.fileMessage !== null) state.setFileMessage(null);
  },
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

function disabledReason(id: string, runtime: CommandRuntimeState): MessageKey | null {
  const definition = commandDefinition(id);
  if (definition === null) return 'command.unavailable.action';
  if (!definition.documentKinds.includes(runtime.documentKind)) return 'command.unavailable.document';
  if (runtime.helpOpen && id !== 'help.contextual') return 'command.unavailable.help';
  switch (definition.enabledBy) {
    case 'always': return null;
    case 'undo': return runtime.canUndo ? null : 'command.unavailable.undo';
    case 'redo': return runtime.canRedo ? null : 'command.unavailable.redo';
    case 'strength': return runtime.strengthOpen ? null : 'command.unavailable.strength';
    case 'measurement': return runtime.measurementOpen ? null : 'command.unavailable.measurement';
  }
}

function run(id: CommandId, environment: CommandEnvironment, runtime: CommandRuntimeState): ToolbarCommandExecutionResult {
  const action = environment.actions;
  switch (id) {
    case 'file.new': action.newFile(); break;
    case 'file.open': action.openFile(); break;
    case 'file.save': action.saveFile(false); break;
    case 'file.saveAs': action.saveFile(true); break;
    case 'history.undo': action.undo(); break;
    case 'history.redo': action.redo(); break;
    case 'selection.vertex': action.setSelectionKind('vertex'); break;
    case 'selection.edge': action.setSelectionKind('edge'); break;
    case 'selection.face': action.setSelectionKind('face'); break;
    case 'selection.body': action.setSelectionKind('body'); break;
    case 'commandLine.focus': action.focusCommandLine(); break;
    case 'drawing.cancelTool': action.cancelDrawingTool(); break;
    case 'drawing.commitDimension':
      if (runtime.drawingTool === 'dimensionSeries') action.commitDrawingDimensionSeries();
      else action.commitDrawingDimension();
      break;
    case 'drawing.deleteSelection': action.deleteDrawingSelection(); break;
    case 'help.contextual': action.openContextualHelp(null, false); break;
    case 'workspace.closeStrength': action.closeStrength(); break;
    case 'workspace.clearMeasurement': action.clearMeasurement(); break;
    default: return action.toolbarCommand?.(id) ?? { ready: false, reasonKey: 'command.unavailable.action' };
  }
  return { ready: true, reasonKey: null };
}

function executeRegisteredCommand(id: CommandId, environment: CommandEnvironment, runtime: CommandRuntimeState): CommandExecutionResult {
  const reasonKey = disabledReason(id, runtime);
  if (reasonKey !== null) {
    environment.actions.commandFeedback?.(reasonKey);
    return { status: 'disabled', commandId: id, ready: false, reasonKey };
  }
  // Reading contextual help keeps the notice being explained, just as F1 does.
  if (id !== 'help.contextual') environment.actions.commandFeedback?.(null);
  const result = run(id, environment, runtime);
  if (result.ready) return { status: 'executed', commandId: id, ready: true, reasonKey: null };
  const refusal = result.reasonKey ?? 'command.unavailable.action';
  if (result.feedback !== 'handled') environment.actions.commandFeedback?.(refusal);
  return { status: 'disabled', commandId: id, ready: false, reasonKey: refusal };
}

export function executeCommand(
  requestedId: string,
  environment: CommandEnvironment = browserCommandEnvironment,
): CommandExecutionResult {
  const definition = commandDefinition(requestedId);
  if (definition === null) return { status: 'unregistered', requestedId };
  const runtime = environment.state();
  return executeRegisteredCommand(definition.id, environment, runtime);
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
  return target instanceof HTMLElement && target.closest('.pcad-menu, .pcad-name-search, .pcad-radial-menu') !== null;
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
      : disabledReason(definition.id, runtime) === null,
  );
  if (resolved === null) return { status: 'unmatched' };
  const assigned = runtime.shortcutAssignments?.[resolved.commandId];
  if (assigned !== undefined && assigned !== null && event.target instanceof Element
    && event.target.closest('[role="dialog"], [aria-modal="true"]') !== null) return { status: 'unmatched' };
  // Existing file shortcuts remain available during numeric editing. Custom keys respect handled input.
  if (event.defaultPrevented && resolved.binding.allowInTextEntry !== true && phase === 'bubble') return { status: 'unmatched' };
  applyEventResult(event, resolved.binding);
  if (resolved.commandId === 'help.contextual') {
    const target = event.target instanceof HTMLElement
      ? event.target.closest('[data-help-topic], [data-command-id]') : null;
    const explicit = target?.getAttribute('data-help-topic')
      ?? commandDefinition(target?.getAttribute('data-command-id') ?? '')?.helpTopic ?? null;
    environment.actions.openContextualHelp(explicit, isTextEntry(event.target));
    return { status: 'executed', commandId: resolved.commandId, ready: true, reasonKey: null };
  }
  return executeRegisteredCommand(resolved.commandId, environment, runtime);
}
