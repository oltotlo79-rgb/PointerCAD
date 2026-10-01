import React, { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addComponent, addSketch, createAssemblyDocument, createComponentFor, createFeatureFolder, createSketchFor, moveFeatureFolderMember, type PartDocument } from '@pointercad/model';
import { FeatureTree } from './FeatureTree.js';
import { AssemblyTree } from './AssemblyTree.js';
import { FeatureFolderTree } from '../history/FeatureFolderTree.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { partWithMixedFeatures, resetTestStore } from '../store/testing/createTestStore.js';

const renamedName = t('propertyPanel.sectionSelectionSets');
const blurredName = t('featureTree.sketchGroup');

// Node has no DOM. Preserve local hook state between renders and exercise the actual
// returned controls and store actions. Native focus/Enter dispatch is covered by E2E.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0 }));
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
    useEffect: vi.fn(),
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
  let tree: ReactNode = null;
  function Probe() { tree = component(); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  return elements(tree);
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
  resetTestStore();
  useAppStore.getState().resetDocument(groupedPart());
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  vi.stubGlobal('window', { innerWidth: 1440, innerHeight: 900 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTestStore(); });

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
