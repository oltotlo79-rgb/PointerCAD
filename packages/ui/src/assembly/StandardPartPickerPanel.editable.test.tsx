import React, { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument, steelProducts } from '@pointercad/model';
import { buildSteelBendChoice, DEFAULT_STEEL_BEND_SOURCES } from './steelBendPicker.js';
import { placeEditableSteelBend } from './steelEditablePart.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { StandardPartPicker } from './StandardPartPickerPanel.js';

// Same boundary harness as StandardPartPickerPanel.test.tsx: real handlers, real store, Node rendering only.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], state: 0 }));
vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof import('react')>();
  return { ...original, useState: <S,>(initial: S | (() => S)) => {
    const index = hooks.state++;
    if (index === hooks.values.length) hooks.values.push(typeof initial === 'function' ? (initial as () => S)() : initial);
    return [hooks.values[index] as S, (next: SetStateAction<S>) => {
      hooks.values[index] = typeof next === 'function' ? (next as (previous: S) => S)(hooks.values[index] as S) : next;
    }];
  } };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child);
    found.push(...elements(child.props.children as ReactNode));
  });
  return found;
}
function render(): Element[] {
  hooks.state = 0;
  let tree: ReactNode = null;
  function Probe(): null { tree = StandardPartPicker(); return null; }
  renderToStaticMarkup(<Probe />);
  return elements(tree);
}
function one(nodes: Element[], predicate: (element: Element) => boolean): Element {
  const matches = nodes.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0];
}
function byTitle(nodes: Element[], type: string, title: Parameters<typeof t>[0]): Element[] {
  return nodes.filter((element) => element.type === type && element.props.title === t(title));
}
function change(element: Element, value: string): Element[] {
  (element.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } });
  return render();
}
function check(element: Element, checked: boolean): Element[] {
  (element.props.onChange as (event: { currentTarget: { checked: boolean } }) => void)({ currentTarget: { checked } });
  return render();
}
function submit(nodes: Element[]): void {
  const form = one(nodes, (element) => element.type === 'form');
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
}
function text(nodes: Element[], key: Parameters<typeof t>[0]): Element[] {
  return nodes.filter((element) => element.props.children === t(key)
    || Children.toArray(element.props.children as ReactNode).includes(t(key)));
}
function structuralPanel(): Element[] {
  return change(one(render(), (element) => element.type === 'select'
    && element.props.title === t('assembly.guide.standardCategory')), 'structuralSection');
}
function editableBox(nodes: Element[]): Element[] {
  return byTitle(nodes, 'input', 'assembly.steel.editable.enableGuide');
}

const save = vi.fn<(name: string, kind: string, bytes: Uint8Array) => Promise<boolean>>();
beforeEach(() => {
  hooks.values = []; hooks.state = 0;
  resetTestStore();
  save.mockReset();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  useAppStore.getState().openAssembly(createAssemblyDocument('Steel'));
  useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs: save } });
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('picker ' + t('assembly.steel.editable.enable'), () => {
  it('is offered for graded steel only, also with a bend, and leaves the normal place button unchanged', () => {
    let nodes = structuralPanel();
    const box = one(editableBox(nodes), () => true);
    expect([box.props.type, box.props.checked]).toEqual(['checkbox', false]);
    const place = one(nodes, (element) => element.type === 'button' && element.props.type === 'submit');
    expect([place.props.title, place.props.children]).toEqual([t('assembly.guide.standardPlace'), t('assembly.standardPart.place')]);
    nodes = check(one(byTitle(nodes, 'input', 'assembly.steel.bend.enableGuide'), () => true), true);
    expect(editableBox(nodes)).toHaveLength(1);
    nodes = check(one(byTitle(nodes, 'input', 'assembly.steel.bend.enableGuide'), () => true), false);
    nodes = change(one(nodes, (element) => element.type === 'select'
      && element.props.title === t('assembly.steel.materialGuide')), 'unspecified');
    expect(editableBox(nodes)).toHaveLength(0);
  });

  it('saves a new part file and opens the ordinary placement instead of placing a standard part', async () => {
    save.mockResolvedValue(true);
    let nodes = check(one(editableBox(structuralPanel()), () => true), true);
    const place = one(nodes, (element) => element.type === 'button' && element.props.type === 'submit');
    expect([place.props.title, place.props.children])
      .toEqual([t('assembly.steel.editable.enableGuide'), t('assembly.steel.editable.place')]);
    expect(text(nodes, 'assembly.steel.editable.hint')).toHaveLength(1);
    submit(nodes);
    await vi.waitFor(() => expect(useAppStore.getState().assemblyPlacement?.kind).toBe('ready'));
    const placement = useAppStore.getState().assemblyPlacement;
    if (placement?.kind !== 'ready') throw new Error('No ready placement');
    const row = steelProducts('SS400', 'flatBar')[0];
    expect(save.mock.calls.map(([name, kind]) => [name, kind])).toEqual([[`SS400 ${row.size} ${t('assembly.standardPart.length')}1000.pcad`, 'pcad']]);
    expect(placement.document.steelStockSource).toMatchObject({ catalog: 'flatBar', size: row.size,
      options: { steelProduct: row.key, length: '1000' } });
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
    nodes = render();
    expect(nodes).toEqual([]);
  });

  it('reports an invalid length on the length field and a cancelled save as status, placing nothing', async () => {
    let nodes = check(one(editableBox(structuralPanel()), () => true), true);
    nodes = change(one(byTitle(nodes, 'input', 'assembly.guide.standardLength'), () => true), '0');
    submit(nodes);
    await vi.waitFor(() => expect(text(render(), 'assembly.steel.invalidLength')).toHaveLength(1));
    nodes = render();
    expect(one(byTitle(nodes, 'input', 'assembly.guide.standardLength'), () => true).props['aria-invalid']).toBe(true);
    expect(save).not.toHaveBeenCalled();

    save.mockResolvedValue(false);
    nodes = change(one(byTitle(nodes, 'input', 'assembly.guide.standardLength'), () => true), '1000');
    submit(nodes);
    await vi.waitFor(() => expect(text(render(), 'assembly.steel.editable.cancelled')).toHaveLength(1));
    const status = one(render(), (element) => element.type === 'p'
      && Children.toArray(element.props.children as ReactNode).includes(t('assembly.steel.editable.cancelled')));
    expect(status.props.role).toBe('status');
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(true);
  });

  it('keeps the unchecked picker on the ordinary standard-part placement', () => {
    submit(structuralPanel());
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().assembly?.components.map((component) => component.source.kind)).toEqual(['standardPart']);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });
});

describe('picker ' + t('assembly.steel.editable.enable') + ' with ' + t('assembly.steel.bend.enable'), () => {
  const row = steelProducts('SS400', 'flatBar')[0];
  const generated = () => {
    const bend = buildSteelBendChoice(row, DEFAULT_STEEL_BEND_SOURCES);
    if (!bend.ok) throw new Error(`Default bend refused: ${bend.reason}`);
    return bend;
  };
  function editableBendPanel(): Element[] {
    const nodes = check(one(byTitle(structuralPanel(), 'input', 'assembly.steel.bend.enableGuide'), () => true), true);
    return check(one(editableBox(nodes), () => true), true);
  }

  it('saves the bend part file first with a fresh lineage id, then opens the ordinary placement', async () => {
    save.mockResolvedValue(true);
    const nodes = editableBendPanel();
    expect(text(nodes, 'assembly.steel.editable.hint')).toHaveLength(1);
    const place = one(nodes, (element) => element.type === 'button' && element.props.type === 'submit');
    expect([place.props.title, place.props.children]).toEqual([t('assembly.steel.bend.enableGuide'), t('assembly.steel.bend.place')]);
    submit(nodes);
    await vi.waitFor(() => expect(useAppStore.getState().assemblyPlacement?.kind).toBe('ready'));
    const placement = useAppStore.getState().assemblyPlacement;
    if (placement?.kind !== 'ready') throw new Error('No ready placement');
    // Saved before placement: exactly one pcad save, of the same document that is now being placed.
    expect(save.mock.calls.map(([name, kind]) => [name, kind])).toEqual([[`SS400 ${row.size} bend.pcad`, 'pcad']]);
    expect(placement.fileName).toBe(`SS400 ${row.size} bend.pcad`);
    const bend = generated();
    expect(placement.document.id).not.toBe(bend.document.id);
    expect(placement.document.id).toMatch(/^part-uuid:/u);
    expect({ ...placement.document, id: bend.document.id }).toEqual(bend.document);
    expect(placement.document.solids.map((solid) => solid.kind)).toEqual(['sweep']);
    expect(placement.document.steelStockSource).toEqual(bend.document.steelStockSource);
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
  });

  it('a cancelled bend save places nothing and keeps the picker open with a status', async () => {
    save.mockResolvedValue(false);
    submit(editableBendPanel());
    await vi.waitFor(() => expect(text(render(), 'assembly.steel.editable.cancelled')).toHaveLength(1));
    const status = one(render(), (element) => element.type === 'p'
      && Children.toArray(element.props.children as ReactNode).includes(t('assembly.steel.editable.cancelled')));
    expect(status.props.role).toBe('status');
    expect(save).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(true);
  });

  it('a failing file save reports failure as an alert and places nothing', async () => {
    save.mockRejectedValue(new Error('disk full'));
    submit(editableBendPanel());
    await vi.waitFor(() => expect(text(render(), 'assembly.steel.editable.failed')).toHaveLength(1));
    const alert = one(render(), (element) => element.type === 'p'
      && Children.toArray(element.props.children as ReactNode).includes(t('assembly.steel.editable.failed')));
    expect(alert.props.role).toBe('alert');
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().assembly?.components).toEqual([]);
  });

  it('without secure entropy or while busy it saves nothing and leaves the assembly untouched', async () => {
    const before = useAppStore.getState().assembly;
    await expect(placeEditableSteelBend(generated(), () => { throw new Error('no entropy'); })).resolves.toBe('failed');
    useAppStore.setState({ isComputing: true });
    await expect(placeEditableSteelBend(generated())).resolves.toBe('busy');
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().assembly).toBe(before);
  });

  it('a save that completes after the assembly changed is stale and places nothing', async () => {
    save.mockImplementation(() => {
      useAppStore.getState().openAssembly(createAssemblyDocument('Other'));
      return Promise.resolve(true);
    });
    await expect(placeEditableSteelBend(generated())).resolves.toBe('cancelled');
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().assembly?.name).toBe('Other');
  });
});
