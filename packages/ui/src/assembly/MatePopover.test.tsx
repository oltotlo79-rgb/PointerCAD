import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument, EMPTY_PART_LIBRARY, resolveAssembly, resolvePart } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { MatePopover } from './MatePopover.js';
import { t } from '../i18n/t.js';
import { addMateTarget, startMate, updateMateSource } from './mateActions.js';

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
function panelHandler(): (event: KeyInput) => void {
  let handler: ((event: KeyInput) => void) | undefined;
  function Probe(): null {
    const tree = MatePopover();
    if (isValidElement<{ readonly onKeyDown: (event: KeyInput) => void }>(tree)) handler = tree.props.onKeyDown;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (handler === undefined) throw new Error('MatePopover handler missing');
  return handler;
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  let document = createAssemblyDocument('assembly');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'a' }, { partName: 'A' }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'b' }, { partName: 'B' }));
  const library = { ...EMPTY_PART_LIBRARY, parts: new Map([['a', createEmptyPartDocument()], ['b', createEmptyPartDocument()]]) };
  useAppStore.getState().openAssembly(document, library);
  const resolvedParts = new Map([...library.parts].map(([key, part]) => [key, resolvePart(part)]));
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: document,
    resolved: resolveAssembly(document, { library, resolvedParts }), bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  startMate('distance');
  for (const component of document.components) addMateTarget({ kind: 'origin', componentId: component.id, element: 'origin' });
  updateMateSource('10*2');
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('MatePopover real React handler and store (node, not DOM)', () => {
  it('shows why origin-point angle and concentric choices are disabled while keeping the distance label', () => {
    const markup = renderToStaticMarkup(<MatePopover />);
    for (const [kind, labelKey] of [['angle', 'assembly.tool.mateAngle'], ['concentric', 'assembly.tool.mateConcentric']] as const) {
      expect(markup).toContain(`<option value="${kind}" disabled="">${t(labelKey)} — ${t('assembly.mate.invalidTargets')}</option>`);
    }
    const distance = markup.match(/<option\b([^>]*\bvalue="distance"[^>]*)>([^<]*)<\/option>/);
    expect(distance?.[1]).not.toContain('disabled');
    expect(distance?.[2]).toBe(t('assembly.tool.mateDistance'));
  });
  it('normal Enter commits once with the original expression and one Undo restores the document', () => {
    const before = useAppStore.getState(), preventDefault = vi.fn(), stopPropagation = vi.fn();
    panelHandler()({ key: 'Enter', nativeEvent: { key: 'Enter', keyCode: 13, isComposing: false }, preventDefault, stopPropagation });
    const after = useAppStore.getState();
    expect(after.assembly?.mates).toHaveLength(1); expect(after.assembly?.mates[0].value).toMatchObject({ source: '10*2', value: 20 });
    expect(after.assembly?.components).toBe(before.assembly?.components);
    expect(after.assemblyUndoStack?.past).toHaveLength((before.assemblyUndoStack?.past.length ?? 0) + 1);
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
    after.undo(); expect(useAppStore.getState().assembly).toBe(before.assembly);
  });
  it('normal Escape discards only the draft', () => {
    const before = useAppStore.getState(), preventDefault = vi.fn(), stopPropagation = vi.fn();
    panelHandler()({ key: 'Escape', nativeEvent: { key: 'Escape', keyCode: 27, isComposing: false }, preventDefault, stopPropagation });
    const after = useAppStore.getState();
    expect(after.assemblyMateDraft).toBeNull(); expect(after.assembly).toBe(before.assembly); expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
  });
  it.each(['Tab', 'Delete', 'Backspace', 'z'])('leaves native input %s unchanged', key => {
    const before = useAppStore.getState(), preventDefault = vi.fn(), stopPropagation = vi.fn();
    panelHandler()({ key, nativeEvent: { key, keyCode: 0, isComposing: false }, preventDefault, stopPropagation });
    expect(useAppStore.getState().assemblyMateDraft).toBe(before.assemblyMateDraft);
    expect(useAppStore.getState().assembly).toBe(before.assembly); expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(preventDefault).not.toHaveBeenCalled(); expect(stopPropagation).not.toHaveBeenCalled();
  });
  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false], ['Escape', 229, false], ['Process', 0, false],
  ] as const)('preserves draft/document/Undo for %s code %i composing %s', (key, keyCode, isComposing) => {
    const before = useAppStore.getState();
    const preventDefault = vi.fn(); const stopPropagation = vi.fn();
    panelHandler()({ key, nativeEvent: { key, keyCode, isComposing }, preventDefault, stopPropagation });
    const after = useAppStore.getState();
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyMateDraft).toBe(before.assemblyMateDraft);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});
