/**
 * R07(F07): FeatureTree の入力4系列(選択・編集の確定・ドラッグ・取消)の境界でのストア更新と、
 * 装着・破棄・文書の差し替えをまたぐ寿命。
 *
 * 更新の順(TRACE_*)は、入力状態・寿命・表示を分ける前の実装で記録した値である。分けた後も
 * 同じ操作で同じ更新が同じ順に起きることを確かめる(期待値は分ける前の動きそのもの)。
 */
import React, { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSketch, appendSolid, createSketchFor, type PartDocument } from '@pointercad/model';
import { FeatureTree } from './FeatureTree.js';
import { FeatureFolderTree } from '../history/FeatureFolderTree.js';
import { t, type MessageKey } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { extrudeFeature, partWithMixedFeatures, resetTestStore, resultFor } from '../store/testing/createTestStore.js';

// Node has no DOM. Keep local hook state between renders and run the real effects only when a
// case mounts the tree (same harness as FeatureTree.test.tsx).
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
function render(): Element[] {
  hooks.state = 0;
  hooks.ref = 0;
  hooks.effects = [];
  let tree: ReactNode = null;
  function Probe() { tree = FeatureTree(); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  return elements(tree);
}

/** Store subscriptions made through useSyncExternalStore, run as effects of the mounted tree. */
const subscriptions = { active: 0, notified: 0 };

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
    dispatch(type: string, event: object) { for (const listener of [...listeners.get(type) ?? []]) listener(event as never); },
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
  return one(nodes, element => element.props['data-name-search-key'] === JSON.stringify(key.split(':')));
}
function selectButton(nodes: Element[], key: string): Element {
  return one(elements(row(nodes, key)), element => typeof element.props.className === 'string'
    && element.props.className.split(' ').includes('pcad-tree__select'));
}
function click(element: Element, event: object = {}): void {
  (element.props.onClick as (value: object) => void)({ currentTarget: {}, ...event });
}
function key(element: Element, name: string, composing = false, keyCode = 0, currentTarget: object = { value: 'renamed on Enter' }) {
  const event = { key: name, keyCode, nativeEvent: { isComposing: composing }, currentTarget,
    preventDefault: vi.fn(), stopPropagation: vi.fn() };
  (element.props.onKeyDown as (value: typeof event) => void)(event);
  return event;
}
function open(nodes: Element[], rowKey: string) {
  const trigger = one(elements(row(nodes, rowKey)), element => element.props['aria-haspopup'] === 'menu');
  const button = { focus: vi.fn(), getBoundingClientRect: () => ({ right: 200, bottom: 100, top: 74 }) };
  click(trigger, { currentTarget: button });
  return button;
}
function context(nodes: Element[], rowKey: string) {
  const opener = { focus: vi.fn() };
  (row(nodes, rowKey).props.onContextMenu as (value: object) => void)({ preventDefault: vi.fn(), clientX: 100, clientY: 100,
    currentTarget: { querySelector: () => opener } });
  return opener;
}
function menuItem(nodes: Element[], label: MessageKey): Element {
  return one(nodes, element => element.props.role === 'menuitem' && element.props.children === t(label));
}
function menus(nodes: Element[]): Element[] {
  return nodes.filter(element => element.props.role === 'menu');
}
function renameInputs(nodes: Element[]): Element[] {
  return nodes.filter(element => element.props.className === 'pcad-tree__rename');
}
function pointerDown(nodes: Element[], rowKey: string): void {
  (row(nodes, rowKey).props.onPointerDown as (event: object) => void)({ button: 0, target: {}, clientX: 0, clientY: 0 });
}

function fixture(name = 'Part 1'): PartDocument {
  const base = partWithMixedFeatures();
  return { ...appendSolid(addSketch(base, createSketchFor(base)), extrudeFeature('extrude-2')), name };
}
function resetFixture(): void {
  resetTestStore();
  const document = fixture();
  const state = useAppStore.getState();
  state.resetDocument(document);
  state.recordRecomputeRequest(1);
  state.applyRecompute(document, { ...resultFor(document), generation: 1 });
  state.recordRecomputeCompletion(1, 'success');
}

const WATCHED = ['document', 'undoStack', 'documentVersion', 'selection', 'connectionSelection', 'hoveredElementId',
  'workPlaneId', 'timelineIndex', 'timelineNoticeKey', 'timelineRefusal', 'editErrorKey', 'originNoticeMessage',
  'activeTool', 'selectionKind'] as const satisfies readonly (keyof AppState)[];

/*
 * 分ける前の実装で記録した更新の順(RUN 20261005-173510-cl-v103-w18-tree-unit、
 * FeatureTree.tsx の SHA-256 72af838552febf85187b680b0c2e42307593f4b5266f0bcf9c9fa31a34630e77)。
 */
const TRACE_SELECTION: readonly string[] = [
  'hover-enter: hoveredElementId',
  'hover-leave: hoveredElementId',
  'click: selection,connectionSelection',
  'ctrl-add: selection,connectionSelection',
  'shift-remove: selection,connectionSelection',
  'context-select: selection,connectionSelection',
  'sketch-switch: document,undoStack,selection',
  'name-search: document,undoStack,selection',
  'name-search: selection,connectionSelection',
];
const TRACE_EDIT: readonly string[] = [
  'suppress: document,undoStack,selection',
  'move-down: document,undoStack,selection',
  'rename-enter: document,undoStack,selection',
  'rename-blur: document,undoStack,selection',
  'origin: document,undoStack,selection',
  'origin: originNoticeMessage',
  'add-sketch: document,undoStack,selection,originNoticeMessage',
  'delete-menu: document,undoStack,selection',
  'delete-key: document,undoStack,selection',
];
const TRACE_DRAG: readonly string[] = [
  'up: document,undoStack,selection',
];
const TRACE_CANCEL: readonly string[] = [];

/** Each store notification is written as "step: changed keys" in the order they happen. */
function record(run: (step: (name: string, act: () => void) => void) => void): string[] {
  const trace: string[] = [];
  let current = 'start';
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    const changed = WATCHED.filter(name => next[name] !== previous[name]);
    if (changed.length > 0) trace.push(`${current}: ${changed.join(',')}`);
  });
  try { run((name, act) => { current = name; act(); }); } finally { unsubscribe(); }
  return trace;
}

beforeEach(() => {
  hooks.values = []; hooks.refs = [];
  hooks.captureEffects = false; hooks.effects = [];
  subscriptions.active = 0; subscriptions.notified = 0;
  resetFixture();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((subscribe, getSnapshot) => {
    if (hooks.captureEffects) {
      hooks.effects.push({ deps: [subscribe], setup: () => {
        subscriptions.active += 1;
        const unsubscribe = subscribe(() => { subscriptions.notified += 1; });
        return () => { subscriptions.active -= 1; unsubscribe(); };
      } });
    }
    return getSnapshot();
  });
  vi.stubGlobal('window', { innerWidth: 1440, innerHeight: 900 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTestStore(); });

describe('R07 FeatureTree store updates at the boundaries of the four input series', () => {
  it('selection: hover, click, Ctrl add, Shift remove, context click, sketch switch, name search', () => {
    windowListeners();
    const mount = effectMount();
    let nodes = mount.rerender();
    const trace = record(step => {
      step('hover-enter', () => { (row(nodes, 'sketch-feature:sketch-1:point-1').props.onPointerEnter as () => void)(); });
      step('hover-leave', () => { (row(nodes, 'sketch-feature:sketch-1:point-1').props.onPointerLeave as () => void)(); });
      step('click', () => { click(selectButton(nodes, 'sketch-feature:sketch-1:point-1')); });
      nodes = mount.rerender();
      step('ctrl-add', () => { click(selectButton(nodes, 'sketch-feature:sketch-1:line-1'), { ctrlKey: true }); });
      nodes = mount.rerender();
      step('shift-remove', () => { click(selectButton(nodes, 'sketch-feature:sketch-1:line-1'), { shiftKey: true }); });
      nodes = mount.rerender();
      step('context-select', () => { context(nodes, 'solid:extrude-1'); });
      nodes = mount.rerender();
      step('sketch-switch', () => { click(selectButton(nodes, 'sketch:sketch-2')); });
      nodes = mount.rerender();
      step('name-search', () => {
        const search = one(nodes, element => typeof element.props.getEntries === 'function');
        const entries = (search.props.getEntries as () => readonly { readonly selectionId: string | null }[])();
        const entry = entries.find(item => item.selectionId === 'point-1');
        if (entry === undefined) throw new Error('name search entry missing');
        (search.props.onSelect as (value: typeof entry) => void)(entry);
      });
    });
    expect(trace).toEqual(TRACE_SELECTION);
    mount.unmount();
  });

  it('edit commits: suppress, move down, rename (Enter and blur), origin, add sketch, delete (menu and Delete)', () => {
    windowListeners();
    const mount = effectMount();
    let nodes = mount.rerender();
    const trace = record(step => {
      step('menu-open', () => { open(nodes, 'solid:extrude-1'); });
      nodes = mount.rerender();
      step('suppress', () => { click(menuItem(nodes, 'featureTree.suppress')); });
      nodes = mount.rerender();
      open(nodes, 'solid:extrude-1'); nodes = mount.rerender();
      step('move-down', () => { click(menuItem(nodes, 'timeline.moveDown')); });
      nodes = mount.rerender();
      open(nodes, 'sketch-feature:sketch-1:point-1'); nodes = mount.rerender();
      step('rename-open', () => { click(menuItem(nodes, 'featureTree.rename')); });
      nodes = mount.rerender();
      step('rename-enter', () => { key(one(renameInputs(nodes), () => true), 'Enter'); });
      nodes = mount.rerender();
      open(nodes, 'sketch:sketch-2'); nodes = mount.rerender();
      click(menuItem(nodes, 'featureTree.rename')); nodes = mount.rerender();
      step('rename-blur', () => {
        (one(renameInputs(nodes), () => true).props.onBlur as (event: object) => void)({ currentTarget: { value: 'renamed on blur' } });
      });
      nodes = mount.rerender();
      open(nodes, 'sketch-feature:sketch-1:point-1'); nodes = mount.rerender();
      step('origin', () => { click(menuItem(nodes, 'originCommand.action')); });
      nodes = mount.rerender();
      step('add-sketch', () => { click(one(nodes, element => element.props.className === 'pcad-tree__add')); });
      nodes = mount.rerender();
      open(nodes, 'sketch-feature:sketch-1:line-1'); nodes = mount.rerender();
      step('delete-menu', () => { click(menuItem(nodes, 'featureTree.delete')); });
      nodes = mount.rerender();
      step('delete-key', () => { key(selectButton(nodes, 'solid:extrude-2'), 'Delete'); });
    });
    expect(trace).toEqual(TRACE_EDIT);
    mount.unmount();
  });

  it('drag: press, move, and reorder only once on release', () => {
    const windowMock = windowListeners();
    const mount = effectMount();
    let nodes = mount.rerender();
    const trace = record(step => {
      step('down', () => { pointerDown(nodes, 'solid:extrude-2'); });
      nodes = mount.rerender();
      step('move', () => { windowMock.dispatch('pointermove', { clientX: 20, clientY: 0 }); });
      nodes = mount.rerender();
      step('up', () => { windowMock.dispatch('pointerup', {}); });
      nodes = mount.rerender();
    });
    expect(trace).toEqual(TRACE_DRAG);
    expect(windowMock.count()).toBe(0);
    mount.unmount();
  });

  it('cancel: menu Escape and outside press, rename Escape and composition, drag Escape and pointercancel', () => {
    const windowMock = windowListeners();
    const mount = effectMount();
    let nodes = mount.rerender();
    const trace = record(step => {
      const opener = open(nodes, 'solid:extrude-1'); nodes = mount.rerender();
      step('menu-escape', () => { key(one(menus(nodes), () => true), 'Escape'); });
      expect(opener.focus).toHaveBeenCalledOnce();
      nodes = mount.rerender();
      open(nodes, 'solid:extrude-1'); nodes = mount.rerender();
      step('menu-outside', () => { windowMock.dispatch('pointerdown', { target: {} }); });
      nodes = mount.rerender();
      open(nodes, 'sketch-feature:sketch-1:point-1'); nodes = mount.rerender();
      click(menuItem(nodes, 'featureTree.rename')); nodes = mount.rerender();
      step('rename-composing', () => { key(one(renameInputs(nodes), () => true), 'Enter', true, 229); });
      nodes = mount.rerender();
      step('rename-escape', () => { key(one(renameInputs(nodes), () => true), 'Escape'); });
      nodes = mount.rerender();
      pointerDown(nodes, 'solid:extrude-2'); nodes = mount.rerender();
      windowMock.dispatch('pointermove', { clientX: 20, clientY: 0 }); nodes = mount.rerender();
      const late = windowMock.latest('pointerup');
      step('drag-escape', () => { windowMock.dispatch('keydown', { key: 'Escape' }); });
      nodes = mount.rerender();
      step('drag-late-up', () => { late?.({} as never); });
      pointerDown(nodes, 'solid:extrude-2'); nodes = mount.rerender();
      windowMock.dispatch('pointermove', { clientX: 20, clientY: 0 }); nodes = mount.rerender();
      step('drag-cancel', () => { windowMock.dispatch('pointercancel', {}); });
      nodes = mount.rerender();
    });
    expect(trace).toEqual(TRACE_CANCEL);
    expect(windowMock.count()).toBe(0);
    mount.unmount();
  });
});

describe('R07 FeatureTree lifetime', () => {
  it('100 mounts and disposals with an open menu, a drag and a hover leave no listener, subscription or transient display', () => {
    const windowMock = windowListeners();
    const before = useAppStore.getState();
    for (let cycle = 0; cycle < 100; cycle += 1) {
      hooks.values = []; hooks.refs = [];
      const mount = effectMount();
      let nodes = mount.rerender();
      expect(subscriptions.active).toBeGreaterThan(0);
      (row(nodes, 'solid:extrude-1').props.onPointerEnter as () => void)();
      expect(useAppStore.getState().hoveredElementId).toBe('extrude-1');
      open(nodes, 'solid:extrude-1'); nodes = mount.rerender();
      pointerDown(nodes, 'solid:extrude-2'); mount.rerender();
      windowMock.dispatch('pointermove', { clientX: 20, clientY: 0 }); mount.rerender();
      expect(windowMock.count()).toBe(6);
      const late = { up: windowMock.latest('pointerup'), key: windowMock.latest('keydown'), down: windowMock.latest('pointerdown') };
      mount.unmount();
      expect(windowMock.count()).toBe(0);
      expect(subscriptions.active).toBe(0);
      expect(useAppStore.getState().hoveredElementId).toBeNull();
      const notified = subscriptions.notified;
      late.up?.({} as never); late.key?.({ key: 'Escape', isComposing: false, keyCode: 0 } as never);
      late.down?.({ target: {} } as never);
      useAppStore.getState().setHovered('extrude-2'); useAppStore.getState().setHovered(null);
      expect(subscriptions.notified).toBe(notified);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    }
  });

  it('disposal keeps a hover that the tree did not publish', () => {
    windowListeners();
    const mount = effectMount();
    const nodes = mount.rerender();
    (row(nodes, 'solid:extrude-1').props.onPointerEnter as () => void)();
    useAppStore.getState().setHovered('point-1');
    mount.unmount();
    expect(useAppStore.getState().hoveredElementId).toBe('point-1');
  });

  it.each(['undo', 'open'] as const)('a document replacement (%s) drops the menu, the rename field and the drag', replacement => {
    const windowMock = windowListeners();
    const replace = (): void => {
      const state = useAppStore.getState();
      if (replacement === 'undo') state.undo();
      else state.applyDocument(fixture('Other part'), { opensDocument: true });
    };
    // 差し替える前の文書に戻せる段を1つ作る(Undo の場合)。
    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, name: 'edited 1' });
    const mount = effectMount();
    let nodes = mount.rerender();
    open(nodes, 'solid:extrude-1'); nodes = mount.rerender();
    expect(menus(nodes)).toHaveLength(1);
    expect(windowMock.count()).toBe(2);
    replace();
    nodes = mount.rerender();
    expect(menus(nodes)).toHaveLength(0);
    expect(windowMock.count()).toBe(0);

    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, name: 'edited 2' });
    nodes = mount.rerender();
    open(nodes, 'sketch-feature:sketch-1:point-1'); nodes = mount.rerender();
    click(menuItem(nodes, 'featureTree.rename')); nodes = mount.rerender();
    expect(renameInputs(nodes)).toHaveLength(1);
    replace();
    nodes = mount.rerender();
    expect(renameInputs(nodes)).toHaveLength(0);

    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, name: 'edited 3' });
    nodes = mount.rerender();
    pointerDown(nodes, 'solid:extrude-2'); mount.rerender();
    windowMock.dispatch('pointermove', { clientX: 20, clientY: 0 }); mount.rerender();
    expect(windowMock.count()).toBe(4);
    const late = windowMock.latest('pointerup');
    replace();
    mount.rerender();
    expect(windowMock.count()).toBe(0);
    const replaced = useAppStore.getState();
    late?.({} as never);
    windowMock.dispatch('pointerup', {});
    expect(useAppStore.getState().timelineRefusal).toBeNull();
    expect(useAppStore.getState().document).toBe(replaced.document);
    expect(useAppStore.getState().undoStack).toBe(replaced.undoStack);
    mount.unmount();
    expect(windowMock.count()).toBe(0);
  });
});
