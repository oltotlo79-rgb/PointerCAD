import React, { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addComponent, appendSolid, createAssemblyDocument, createComponentFor, createEmptyPartDocument, createPrimitiveFeature,
  EMPTY_PART_LIBRARY, resolveAssembly, resolvePart } from '@pointercad/model';
import { addMateTarget, startMate, updateMateSource } from '../assembly/mateActions.js';
import type { AssemblyInterferenceRunner } from '../assembly/interferenceActions.js';
import { t, type MessageKey } from '../i18n/t.js';
import { AssemblyGroup } from '../shell/menus/AssemblyGroup.js';
import { StatusBar } from '../shell/StatusBar.js';
import { CombineGroupIcon } from '../shell/icons.js';
import { COMBINE_MENU_ITEMS } from '../shell/menus/solidMenuItems.js';
import { ToolMenu } from '../shell/menus/ToolMenu.js';
import { solidToolReadiness } from '../solid/solidCommands.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { dispatchCommandKey, executeCommand } from './commandRegistry.js';
import { validateShortcutAssignments } from './shortcutAssignments.js';

interface ButtonProps {
  readonly 'data-command-id'?: string;
  readonly onClick?: () => void;
}
const rendered = vi.hoisted(() => ({ buttons: [] as ButtonProps[] }));
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: vi.fn(react.useState) };
});
vi.mock('react/jsx-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>();
  const capture = (factory: typeof runtime.jsx): typeof runtime.jsx => (type, props, key) => {
    if (type === 'button') rendered.buttons.push(props as ButtonProps);
    return factory(type, props, key);
  };
  return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    if (type === 'button') rendered.buttons.push(props as ButtonProps);
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV };
});

const state = () => useAppStore.getState();
const recent = vi.fn();
const close = vi.fn();

beforeEach(() => {
  resetTestStore();
  vi.clearAllMocks();
  // Node has no DOM. These tests invoke real React handlers and the key dispatcher;
  // focus, pointer hit testing and live announcements remain real-screen checks.
  vi.stubGlobal('Element', class {});
  vi.stubGlobal('HTMLElement', class {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTestStore(); });

function openAssembly(count = 2, hidden = false, suppressed = false): void {
  let document = createAssemblyDocument('Command feedback');
  for (let index = 0; index < count; index++) {
    const component = createComponentFor(document, { kind: 'part', partRef: 'part' }, { partName: 'Part' });
    document = addComponent(document, { ...component, visible: index !== 1 || !hidden,
      suppressed: index === 1 && suppressed });
  }
  const library = { ...EMPTY_PART_LIBRARY, parts: new Map([['part', createEmptyPartDocument()]]) };
  state().openAssembly(document, library);
  const resolvedParts = new Map([...library.parts].map(([key, part]) => [key, resolvePart(part)]));
  const resolved = resolveAssembly(document, { library, resolvedParts });
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: document, resolved,
    bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
}

function render(element: React.ReactElement): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(element); }
  finally { snapshot.mockRestore(); }
}

function buttonHandler(id: string): () => void {
  rendered.buttons = [];
  // Both menus in AssemblyGroup are open. Capture actual onClick handlers without
  // replacing executeCommand, the readiness checks or the store actions.
  for (let menu = 0; menu < 2; menu++) {
    vi.mocked(useState).mockReturnValueOnce([true, close]);
    vi.mocked(useState).mockReturnValueOnce([null, recent]);
    vi.mocked(useState).mockReturnValueOnce([0, vi.fn()]);
  }
  render(<AssemblyGroup />);
  const buttons = rendered.buttons.filter(button => button['data-command-id'] === id);
  expect(buttons).toHaveLength(1);
  const handler = buttons[0]?.onClick;
  if (handler === undefined) throw new Error(`No command button: ${id}`);
  return handler;
}

function solidButtonHandler(id: string): () => void {
  rendered.buttons = [];
  vi.mocked(useState).mockReturnValueOnce([true, close]);
  vi.mocked(useState).mockReturnValueOnce([null, recent]);
  vi.mocked(useState).mockReturnValueOnce([0, vi.fn()]);
  render(<ToolMenu items={COMBINE_MENU_ITEMS} groupLabelKey="toolbar.combine.groupLabel"
    groupTooltipKey="toolbar.combine.tooltip" GroupIcon={CombineGroupIcon}
    activeTool={state().activeTool} commandGroup="solidCombine"
    readinessOf={operation => solidToolReadiness(state().document, state().selection, operation, [])} />);
  const buttons = rendered.buttons.filter(button => button['data-command-id'] === id);
  expect(buttons).toHaveLength(1);
  const handler = buttons[0]?.onClick;
  if (handler === undefined) throw new Error(`No solid command button: ${id}`);
  return handler;
}

function partWithBoxes(count: number): void {
  let document = createEmptyPartDocument();
  for (let index = 0; index < count; index++) document = appendSolid(document, createPrimitiveFeature(document, 'box'));
  state().resetDocument(document);
  state().setSelection(document.solids.map(solid => solid.id));
}

function expectStatusText(text: string): void {
  expect(render(<StatusBar />)).toContain(render(<span className="pcad-statusbar__text" title={text}>{text}</span>));
}

function assignKey(id: string): void {
  const validation = validateShortcutAssignments({ [id]: { key: 'f2', primary: false, shift: false, alt: false } });
  if (!validation.ok) throw new Error(`Invalid assignment: ${id}`);
  state().setDisplaySettings({ ...state().displaySettings, shortcutAssignments: validation.assignments });
}

class CommandKeyEvent extends Event implements KeyboardEvent {
  readonly key = 'F2';
  readonly code = 'F2';
  readonly keyCode = 113;
  readonly which = 113;
  readonly charCode = 0;
  readonly location = 0;
  readonly detail = 0;
  readonly view = null;
  readonly ctrlKey = false;
  readonly metaKey = false;
  readonly altKey = false;
  readonly shiftKey = false;
  readonly repeat = false;
  readonly isComposing = false;
  readonly DOM_KEY_LOCATION_STANDARD = 0;
  readonly DOM_KEY_LOCATION_LEFT = 1;
  readonly DOM_KEY_LOCATION_RIGHT = 2;
  readonly DOM_KEY_LOCATION_NUMPAD = 3;
  getModifierState(): boolean { return false; }
  initKeyboardEvent(): never { throw new Error('Use the event constructor'); }
  initUIEvent(): never { throw new Error('Use the event constructor'); }
}

function keyEvent(): KeyboardEvent {
  return new CommandKeyEvent('keydown', { cancelable: true });
}

function refuseAcrossEntrances(id: string, reasonKey: MessageKey, handler = buttonHandler(id)): void {
  assignKey(id);
  const before = state();
  const expected = { ...before, fileMessage: { key: reasonKey, failed: true } };
  const result = { status: 'disabled', commandId: id, ready: false, reasonKey };
  expect(executeCommand(id)).toEqual(result);
  expect(state()).toEqual(expected);
  expect(render(<StatusBar />)).toContain(t(reasonKey));
  state().setFileMessage(null);
  handler();
  expect(state()).toEqual(expected);
  expect(recent).not.toHaveBeenCalled();
  state().setFileMessage(null);
  const event = keyEvent();
  expect(dispatchCommandKey(event, 'bubble')).toEqual(result);
  expect(event.defaultPrevented).toBe(true);
  expect(state()).toEqual(expected);
  expect(render(<StatusBar />)).toContain(t(reasonKey));
}

describe.each([0, 1])('Solid refusals with %i selected bodies', count => {
  it.each(['union', 'subtract', 'intersect'].flatMap(operation =>
    ['command', 'button', 'key'].map(entrance => [operation, entrance] as const),
  ))('%s via %s preserves the complete failure and the document', (operation, entrance) => {
    partWithBoxes(count);
    const id = `toolbar.solidCombine.${operation}`;
    assignKey(id);
    state().setFileMessage({ key: 'command.unavailable.undo', failed: true });
    const before = state();
    const result = { status: 'disabled', commandId: id, ready: false, reasonKey: 'solidError.needTwoBodies' };
    if (entrance === 'button') solidButtonHandler(id)();
    else if (entrance === 'key') {
      const event = keyEvent();
      expect(dispatchCommandKey(event, 'bubble')).toEqual(result);
      expect(event.defaultPrevented).toBe(true);
    } else expect(executeCommand(id)).toEqual(result);
    expect(state()).toEqual({ ...before, fileMessage: null, solidErrorKey: 'solidError.needTwoBodies' });
    expectStatusText(`${t('statusBar.solidError')} ${t('solidError.needTwoBodies')}`);
    expect(recent).not.toHaveBeenCalled();
  });
});

describe('Existing failure message formats through the command entry point', () => {
  it.each([
    ['toolbar.solidCreate.extrude', 'solidError.noFace'],
    ['toolbar.solidCreate.revolve', 'solidError.noFace'],
    ['toolbar.solidMachining.hole', 'machiningError.noFace'],
  ] as const)('%s keeps the solid prefix while starting target selection', (id, reason) => {
    const before = state();
    expect(executeCommand(id).status).toBe('executed');
    expect(state().document).toBe(before.document);
    expect(state().canUndo).toBe(false);
    expect(state().fileMessage).toBeNull();
    expect(state().solidErrorKey).toBe(reason);
    expectStatusText(`${t('statusBar.solidError')} ${t(reason)}`);
  });

  it('preserves computation when a solid command is refused', () => {
    partWithBoxes(1);
    useAppStore.setState({ isComputing: true });
    const before = state();
    expect(executeCommand('toolbar.solidCombine.subtract').status).toBe('disabled');
    expect(state()).toEqual({ ...before, solidErrorKey: 'solidError.needTwoBodies' });
    expectStatusText(`${t('statusBar.solidError')} ${t('solidError.needTwoBodies')}`);
  });

  it('clears a prior solid refusal when valid targets are combined', () => {
    partWithBoxes(2);
    const selected = state().selection;
    state().setSelection(selected.slice(0, 1));
    expect(executeCommand('toolbar.solidCombine.union').status).toBe('disabled');
    expectStatusText(`${t('statusBar.solidError')} ${t('solidError.needTwoBodies')}`);
    state().setSelection(selected);
    expect(executeCommand('toolbar.solidCombine.union').status).toBe('executed');
    expect(state().document.solids).toHaveLength(3);
    expect(state().document.solids[2]?.kind).toBe('boolean');
    expect(state().canUndo).toBe(true);
    expect(state().solidErrorKey).toBeNull();
    expect(state().fileMessage).toBeNull();
    expect(render(<StatusBar />)).not.toContain(t('statusBar.solidError'));
  });

  it('still explains a document-level refusal before any solid action starts', () => {
    openAssembly();
    const before = state();
    expect(executeCommand('toolbar.solidCombine.subtract')).toEqual({ status: 'disabled',
      commandId: 'toolbar.solidCombine.subtract', ready: false, reasonKey: 'command.unavailable.document' });
    expect(state()).toEqual({ ...before, fileMessage: { key: 'command.unavailable.document', failed: true } });
    expectStatusText(t('command.unavailable.document'));
  });
});

describe('Shared refusal feedback from buttons, menus and assigned keys', () => {
  it.each([0, 1])('interference with %d components explains the missing targets', count => {
    openAssembly(count);
    refuseAcrossEntrances('toolbar.assemblyUtility.interference', 'command.unavailable.interferenceComponents');
  });

  it.each(['hidden', 'suppressed'] as const)('does not count %s components as interference targets', kind => {
    openAssembly(2, kind === 'hidden', kind === 'suppressed');
    refuseAcrossEntrances('toolbar.assemblyUtility.interference', 'command.unavailable.interferenceComponents');
  });

  it.each(['interference', 'explode'] as const)('refusing %s during computation preserves computation and selection', action => {
    openAssembly();
    state().setSelection(['component-1']);
    useAppStore.setState({ isComputing: true });
    refuseAcrossEntrances(`toolbar.assemblyUtility.${action}`, 'command.unavailable.computing');
  });

  it('distinguishes stale geometry from an unavailable interference runner', () => {
    openAssembly();
    useAppStore.setState({ assemblyView: null });
    refuseAcrossEntrances('toolbar.assemblyUtility.interference', 'command.unavailable.geometry');
    openAssembly();
    refuseAcrossEntrances('toolbar.assemblyUtility.interference', 'command.unavailable.interferencePreparing');
  });

  it('an empty BOM suggests placing components without changing the document', () => {
    openAssembly(0);
    refuseAcrossEntrances('toolbar.assemblyUtility.bom', 'command.unavailable.bomComponents');
  });

  it('explains missing explode selection', () => {
    openAssembly();
    refuseAcrossEntrances('toolbar.assemblyUtility.explode', 'assembly.explode.selectComponent');
  });

  it('missing fixed targets change neither inputs nor the recent tool', () => {
    openAssembly();
    refuseAcrossEntrances('toolbar.assembly.toggleFixed', 'assembly.tool.selectOneComponentReason');
    expect(close).toHaveBeenCalledWith(false);
  });

  it.each([0, 1])('mating with %d components suggests placement and does not start', count => {
    openAssembly(count);
    refuseAcrossEntrances('toolbar.mate.coincident', 'assembly.mate.notReady');
  });

  it('does not count suppressed components as mate targets', () => {
    openAssembly(2, false, true);
    refuseAcrossEntrances('toolbar.mate.revolute', 'assembly.mate.notReady');
  });

  it('refusing interference during mate input preserves its expression and targets', () => {
    openAssembly(); startMate('distance');
    expect(addMateTarget({ kind: 'origin', componentId: 'component-1', element: 'origin' })).toBe(true);
    updateMateSource('12/3');
    refuseAcrossEntrances('toolbar.assemblyUtility.interference', 'command.unavailable.finishInput');
  });

  it('incompatible mate types preserve the original targets and distance expression', () => {
    openAssembly(); startMate('distance');
    for (const componentId of ['component-1', 'component-2']) {
      expect(addMateTarget({ kind: 'origin', componentId, element: 'origin' })).toBe(true);
    }
    updateMateSource('12/3');
    refuseAcrossEntrances('toolbar.mate.parallel', 'assembly.mate.invalidTargets');
  });

  it('uses current computation state even when the menu was opened earlier', () => {
    openAssembly();
    const handler = buttonHandler('toolbar.mate.coincident');
    useAppStore.setState({ isComputing: true });
    refuseAcrossEntrances('toolbar.mate.coincident', 'command.unavailable.computing', handler);
  });

  it('two components allow the mate selection step and update the recent tool', () => {
    openAssembly();
    const before = state();
    buttonHandler('toolbar.mate.coincident')();
    expect(state().assemblyMateDraft?.kind).toBe('coincident');
    expect(recent).toHaveBeenCalledWith('coincident');
    expect(state().assembly).toBe(before.assembly);
    expect(state().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('opening a valid BOM clears the previous refusal message', () => {
    openAssembly(1);
    executeCommand('toolbar.assemblyUtility.explode');
    expect(state().fileMessage?.failed).toBe(true);
    expect(executeCommand('toolbar.assemblyUtility.bom')).toEqual({ status: 'executed',
      commandId: 'toolbar.assemblyUtility.bom', ready: true, reasonKey: null });
    expect(state().fileMessage).toBeNull();
    expect(state().selection).toEqual(['bom']);
    expect(render(<StatusBar />)).not.toContain(t('assembly.explode.selectComponent'));
  });

  it.each(['command', 'button', 'key'] as const)('starts interference once via %s for two components', async entrance => {
    openAssembly();
    const check = vi.fn<AssemblyInterferenceRunner['check']>(input => Promise.resolve({
      kind: 'checked', failure: null, requestId: input.requestId, pairs: [], failures: [], skips: [],
      totalPairCount: 1, checkedPairCount: 1, skippedPairCount: 0, pendingPairCount: 0, cancelled: false,
    }));
    state().setAssemblyInterferenceRunner({ check, measureGap: () => Promise.resolve(null) });
    const id = 'toolbar.assemblyUtility.interference';
    assignKey(id);
    const before = state();
    if (entrance === 'button') buttonHandler(id)();
    else if (entrance === 'key') expect(dispatchCommandKey(keyEvent(), 'bubble').status).toBe('executed');
    else expect(executeCommand(id).status).toBe('executed');
    expect(check).toHaveBeenCalledOnce();
    expect(state().assemblyInterferenceOpen).toBe(true);
    expect(state().assembly).toBe(before.assembly);
    expect(state().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(state().selection).toBe(before.selection);
    expect(state().fileMessage).toBeNull();
    await Promise.resolve();
  });

  it.each(['command', 'button', 'key'] as const)('starts an explode draft for the selected component via %s', entrance => {
    openAssembly();
    state().setSelection(['component-1']);
    const id = 'toolbar.assemblyUtility.explode';
    assignKey(id);
    const before = state();
    if (entrance === 'button') buttonHandler(id)();
    else if (entrance === 'key') expect(dispatchCommandKey(keyEvent(), 'bubble').status).toBe('executed');
    else expect(executeCommand(id).status).toBe('executed');
    expect(state().assemblyExplodeDraft).not.toBeNull();
    expect(state().assembly).toBe(before.assembly);
    expect(state().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(state().selection).toBe(before.selection);
  });
});
