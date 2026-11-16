import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument, EMPTY_PART_LIBRARY, resolveAssembly, resolvePart } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { MatePopover } from './MatePopover.js';
import { focusFirstTextField } from './popoverFocus.js';
import { t } from '../i18n/t.js';
import { addMateTarget, startJoint, startMate, updateMateSource } from './mateActions.js';

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

describe('合致の窓の選ぶ欄と最初の焦点(UI の点検の指摘 9)', () => {
  it('合致とジョイントの種類の選ぶ欄は、ほかの欄と同じ見た目の class を持つ', () => {
    expect(renderToStaticMarkup(<MatePopover />)).toMatch(/<select class="pcad-field__input" title="[^"]*">/u);
    startJoint('revolute');
    expect(renderToStaticMarkup(<MatePopover />)).toMatch(/<select class="pcad-field__input" title="[^"]*">/u);
  });
  // 選ぶ欄も同じ class を持つので、class だけで探すと select を拾い、select() が無くて例外になる(窓が描けない)。
  function panelWith(children: readonly FakeField[]) {
    return { focus: vi.fn(), querySelector: (selector: string) => children.find(child => matches(child, selector)) ?? null };
  }
  it('最初の焦点は文字の欄へ置いて全選択し、前にある選ぶ欄は選ばない', () => {
    const select: FakeField = { tagName: 'SELECT', className: 'pcad-field__input', focus: vi.fn() };
    const input: FakeField = { tagName: 'INPUT', className: 'pcad-field__input', focus: vi.fn(), select: vi.fn() };
    const panel = panelWith([select, input]);
    focusFirstTextField(panel as unknown as HTMLElement);
    expect(input.focus).toHaveBeenCalledOnce(); expect(input.select).toHaveBeenCalledOnce();
    expect(select.focus).not.toHaveBeenCalled(); expect(panel.focus).not.toHaveBeenCalled();
  });
  it('文字の欄が無ければ窓そのものへ焦点を置く', () => {
    const panel = panelWith([{ tagName: 'SELECT', className: 'pcad-field__input', focus: vi.fn() }]);
    focusFirstTextField(panel as unknown as HTMLElement);
    expect(panel.focus).toHaveBeenCalledOnce();
  });
});

interface FakeField { readonly tagName: string; readonly className: string; readonly focus: () => void; readonly select?: () => void }
/** 'tag.class' と '.class' の 2 つの形だけを読む、試験の中の小さな選び方。 */
function matches(field: FakeField, selector: string): boolean {
  const [tag, className] = selector.split('.');
  return (tag === '' || field.tagName === tag.toUpperCase()) && field.className.split(' ').includes(className);
}
