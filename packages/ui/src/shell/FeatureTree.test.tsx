import React, { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absoluteCoordinate, addComponent, addSketch, appendFeature, appendSolid, createAssemblyDocument, createComponentFor, createEmptyPartDocument, createFeatureFolder, createPointFeature, createSketchFor, moveFeatureFolderMember, replaceSketch, type PartDocument, type SolidFeature } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { FeatureTree } from './FeatureTree.js';
import { AssemblyTree } from './AssemblyTree.js';
import { FeatureFolderTree } from '../history/FeatureFolderTree.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { extrudeFeature, holeFeature, partWithMixedFeatures, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { connectSelectedPoints, selectedPointsConnection } from '../sketch/connectSelectedPoints.js';

const renamedName = t('propertyPanel.sectionSelectionSets');
const blurredName = t('featureTree.sketchGroup');

// Node has no DOM. Preserve local hook state between renders and exercise the actual
// returned controls and store actions. Native focus/Enter dispatch is covered by E2E.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0,
  captureEffects: false,
  effects: [] as Array<{ setup: () => void | (() => void); deps?: readonly unknown[] }>,
}));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  return {
    ...original,
    useState: <S,>(initial: S | (() => S)) => {
      const index = hooks.state++;
      if (index === hooks.values.length) hooks.values.push(typeof initial === 'function' ? (initial as () => S)() : initial);
      return [hooks.values[index] as S, (next: SetStateAction<S>) => {
        hooks.values[index] = typeof next === 'function' ? (next as (previous: S) => S)(hooks.values[index] as S) : next;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.ref++;
      if (index === hooks.refs.length) hooks.refs.push({ current: initial });
      return hooks.refs[index] as { current: T };
    },
    useEffect: (setup: () => void | (() => void), deps?: readonly unknown[]) => {
      if (hooks.captureEffects) hooks.effects.push({ setup, deps });
    },
    useLayoutEffect: vi.fn(),
  };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, child => {
    // Expand the stateless folder component so its real renderMember callback
    // exposes the same sketch rows as the mounted tree.
    if (isValidElement<Parameters<typeof FeatureFolderTree>[0]>(child) && child.type === FeatureFolderTree) {
      found.push(...elements(FeatureFolderTree(child.props)));
      return;
    }
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child);
    found.push(...elements(child.props.children as ReactNode));
  });
  return found;
}
function render(component = FeatureTree): Element[] {
  hooks.state = 0;
  hooks.ref = 0;
  hooks.effects = [];
  let tree: ReactNode = null;
  function Probe() { tree = component(); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  return elements(tree);
}

/** Only the lifecycle cases opt in to the real effect setup/cleanup returned by FeatureTree. */
function effectMount() {
  hooks.captureEffects = true;
  let active: Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) }> = [];
  const rerender = () => {
    const nodes = render();
    const next = hooks.effects.map((effect, index) => {
      const previous = active[index];
      if (previous !== undefined && effect.deps !== undefined && previous.deps !== undefined &&
        effect.deps.length === previous.deps.length && effect.deps.every((value, at) => Object.is(value, previous.deps?.[at]))) {
        return previous;
      }
      previous?.cleanup?.();
      return { deps: effect.deps, cleanup: effect.setup() };
    });
    active.slice(next.length).forEach(effect => effect.cleanup?.());
    active = next;
    return nodes;
  };
  const unmount = () => {
    active.forEach(effect => effect.cleanup?.());
    active = [];
    hooks.captureEffects = false;
  };
  return { rerender, unmount };
}

function windowListeners() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const windowMock = {
    innerWidth: 1440, innerHeight: 900,
    document: { elementFromPoint: () => ({ closest: () => ({ getAttribute: () => '0' }) }) },
    addEventListener(type: string, listener: (event: never) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type: string, listener: (event: never) => void) { listeners.get(type)?.delete(listener); },
    dispatch(type: string, event: object) { for (const listener of listeners.get(type) ?? []) listener(event as never); },
    latest(type: string) { return [...listeners.get(type) ?? []].at(-1); },
    count() { return [...listeners.values()].reduce((total, entry) => total + entry.size, 0); },
  };
  vi.stubGlobal('window', windowMock);
  vi.stubGlobal('Element', class {});
  return windowMock;
}
function one(nodes: Element[], predicate: (element: Element) => boolean): Element {
  const matches = nodes.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0];
}
function row(nodes: Element[], key: string): Element {
  const searchKey = key.startsWith('component:') ? key : JSON.stringify(key.split(':'));
  return one(nodes, element => element.props['data-name-search-key'] === searchKey);
}
function click(element: Element, currentTarget: object = {}): void {
  const handler = element.props.onClick as React.MouseEventHandler<HTMLElement>;
  handler({ currentTarget } as React.MouseEvent<HTMLElement>);
}
function key(element: Element, name: string, composing = false, keyCode = 0, currentTarget: object = { value: renamedName }) {
  const event = { key: name, keyCode, nativeEvent: { isComposing: composing }, currentTarget,
    preventDefault: vi.fn(), stopPropagation: vi.fn() };
  const handler = element.props.onKeyDown as (value: typeof event) => void;
  handler(event);
  return event;
}
function open(nodes: Element[], rowKey: string) {
  const trigger = one(elements(row(nodes, rowKey)), element => element.props['aria-haspopup'] === 'menu');
  const button = { focus: vi.fn(), getBoundingClientRect: () => ({ right: 200, bottom: 100, top: 74 }) };
  click(trigger, button);
  return button;
}
function menuItem(nodes: Element[], label: MessageKey): Element {
  return one(nodes, element => element.props.role === 'menuitem' && element.props.children === t(label));
}
function groupedPart(): PartDocument {
  const document = partWithMixedFeatures();
  return addSketch(document, createSketchFor(document));
}

beforeEach(() => {
  hooks.values = []; hooks.refs = [];
  hooks.captureEffects = false; hooks.effects = [];
  resetTestStore();
  useAppStore.getState().resetDocument(groupedPart());
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  vi.stubGlobal('window', { innerWidth: 1440, innerHeight: 900 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTestStore(); });

describe('FeatureTree failed edit consumption at the actual render boundary', () => {
  const editKinds = ['faceOffset', 'holeTranslate', 'faceRotate', 'boolean'] as const;
  function fixture(kind: typeof editKinds[number]): PartDocument {
    const hole = holeFeature('hole-1', 'extrude-1');
    const common = { id: 'edit-1', name: 'Edit', suppressed: false, targetFeatureId: hole.id };
    const face = { ...hole.face, bodyFeatureId: hole.id };
    const value = expressionValueFromNumber;
    const edit: SolidFeature = kind === 'boolean'
      ? { ...common, kind, operation: 'subtract', toolFeatureId: 'tool-1' }
      : kind === 'faceOffset' ? { ...common, kind, face, offset: value(-28) }
      : kind === 'holeTranslate' ? { ...common, kind, face, translation: [value(100), value(0), value(0)] }
      : { ...common, kind, face, hinge: { bodyFeatureId: hole.id, index: 0,
          fingerprint: { kind: 'edge', curveKind: 'line', length: 20, position: [0, 0, 0], axis: [0, 1, 0], radius: null } }, angle: value(90) };
    return { ...createEmptyPartDocument(), solids: [extrudeFeature('extrude-1'), hole,
      extrudeFeature('tool-1'), edit, extrudeFeature('tail-1')] };
  }
  function consumed(nodes: Element[], id: string): boolean {
    return elements(row(nodes, `solid:${id}`)).some(element =>
      element.props.title === t('featureTree.consumedTooltip') && element.props.children === t('featureTree.consumed'));
  }

  it.each(editKinds)('%s failure leaves its input selectable and unconsumed at every timeline position', kind => {
    const document = fixture(kind);
    useAppStore.getState().resetDocument(document);
    const errors = [{ featureId: 'edit-1', code: 'missingBody' as const, message: 'Edit failed' }];
    for (const timelineIndex of [null, 4, 0, 1, 2, 3] as const) {
      useAppStore.setState({ partErrors: errors, timelineIndex });
      const nodes = render();
      expect(consumed(nodes, 'hole-1')).toBe(false);
      expect(consumed(nodes, 'tool-1')).toBe(false);
      expect(consumed(nodes, 'extrude-1')).toBe(timelineIndex !== 0);
      expect(elements(row(nodes, 'solid:hole-1')).some(element =>
        element.props.className === 'pcad-tree__select' && element.props.disabled !== true)).toBe(true);
      expect(useAppStore.getState().document).toBe(document);
    }
    // Clearing the actual error after correction restores the normal consuming relation.
    useAppStore.setState({ partErrors: [], timelineIndex: null });
    expect(consumed(render(), 'hole-1')).toBe(true);
    expect(consumed(render(), 'tool-1')).toBe(kind === 'boolean');
    // A later successful step still does not consume while rolled back before it.
    useAppStore.setState({ timelineIndex: 2 });
    expect(consumed(render(), 'hole-1')).toBe(false);
    expect(consumed(render(), 'extrude-1')).toBe(true);
  });
});

describe('FeatureTree window listener lifetime', () => {
  it.each(['shiftKey', 'ctrlKey'] as const)('%s selection does not start a timeline drag', modifier => {
    const windowMock = windowListeners();
    const mount = effectMount();
    const nodes = mount.rerender();
    const timelineRow = row(nodes, 'solid:extrude-1');
    const down = timelineRow.props.onPointerDown as (event: object) => void;
    const before = useAppStore.getState().document;
    down({ button: 0, target: {}, clientX: 0, clientY: 0, [modifier]: true });
    mount.rerender();
    expect(windowMock.count()).toBe(0);
    expect(useAppStore.getState().document).toBe(before);
    mount.unmount();
  });

  it('attaches and cleans the real menu and drag effects for 100 mounts', () => {
    const windowMock = windowListeners();
    for (let iteration = 0; iteration < 100; iteration += 1) {
      hooks.values = []; hooks.refs = [];
      const mount = effectMount();
      open(mount.rerender(), 'solid:extrude-1');
      mount.rerender();
      expect(windowMock.count()).toBe(2);
      mount.unmount();
      expect(windowMock.count()).toBe(0);
    }
  });

  it('restores menu focus on Escape and ignores composition and a disposed listener', () => {
    const windowMock = windowListeners();
    const mount = effectMount();
    const opener = open(mount.rerender(), 'solid:extrude-1');
    mount.rerender();
    const oldKeyDown = windowMock.latest('keydown');
    windowMock.dispatch('keydown', { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(opener.focus).not.toHaveBeenCalled();
    windowMock.dispatch('keydown', { key: 'Escape', isComposing: false, keyCode: 0 });
    expect(opener.focus).toHaveBeenCalledOnce();
    mount.rerender();
    expect(windowMock.count()).toBe(0);
    const second = open(mount.rerender(), 'solid:extrude-1');
    mount.rerender();
    oldKeyDown?.({ key: 'Escape', isComposing: false, keyCode: 0 } as never);
    expect(second.focus).not.toHaveBeenCalled();
    expect(mount.rerender().filter(element => element.props.role === 'menu')).toHaveLength(1);
    mount.unmount();
    expect(windowMock.count()).toBe(0);
  });

  it.each(['pointercancel', 'Escape', 'pointerup'] as const)('%s ends a drag with the expected single commit', ending => {
    const windowMock = windowListeners();
    const document = appendSolid(groupedPart(), extrudeFeature('extrude-2'));
    useAppStore.getState().resetDocument(document);
    const move = vi.spyOn(useAppStore.getState(), 'moveTimelineItem');
    const mount = effectMount();
    const nodes = mount.rerender();
    const timelineRow = row(nodes, 'solid:extrude-2');
    const down = timelineRow.props.onPointerDown as (event: object) => void;
    down({ button: 0, target: {}, clientX: 0, clientY: 0 });
    expect(windowMock.count()).toBe(0);
    mount.rerender();
    expect(windowMock.count()).toBe(4);
    windowMock.dispatch('pointermove', { clientX: 20, clientY: 0 });
    mount.rerender();
    const latePointerUp = windowMock.latest('pointerup');
    expect(useAppStore.getState().document).toBe(document);
    if (ending === 'Escape') windowMock.dispatch('keydown', { key: 'Escape' });
    else windowMock.dispatch(ending, {});
    mount.rerender();
    expect(move).toHaveBeenCalledTimes(ending === 'pointerup' ? 1 : 0);
    const undoCount = useAppStore.getState().undoStack.past.length;
    expect(undoCount).toBe(ending === 'pointerup' ? 1 : 0);
    latePointerUp?.({} as never);
    expect(move).toHaveBeenCalledTimes(ending === 'pointerup' ? 1 : 0);
    expect(useAppStore.getState().undoStack.past).toHaveLength(undoCount);
    mount.unmount();
    expect(windowMock.count()).toBe(0);
  });
});

describe('Point selection retains the actual tree sketch', () => {
  it.each([
    ['shiftKey', false], ['ctrlKey', false], ['shiftKey', true], ['ctrlKey', true],
  ] as const)('%s selects two points in one sketch, foldered second point: %s', (modifier, foldered) => {
    const empty = createEmptyPartDocument();
    let sketch = empty.sketches[0];
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(10, 20, 0)));
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(30, 40, 0)));
    let document = replaceSketch(empty, sketch);
    if (foldered) {
      document = createFeatureFolder(document, t('featureTree.sketchGroup'));
      document = moveFeatureFolderMember(document,
        { kind: 'sketch-feature', sketchId: sketch.id, id: 'point-2' }, 'folder-1');
    }
    const state = () => useAppStore.getState();
    // A whole-document replacement followed by a successful recompute is the reopened-file path.
    state().resetDocument(document);
    state().recordRecomputeRequest(1);
    state().applyRecompute(document, { ...resultFor(document), generation: 1 });
    state().recordRecomputeCompletion(1, 'success');
    const choose = (id: string, modified: boolean): void => {
      const button = one(elements(row(render(), `sketch-feature:${sketch.id}:${id}`)),
        element => element.props.className === 'pcad-tree__select');
      const handler = button.props.onClick as React.MouseEventHandler<HTMLElement>;
      const click = { shiftKey: modified && modifier === 'shiftKey', ctrlKey: modified && modifier === 'ctrlKey' } as React.MouseEvent<HTMLElement>;
      handler(click);
    };
    choose('point-1', false);
    choose('point-2', true);
    expect(state().selection).toEqual(['point-1', 'point-2']);
    expect(state().connectionSelection?.selection).toBe(state().selection);
    expect([...state().connectionSelection?.endpoints.keys() ?? []]).toEqual(['point-1', 'point-2']);
    expect(state().connectionSelection?.endpoints.get('point-1')).toMatchObject({ kind: 'point', sketchId: sketch.id });
    expect(state().connectionSelection?.endpoints.get('point-2')).toMatchObject({ kind: 'point', sketchId: sketch.id });
    expect(selectedPointsConnection().ready).toBe(true);
  });

  it.each(['shiftKey', 'ctrlKey'] as const)('%s does not reinterpret another sketch point with the same ID', modifier => {
    const empty = createEmptyPartDocument();
    let first = empty.sketches[0];
    first = appendFeature(first, createPointFeature(first, absoluteCoordinate(10, 20, 0)));
    first = appendFeature(first, createPointFeature(first, absoluteCoordinate(30, 40, 0)));
    let document = replaceSketch(empty, first);
    const second = { ...first, id: createSketchFor(document).id };
    document = { ...addSketch(document, second), activeSketchId: first.id };
    const state = () => useAppStore.getState();
    state().resetDocument(document);
    state().recordRecomputeRequest(1);
    state().applyRecompute(document, { ...resultFor(document), generation: 1 });
    state().recordRecomputeCompletion(1, 'success');
    function choose(sketchId: string, pointId: string, modified: boolean) {
      const button = one(elements(row(render(), `sketch-feature:${sketchId}:${pointId}`)),
        element => element.props.className === 'pcad-tree__select');
      const handler = button.props.onClick as React.MouseEventHandler<HTMLElement>;
      handler({ shiftKey: modified && modifier === 'shiftKey', ctrlKey: modified && modifier === 'ctrlKey' } as React.MouseEvent<HTMLElement>);
    }
    choose(first.id, 'point-1', false);
    choose(second.id, 'point-2', true);
    expect(state().selection).toEqual(['point-1', 'point-2']);
    expect(state().sketch.id).toBe(first.id);
    const before = state();
    expect(connectSelectedPoints().ready).toBe(false);
    expect(state().document).toBe(before.document);
    expect(state().undoStack).toBe(before.undoStack);
  });
});

describe('Tree menu contents', () => {
  const common: MessageKey[] = ['featureTree.rename', 'historyNote.edit', 'historyFolder.moveTitle', 'featureTree.delete'];
  it.each([
    ['sketch:sketch-1', ['featureTree.addSketch', ...common]],
    ['sketch-feature:sketch-1:point-1', ['originCommand.action', ...common]],
    ['sketch-feature:sketch-1:line-1', common],
    ['solid:extrude-1', ['featureTree.suppress', 'timeline.moveUp', 'timeline.moveDown', ...common]],
  ] as const)('%s lists only the actions available for its row kind', (id, expected) => {
    open(render(), id);
    expect(render().filter(element => element.props.role === 'menuitem').map(element => element.props.children))
      .toEqual(expected.map(label => t(label)));
  });

  it('disables deleting a sketch used by a solid and explains why', () => {
    open(render(), 'sketch:sketch-1');
    const remove = menuItem(render(), 'featureTree.delete');
    expect(remove.props.disabled).toBe(true);
    expect(remove.props.title).toBe(t('featureTree.sketchDeleteBlocked'));
  });

  it('disables deleting the last sketch when its parent row is shown in a folder', () => {
    const document = createFeatureFolder(partWithMixedFeatures(), t('featureTree.sketchGroup'));
    useAppStore.getState().resetDocument(moveFeatureFolderMember(document, { kind: 'sketch', id: 'sketch-1' }, 'folder-1'));
    open(render(), 'sketch:sketch-1');
    const remove = menuItem(render(), 'featureTree.delete');
    expect(remove.props.disabled).toBe(true);
    expect(remove.props.title).toBe(t('featureTree.sketchDeleteLast'));
  });

  it('disables both move directions for the only solid and explains each boundary', () => {
    open(render(), 'solid:extrude-1');
    const nodes = render();
    expect(menuItem(nodes, 'timeline.moveUp').props.disabled).toBe(true);
    expect(menuItem(nodes, 'timeline.moveDown').props.disabled).toBe(true);
    expect(menuItem(nodes, 'timeline.moveUp').props.title).toBe(t('timeline.moveAtTop'));
    expect(menuItem(nodes, 'timeline.moveDown').props.title).toBe(t('timeline.moveAtBottom'));
  });
});

describe.each(['part', 'assembly'] as const)('%s menu keyboard controls', kind => {
  function setup() {
    if (kind === 'part') return { component: FeatureTree, id: 'solid:extrude-1' };
    let assembly = createAssemblyDocument(t('assembly.tree.componentSubAssembly'));
    assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: 'part-1' }, { partName: t('assembly.tree.componentPart') }));
    useAppStore.getState().openAssembly(assembly);
    return { component: AssemblyTree, id: 'component:component-1' };
  }

  it('cycles through enabled items with arrows/Home/End and restores the trigger on Escape', () => {
    const { component, id } = setup();
    const opener = open(render(component), id);
    const nodes = render(component);
    const menu = one(nodes, element => element.props.role === 'menu');
    const available = nodes.filter(element => element.props.role === 'menuitem' && element.props.disabled !== true);
    const ownerDocument: { activeElement: object | null } = { activeElement: null };
    const buttons = available.map(() => ({ focus() { ownerDocument.activeElement = this; } }));
    ownerDocument.activeElement = buttons[0];
    const query = vi.fn((selector: string) => {
      expect(selector).toBe('button[role="menuitem"]:not(:disabled)');
      return buttons;
    });
    const target = { querySelectorAll: query, ownerDocument };
    for (const [pressed, index] of [['ArrowDown', 1], ['End', buttons.length - 1], ['ArrowDown', 0],
      ['ArrowUp', buttons.length - 1], ['Home', 0]] as const) {
      const event = key(menu, pressed, false, 0, target);
      expect(ownerDocument.activeElement).toBe(buttons[index]);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    }
    expect(key(menu, 'Enter', false, 0, target).preventDefault).not.toHaveBeenCalled();
    expect(key(menu, 'Tab', false, 0, target).preventDefault).not.toHaveBeenCalled();
    key(menu, 'Escape');
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(render(component).filter(element => element.props.role === 'menu')).toHaveLength(0);
  });

  it('restores the context-clicked row menu trigger on Escape', () => {
    const { component, id } = setup();
    const opener = { focus: vi.fn() };
    const event = { preventDefault: vi.fn(), clientX: 100, clientY: 100, currentTarget: {
      querySelector: () => opener,
    } };
    const context = row(render(component), id).props.onContextMenu as (value: typeof event) => void;
    context(event);
    key(one(render(component), element => element.props.role === 'menu'), 'Escape');
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(render(component).filter(element => element.props.role === 'menu')).toHaveLength(0);
  });

  it.each([[true, 13], [false, 229]] as const)('leaves composition keys (%s/%i) to the IME', (composing, code) => {
    const { component, id } = setup();
    const opener = open(render(component), id);
    const menu = one(render(component), element => element.props.role === 'menu');
    const querySelectorAll = vi.fn();
    for (const pressed of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) {
      const event = key(menu, pressed, composing, code, { querySelectorAll });
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(querySelectorAll).not.toHaveBeenCalled();
    expect(opener.focus).not.toHaveBeenCalled();
    expect(render(component).filter(element => element.props.role === 'menu')).toHaveLength(1);
  });
});

describe.each([
  ['sketch:sketch-1', (document: PartDocument) => document.sketches[0].name],
  ['sketch-feature:sketch-1:point-1', (document: PartDocument) => document.sketches[0].features[0].name],
  ['sketch-feature:sketch-1:line-1', (document: PartDocument) => document.sketches[0].features[1].name],
  ['solid:extrude-1', (document: PartDocument) => document.solids[0].name],
] as const)('%s name input', (id, nameOf) => {
  function input(): Element {
    open(render(), id);
    click(menuItem(render(), 'featureTree.rename'));
    return one(render(), element => element.props.className === 'pcad-tree__rename');
  }
  it.each([[true, 13], [false, 229]] as const)('ignores Enter/Escape during composition (%s/%i), then commits once with Enter', (composing, code) => {
    const field = input();
    const before = useAppStore.getState().document;
    for (const pressed of ['Enter', 'Escape']) {
      const event = key(field, pressed, composing, code);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(useAppStore.getState().document).toBe(before);
      expect(render().filter(element => element.props.className === 'pcad-tree__rename')).toHaveLength(1);
    }
    key(field, 'Enter');
    expect(nameOf(useAppStore.getState().document)).toBe(renamedName);
    expect(render().filter(element => element.props.className === 'pcad-tree__rename')).toHaveLength(0);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toEqual(before);
  });
  it('preserves cancellation with Escape and confirmation on blur', () => {
    const before = useAppStore.getState().document;
    key(input(), 'Escape');
    expect(useAppStore.getState().document).toBe(before);
    const field = input();
    const blur = field.props.onBlur as React.FocusEventHandler<HTMLInputElement>;
    blur({ currentTarget: { value: blurredName } } as React.FocusEvent<HTMLInputElement>);
    expect(nameOf(useAppStore.getState().document)).toBe(blurredName);
    expect(render().filter(element => element.props.className === 'pcad-tree__rename')).toHaveLength(0);
  });
});
