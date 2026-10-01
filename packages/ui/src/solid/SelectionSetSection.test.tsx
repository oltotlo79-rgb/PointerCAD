import React, { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionSetSection } from './SelectionSetSection.js';
import { bodyFor, partWithMixedFeatures, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';

const renamedName = t('propertyPanel.sectionSelectionSets');
const originalName = t('featureTree.solidGroup');
const cancelledName = t('featureTree.sketchGroup');

// Retain only the component's local draft state. The controls and store actions are real.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  return { ...original, useState: <S,>(initial: S) => {
    const index = hooks.cursor++;
    if (index === hooks.values.length) hooks.values.push(initial);
    return [hooks.values[index] as S, (next: SetStateAction<S>) => {
      hooks.values[index] = typeof next === 'function' ? (next as (previous: S) => S)(hooks.values[index] as S) : next;
    }];
  } };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child, ...elements(child.props.children as ReactNode));
  });
  return result;
}
function render(): Element[] {
  hooks.cursor = 0;
  let tree: ReactNode = null;
  function Probe() { tree = SelectionSetSection(); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  return elements(tree);
}
function field(rename: boolean): Element {
  const title = t(rename ? 'controlGuide.selectionSet.rename' : 'controlGuide.selectionSet.name');
  const found = render().find(element => element.type === 'input' && element.props.title === title);
  if (!found) throw new Error(`Missing input: ${title}`);
  return found;
}
function change(element: Element, value: string): void {
  const handler = element.props.onChange as React.ChangeEventHandler<HTMLInputElement>;
  handler({ target: { value } } as React.ChangeEvent<HTMLInputElement>);
}
function press(element: Element, composing: boolean, keyCode: number): void {
  const event = { key: 'Enter', keyCode, nativeEvent: { isComposing: composing }, preventDefault: vi.fn() };
  const handler = element.props.onKeyDown as (value: typeof event) => void;
  handler(event);
}
function startRename(): void {
  const button = render().find(element => element.props.className === 'pcad-constraint-row__pick');
  if (!button) throw new Error('Missing saved set');
  const handler = button.props.onDoubleClick as React.MouseEventHandler<HTMLButtonElement>;
  handler({} as React.MouseEvent<HTMLButtonElement>);
}

beforeEach(() => {
  resetTestStore();
  useAppStore.getState().resetDocument(partWithMixedFeatures());
  useAppStore.setState({ bodies: [bodyFor('extrude-1')], selection: ['extrude-1'] });
  hooks.values = [];
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe.each([false, true])('Selection set composition (rename=%s)', rename => {
  it.each([[true, 13], [false, 229]] as const)('preserves the draft during composition (%s/%i) and saves once on the next Enter', (composing, code) => {
    if (rename) {
      expect(useAppStore.getState().createSelectionSetFromSelection(originalName)).toBeNull();
      startRename();
    }
    const before = useAppStore.getState().document;
    change(field(rename), renamedName);
    press(field(rename), composing, code);
    expect(useAppStore.getState().document).toBe(before);
    expect(field(rename).props.value).toBe(renamedName);
    press(field(rename), false, 13);
    expect(useAppStore.getState().document.selectionSets).toHaveLength(1);
    expect(useAppStore.getState().document.selectionSets[0].name).toBe(renamedName);
    if (rename) expect(render().filter(element => element.props.title === t('controlGuide.selectionSet.rename'))).toHaveLength(0);
    else expect(field(false).props.value).toBe('');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toEqual(before);
  });
});

it('associates the name label with the input inside the inset section fields', () => {
  const nodes = render();
  const input = nodes.find(element => element.type === 'input' && element.props.title === t('controlGuide.selectionSet.name'));
  expect(input?.props.id).toEqual(expect.any(String));
  const fields = nodes.find(element => element.props.className === 'pcad-section__fields');
  expect(fields).toBeDefined();
  const children = elements(fields?.props.children as ReactNode);
  expect(children).toContain(input);
  const label = children.find(element => element.type === 'label' && element.props.htmlFor === input?.props.id);
  expect(label?.props.children).toBe(t('propertyPanel.selectionSetName'));
});

it('cancels renaming on blur and keeps the original name', () => {
  useAppStore.getState().createSelectionSetFromSelection(originalName);
  startRename();
  change(field(true), cancelledName);
  const blur = field(true).props.onBlur as React.FocusEventHandler<HTMLInputElement>;
  blur({} as React.FocusEvent<HTMLInputElement>);
  expect(useAppStore.getState().document.selectionSets[0].name).toBe(originalName);
  expect(render().filter(element => element.props.title === t('controlGuide.selectionSet.rename'))).toHaveLength(0);
});

it('rejects a blank name after composition and keeps the draft', () => {
  useAppStore.getState().createSelectionSetFromSelection(originalName);
  startRename();
  change(field(true), ' ');
  const before = useAppStore.getState().document;
  press(field(true), false, 13);
  expect(useAppStore.getState().document).toBe(before);
  expect(field(true).props.value).toBe(' ');
});
