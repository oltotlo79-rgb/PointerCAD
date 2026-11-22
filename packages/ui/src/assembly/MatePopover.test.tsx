import React, { isValidElement, useEffect, useLayoutEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument, createSubShapeReference,
  EMPTY_PART_LIBRARY, resolveAssembly, resolvePart, type MateTarget, type MateTargetKind, type SolidBody } from '@pointercad/model';
import { buildEx18ContextSource } from '@pointercad/model/testing/ex18-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { MatePopover } from './MatePopover.js';
import { focusFirstTextField } from './popoverFocus.js';
import { t } from '../i18n/t.js';
import { ASSEMBLY_MATE_TOOLS } from '../shell/menus/assemblyMenuItems.js';
import { addMateTarget, cancelMate, removeDraftTarget, startJoint, startMate, updateMateSource } from './mateActions.js';
import { availableMateKinds } from './mateCommands.js';
import type * as ImportedReactTypes from 'react';

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof ImportedReactTypes>();
  return { ...react, useLayoutEffect: vi.fn(react.useLayoutEffect), useEffect: vi.fn(react.useEffect) };
});

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
  it.each(['distance', 'ball'] as const)('%s を開くと欄または箱へ入り、Esc で開いた元へ戻る', kind => {
    if (kind === 'ball') startJoint('ball');
    // 焦点を受けた物を順に積む(activeElement は最後の 1 つ)。this を変数へ入れない(no-this-alias)。
    const focused: FocusNode[] = [];
    class FocusNode {
      readonly isConnected = true;
      focus(): void { focused.push(this); }
    }
    const opener = new FocusNode();
    const field = Object.assign(new FocusNode(), { select: vi.fn() });
    const panel = Object.assign(new FocusNode(), {
      contains: (node: unknown): boolean => node === panel || node === field,
      querySelector: (selector: string) => selector === 'input.pcad-field__input' && kind === 'distance' ? field : null,
    });
    const layout = vi.mocked(useLayoutEffect).mockClear();
    const passive = vi.mocked(useEffect).mockClear();
    let onKeyDown: ((event: KeyInput) => void) | undefined;
    function Probe(): null {
      const tree = MatePopover();
      if (!isValidElement<{ ref: React.RefObject<FocusNode | null>; onKeyDown: (event: KeyInput) => void }>(tree)) {
        throw new Error('MatePopover missing');
      }
      tree.props.ref.current = panel;
      onKeyDown = tree.props.onKeyDown;
      return null;
    }
    opener.focus();
    vi.stubGlobal('Node', FocusNode);
    vi.stubGlobal('document', { body: new FocusNode(), get activeElement() { return focused.at(-1); } });
    try {
      renderToStaticMarkup(<Probe />);
      const cleanups = layout.mock.calls.map(([effect]) => effect());
      expect(document.activeElement).toBe(opener);
      for (const [effect] of passive.mock.calls) effect();
      expect(document.activeElement).toBe(kind === 'distance' ? field : panel);
      expect(field.select).toHaveBeenCalledTimes(kind === 'distance' ? 1 : 0);
      if (onKeyDown === undefined) throw new Error('MatePopover handler missing');
      onKeyDown({ key: 'Escape', nativeEvent: { key: 'Escape', keyCode: 27, isComposing: false },
        preventDefault: vi.fn(), stopPropagation: vi.fn() });
      expect(useAppStore.getState().assemblyMateDraft).toBeNull();
      for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
      expect(document.activeElement).toBe(opener);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

function pickPair(a: MateTargetKind, b: MateTargetKind): void {
  const { assembly, assemblyView: view } = useAppStore.getState();
  if (assembly === null || view === null) throw new Error('Missing assembly');
  const part = buildEx18ContextSource('cylinder');
  const featureId = part.solids[0].id;
  const body: SolidBody = { featureId, volume: 100 * Math.PI, isValid: true,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
    faces: [{ index: 0, surfaceKind: 'cylinder', centroid: [12, -8, 2], axis: [0, 0, 1], radius: 5,
      area: 40 * Math.PI, triangleOffset: 0, triangleCount: 0 }], edges: [], vertices: [], threadMarks: [],
    origins: { version: 1, state: 'tracked', bindings: [{ state: 'unique', current: { kind: 'face', index: 0 },
      origin: { version: 1, shapeKind: 'face', identity: { kind: 'cylinder-face', featureId, role: 'side' } } }] } };
  const ref = createSubShapeReference(body, 'face', 0);
  if (ref === null) throw new Error('Missing cylinder face');
  const library = { ...EMPTY_PART_LIBRARY, parts: new Map([['a', part], ['b', part]]) };
  const resolvedParts = new Map([...library.parts].map(([key, value]) => [key, resolvePart(value)]));
  useAppStore.setState({ assemblyLibrary: library, assemblyView: { ...view, resolved: resolveAssembly(assembly, { library, resolvedParts }),
    bodies: new Map([['a', [body]], ['b', [body]]]) } });
  cancelMate();
  startMate('coincident');
  for (const [index, kind] of [a, b].entries()) {
    const componentId = assembly.components[index].id;
    const target: MateTarget = kind === 'cylinder' ? { kind: 'subShape', componentId, ref }
      : { kind: 'origin', componentId, element: kind === 'point' ? 'origin' : kind === 'plane' ? 'xy' : 'z' };
    expect(addMateTarget(target)).toBe(true);
  }
  expect(useAppStore.getState().assemblyMateDraft?.targetKinds).toEqual([a, b]);
}

interface ControlProps {
  readonly children?: React.ReactNode;
  readonly role?: string;
  readonly className?: string;
  readonly ref?: React.RefObject<{ focus: () => void } | null>;
  readonly onClick?: () => void;
  readonly 'aria-label'?: string;
  readonly 'aria-description'?: string;
}

function controls(node: React.ReactNode): React.ReactElement<ControlProps>[] {
  const found: React.ReactElement<ControlProps>[] = [];
  React.Children.forEach(node, child => {
    if (isValidElement<ControlProps>(child)) found.push(child, ...controls(child.props.children));
  });
  return found;
}

function candidateControls(nodes: readonly React.ReactElement<ControlProps>[]) {
  const group = nodes.find(node => node.props.role === 'group' && node.props['aria-label'] === t('assembly.mate.candidates'));
  const buttons = controls(group?.props.children).filter(node => node.type === 'button');
  const hint = nodes.find(node => node.type === 'p' && node.props.children === t('assembly.mate.chooseCandidate'));
  return { group, buttons, hint };
}

function candidatePanel() {
  let nodes: React.ReactElement<ControlProps>[] = [];
  function Probe(): null { nodes = controls(MatePopover()); return null; }
  renderToStaticMarkup(<Probe />);
  return candidateControls(nodes);
}

const targetKinds = ['point', 'plane', 'axis', 'cylinder'] as const;
describe('対象から選べる合致の候補', () => {
  it.each(targetKinds.flatMap(a => targetKinds.map(b => [a, b] as const)))('%s と %s の順序・おすすめ・案内', (a, b) => {
    pickPair(a, b);
    const expected = availableMateKinds(a, b);
    const { group, buttons, hint } = candidatePanel();
    expect(Boolean(group)).toBe(expected.length > 0);
    expect(Boolean(hint)).toBe(expected.length > 0 && !expected.includes('coincident'));
    expect(buttons).toHaveLength(expected.length);
    expected.forEach((kind, index) => {
      const tool = ASSEMBLY_MATE_TOOLS.find(item => item.kind === kind);
      if (tool === undefined) throw new Error(kind);
      const button = buttons[index];
      const label = React.Children.toArray(button.props.children).filter(child => typeof child === 'string').join('');
      expect(label).toBe(t(tool.labelKey));
      expect(typeof button.props.onClick).toBe('function');
      expect(button.props['aria-description']).toBe(index === 0 ? t('assembly.mate.recommended') : undefined);
      const marks = controls(button.props.children).filter(node => node.props.children === t('assembly.mate.recommended'));
      expect(marks).toHaveLength(index === 0 ? 1 : 0);
    });
  });

  it.each([
    ['distance', 'coincident', 'point', false], ['coincident', 'distance', 'point', true],
    ['coincident', 'coincident', 'point', false], ['distance', 'distance', 'point', true],
    ['parallel', 'coincident', 'plane', true],
  ] as const)('%s → %s (%s) は対象を保ち、値の欄または確定へ焦点を置く', (from, to, target, hasValue) => {
    pickPair(target, target);
    startMate(from);
    const before = useAppStore.getState();
    const effects = vi.mocked(useEffect).mockClear();
    const tool = ASSEMBLY_MATE_TOOLS.find(item => item.kind === to);
    if (tool === undefined) throw new Error(to);
    const name = t(tool.labelKey);
    const field = { focus: vi.fn(), select: vi.fn() };
    const commit = { focus: vi.fn() };
    const panelFocus = vi.fn();
    let previous: typeof effects.mock.calls = [];
    let pending: React.EffectCallback[] = [];
    // Node の描画でも同じ ref を保つよう React 自身に再描画させ、更新で依存が変わった effect だけを呼ぶ。
    function Probe(): null {
      const [picked, setPicked] = React.useState(false);
      const first = effects.mock.calls.length;
      const nodes = controls(MatePopover());
      const calls = effects.mock.calls.slice(first);
      if (!picked) {
        previous = calls;
        const button = candidateControls(nodes).buttons.find(node => React.Children.toArray(node.props.children).includes(name));
        if (button?.props.onClick === undefined) throw new Error(name);
        button.props.onClick();
        setPicked(true);
        return null;
      }
      const panelRef = nodes.find(node => node.props.role === 'dialog')?.props.ref;
      const commitRef = nodes.find(node => node.type === 'button' && node.props.children === t('assembly.mate.commit'))?.props.ref;
      if (panelRef === undefined || commitRef === undefined) throw new Error('Missing focus target');
      const hasField = nodes.some(node => node.type === 'input' && node.props.className === 'pcad-field__input');
      expect(hasField).toBe(hasValue);
      const panel = { focus: panelFocus, querySelector: (selector: string) => hasField && selector === 'input.pcad-field__input' ? field : null };
      panelRef.current = panel;
      commitRef.current = commit;
      pending = calls.filter(([, deps], i) => deps === undefined || deps.some((dep, j) => !Object.is(dep, previous[i]?.[1]?.[j])))
        .map(([effect]) => effect);
      return null;
    }
    renderToStaticMarkup(<Probe />);
    const after = useAppStore.getState();
    expect(after.assemblyMateDraft?.kind).toBe(to);
    expect(after.assemblyMateDraft?.targets).toEqual(before.assemblyMateDraft?.targets);
    expect(after.selection).toEqual(before.selection);
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);

    for (const effect of pending) effect();
    expect(field.focus).toHaveBeenCalledTimes(hasValue ? 1 : 0);
    expect(field.select).toHaveBeenCalledTimes(hasValue ? 1 : 0);
    expect(commit.focus).toHaveBeenCalledTimes(hasValue ? 0 : 1);
    expect(panelFocus).not.toHaveBeenCalled();
  });

  it('対象なし・1個・3個と、2個選んだ関節には候補も案内も出さない', () => {
    const draft = useAppStore.getState().assemblyMateDraft;
    if (draft === null) throw new Error('Missing draft');
    startJoint('ball');
    expect(candidatePanel()).toMatchObject({ group: undefined, hint: undefined });
    useAppStore.setState({ assemblyMateDraft: { ...draft, targets: [...draft.targets, { kind: 'origin', componentId: 'third', element: 'x' }],
      targetKinds: [...draft.targetKinds, 'axis'] } });
    expect(candidatePanel()).toMatchObject({ group: undefined, hint: undefined });
    useAppStore.setState({ assemblyMateDraft: draft });
    removeDraftTarget(1);
    expect(candidatePanel()).toMatchObject({ group: undefined, hint: undefined });
    removeDraftTarget(0);
    expect(candidatePanel()).toMatchObject({ group: undefined, hint: undefined });
  });
});
