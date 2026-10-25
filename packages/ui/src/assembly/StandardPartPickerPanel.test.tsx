import React, { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildStandardPartFromSource, createAssemblyDocument, createStandardPartSource,
  DEFAULT_COMPONENT_PLACEMENT, EMPTY_PART_LIBRARY, STEEL_PRODUCTS, steelProductOptions,
  steelProducts, type AssemblyComponent, type ComponentSource, type StandardPartSource } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ja } from '../i18n/ja.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { StandardPartPicker } from './StandardPartPickerPanel.js';
import { standardPartChoices } from './standardPartPicker.js';
import { SteelBendFields } from './SteelBendFields.js';
import type { SteelBendSources } from './steelBendPicker.js';
import { readPcadFile, writePcadFile } from '@pointercad/io';
import type { PartDocument } from '@pointercad/model';
import { SteelBendEditForm } from './SteelBendFields.js';
import { beginSteelBendPlacement, buildSteelBendChoice, commitSteelBendEdit,
  readSteelBendEditInput, type SteelBendEditTarget } from './steelBendPicker.js';
import { commitPlaceComponent } from './placeComponentActions.js';

// Follow the existing FeatureTree boundary harness: retain local state, invoke the real
// React handlers, and inspect actual store commits. This is a Node test, not browser/layout QA.
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

describe('actual two-stage steel picker', () => {
  it('keeps the closed stock report lazy and refreshes it through the actual open/close toggle', () => {
    let nodes = structuralPanel();
    submit(nodes);
    nodes = render();
    expect(nodes.some((item) => item.type === 'table')).toBe(false);
    const before = useAppStore.getState().assembly;
    nodes = toggleStockReport(nodes, true);
    expect(one(nodes, (item) => item.type === 'table')).toBeDefined();
    expect(nodes.some((item) => item.type === 'button' && item.props.title === t('assembly.steel.csv.exportGuide'))).toBe(true);
    nodes = toggleStockReport(nodes, false);
    expect(nodes.some((item) => item.type === 'table')).toBe(false);
    expect(useAppStore.getState().assembly).toBe(before);
  });
  it('chooses thickness then width and saves the added SS400 row with six exact strings', () => {
    let nodes = structuralPanel();
    expect(optionValues(select(nodes, 'assembly.steel.selectThicknessGuide')))
      .toEqual(['4.5', '6', '9', '12', '16', '19', '22', '25', '28', '32', '36']);
    expect(select(nodes, 'assembly.steel.selectThicknessGuide').props.value).toBe('6');
    nodes = change(select(nodes, 'assembly.steel.selectThicknessGuide'), '28');
    expect(optionValues(select(nodes, 'assembly.steel.selectWidthGuide'))).toHaveLength(12);
    expect(elements(select(nodes, 'assembly.steel.selectWidthGuide').props.children as ReactNode)
      .filter((item) => item.type === 'option').map(optionText))
      .toEqual(['25 mm', '32 mm', '38 mm', '44 mm', '50 mm', '65 mm', '75 mm', '90 mm', '100 mm', '125 mm', '150 mm', '200 mm']);
    nodes = change(select(nodes, 'assembly.steel.selectWidthGuide'), 'steel:SS400:flatBar:FB 100×28');
    expect(select(nodes, 'assembly.guide.standardSize').props.value).toBe('steel:SS400:flatBar:FB 100×28');
    const source = submit(nodes);
    expect(source.options).toEqual({ steelProduct: 'SS400:flatBar:FB 100×28', materialGrade: 'SS400',
      materialStandard: 'JIS G 3101', productStandard: 'JIS G 3194',
      condition: 'hotRolled-heatTreatmentUnspecified', evidence: 'ssFlatDraft', length: '1000' });
    expect(buildStandardPartFromSource(source)).not.toBeNull();
  });

  it.each([[6, 50], [9, 50], [12, 50], [6, 100], [9, 100]])(
    'preserves frozen SS400 thickness %s width %s selection and saved source through two stages', (thickness, width) => {
      let nodes = structuralPanel();
      nodes = change(select(nodes, 'assembly.steel.selectThicknessGuide'), String(thickness));
      const key = `SS400:flatBar:FB ${width}×${thickness}`;
      nodes = change(select(nodes, 'assembly.steel.selectWidthGuide'), `steel:${key}`);
      const source = submit(nodes);
      expect(source.options).toEqual({ steelProduct: key, materialGrade: 'SS400', materialStandard: 'JIS G 3101',
        productStandard: t('assembly.steel.producerFlatDimensions'), condition: 'hotRolled-heatTreatmentUnspecified', evidence: 'flat', length: '1000' });
    });

  it('synchronizes the full-size fallback and refuses a width from another thickness or an unknown thickness', () => {
    let nodes = structuralPanel();
    const details = one(nodes, (item) => item.type === 'details'
      && elements(item.props.children as ReactNode).some((child) => child.type === 'summary'
        && child.props.children === t('assembly.steel.allSizes')));
    expect(details.props.open).toBeUndefined();
    nodes = change(select(nodes, 'assembly.guide.standardSize'), 'steel:SS400:flatBar:FB 25×36');
    expect(select(nodes, 'assembly.steel.selectThicknessGuide').props.value).toBe('36');
    expect(select(nodes, 'assembly.steel.selectWidthGuide').props.value).toBe('steel:SS400:flatBar:FB 25×36');
    nodes = change(select(nodes, 'assembly.steel.selectWidthGuide'), 'steel:SS400:flatBar:FB 50×6');
    nodes = change(select(nodes, 'assembly.steel.selectThicknessGuide'), '7');
    expect(select(nodes, 'assembly.steel.selectWidthGuide').props.value).toBe('steel:SS400:flatBar:FB 25×36');
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
    nodes = change(select(nodes, 'assembly.steel.shapeGuide'), 'roundBar');
    expect(nodes.some((item) => item.type === 'select' && item.props.title === t('assembly.steel.selectThicknessGuide'))).toBe(false);
    expect(optionValues(select(nodes, 'assembly.guide.standardSize'))).toHaveLength(44);
    nodes = change(select(nodes, 'assembly.guide.standardSize'), 'steel:SS400:roundBar:φ5.5');
    expect(submit(nodes).options).toEqual({ steelProduct: 'SS400:roundBar:φ5.5', materialGrade: 'SS400',
      materialStandard: 'JIS G 3101', productStandard: 'JIS G 3191', condition: 'hotRolled-heatTreatmentUnspecified',
      evidence: 'ssRoundDraft', length: '1000' });
  });

  it('keeps same-width S45C bright and hot products distinct in the second stage', () => {
    let nodes = change(select(structuralPanel(), 'assembly.steel.materialGuide'), 'S45C');
    nodes = change(select(nodes, 'assembly.steel.shapeGuide'), 'flatBar');
    nodes = change(select(nodes, 'assembly.steel.selectThicknessGuide'), '6');
    const width = select(nodes, 'assembly.steel.selectWidthGuide');
    expect(optionValues(width)).toContain('steel:S45C:flatBar:FB 50×6');
    expect(optionValues(width)).toContain('steel:S45C:flatBar:FB 50×6:hotRolled');
    const labels = elements(width.props.children as ReactNode).filter((item) => item.type === 'option')
      .map(optionText);
    expect(labels).toContain(`50 mm / ${t('assembly.steel.brightBar')}`);
    expect(labels).toContain(`50 mm / ${t('assembly.steel.hotRolled')}`);
    nodes = change(width, 'steel:S45C:flatBar:FB 50×6');
    expect(submit(nodes).options).toMatchObject({ steelProduct: 'S45C:flatBar:FB 50×6', productStandard: 'JIS G 3123',
      condition: 'brightBar-heatTreatmentUnspecified', evidence: 'brightFlat' });
    nodes = change(select(render(), 'assembly.steel.selectWidthGuide'), 'steel:S45C:flatBar:FB 50×6:hotRolled');
    expect(submit(nodes).options).toMatchObject({ steelProduct: 'S45C:flatBar:FB 50×6:hotRolled', productStandard: 'JIS G 3194',
      condition: 'hotRolled-heatTreatmentUnspecified', evidence: 'hotFlat' });
  });
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
function select(nodes: Element[], title: Parameters<typeof t>[0]): Element {
  return one(nodes, (element) => element.type === 'select' && element.props.title === t(title));
}
function optionValues(element: Element): unknown[] {
  return elements(element.props.children as ReactNode).filter((child) => child.type === 'option')
    .map((child) => child.props.value);
}
function optionText(element: Element): string {
  return Children.toArray(element.props.children as ReactNode).map((child) => {
    if (typeof child !== 'string' && typeof child !== 'number') throw new Error('Expected primitive option text');
    return String(child);
  }).join('');
}
function change(element: Element, value: string): Element[] {
  (element.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } });
  return render();
}
function submit(nodes: Element[]): StandardPartSource {
  const before = useAppStore.getState().assembly?.components.length ?? 0;
  const preventDefault = vi.fn();
  const form = one(nodes, (element) => element.type === 'form');
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  const assembly = useAppStore.getState().assembly;
  expect(assembly?.components).toHaveLength(before + 1);
  const source = assembly?.components.at(-1)?.source;
  if (source?.kind !== 'standardPart') throw new Error('Actual panel/store failed to place a standard part');
  return source;
}
function structuralPanel(): Element[] {
  const nodes = change(select(render(), 'assembly.guide.standardCategory'), 'structuralSection');
  // Tests that inspect an existing stock report open it through the same toggle as the user.
  return (useAppStore.getState().assembly?.components.length ?? 0) === 0 ? nodes : toggleStockReport(nodes, true);
}
function toggleStockReport(nodes: Element[], open: boolean): Element[] {
  const details = one(nodes, (item) => item.type === 'details'
    && elements(item.props.children as ReactNode).some((child) => child.type === 'summary'
      && child.props.children === t('assembly.steel.stockList')));
  (details.props.onToggle as (event: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open } });
  return render();
}
beforeEach(() => {
  hooks.values = []; hooks.state = 0;
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  useAppStore.getState().openAssembly(createAssemblyDocument('Steel selection'));
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('actual structural picker selection and store commits', () => {
  it('selects black and white SGP separately and displays the selected condition through real handlers', () => {
    let nodes = change(select(structuralPanel(), 'assembly.steel.materialGuide'), 'SGP');
    const values = optionValues(select(nodes, 'assembly.guide.standardSize'));
    expect(values).toHaveLength(48);
    expect(values).toContain('steel:SGP:steelPipe:100A');
    expect(values).toContain('steel:SGP:steelPipe:100A:whitePipe-zincCoated');
    nodes = change(select(nodes, 'assembly.guide.standardSize'), 'steel:SGP:steelPipe:100A');
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('assembly.steel.blackPipe'))).toBe(true);
    expect(submit(nodes).options).toMatchObject({ steelProduct: 'SGP:steelPipe:100A', condition: 'blackPipe-plainEnds' });
    nodes = change(select(render(), 'assembly.guide.standardSize'), 'steel:SGP:steelPipe:100A:whitePipe-zincCoated');
    const whitePipeLabel = ja['assembly.steel.whitePipe'];
    expect(nodes.some((item) => item.type === 'p' && item.props.children === whitePipeLabel)).toBe(true);
    expect(whitePipeLabel).toContain('-ZN');
    expect(submit(nodes).options).toMatchObject({ steelProduct: 'SGP:steelPipe:100A:whitePipe-zincCoated',
      condition: 'whitePipe-zincCoated' });
  });
  it('defaults to material-aware SS400 and offers the explicit unassigned legacy path', () => {
    const nodes = structuralPanel();
    const material = select(nodes, 'assembly.steel.materialGuide');
    expect(material.props.value).toBe('SS400');
    expect(optionValues(material)).toEqual(['SS400', 'S45C', 'SGP', 'unspecified']);
    expect(elements(material.props.children as ReactNode).find((item) => item.props.value === 'unspecified')?.props.children)
      .toBe(t('assembly.steel.unspecified'));
    expect(optionValues(select(nodes, 'assembly.guide.standardSize')))
      .toEqual(steelProducts('SS400', 'flatBar').map((row) => `steel:${row.key}`));
  });

  it('reaches and commits every 109 unassigned sizes through real select and submit handlers without assigning a grade', () => {
    let nodes = structuralPanel();
    nodes = change(select(nodes, 'assembly.steel.materialGuide'), 'unspecified');
    const old = standardPartChoices('structuralSection');
    expect(old).toHaveLength(109);
    expect(optionValues(select(nodes, 'assembly.guide.standardSize'))).toEqual(old.map((row) => row.key));
    expect(nodes.some((item) => item.type === 'select' && item.props.title === t('assembly.steel.shapeGuide'))).toBe(false);
    expect(nodes.some((item) => item.props.children === t('assembly.steel.unspecifiedHint'))).toBe(true);
    nodes = change(one(nodes, (item) => item.type === 'input' && item.props.title === t('assembly.guide.standardLength')), '0.5');
    for (const choice of old) {
      nodes = change(select(nodes, 'assembly.guide.standardSize'), choice.key);
      expect(select(nodes, 'assembly.guide.standardSize').props.value).toBe(choice.key);
      const source = submit(nodes);
      expect(source).toMatchObject({ catalog: choice.catalog, size: choice.size,
        catalogRevision: 'jis-2026-09-08-r1', generatorRevision: '1' });
      expect(source.options).toEqual({ length: '0.5' });
      expect(buildStandardPartFromSource(source)).not.toBeNull();
      nodes = render();
    }
    expect(useAppStore.getState().assembly?.components).toHaveLength(109);
  });

  it('switches away from legacy rows and reaches exactly the 459 compatible material rows through real handlers', () => {
    let nodes = structuralPanel();
    nodes = change(select(nodes, 'assembly.steel.materialGuide'), 'unspecified');
    const legacy = standardPartChoices('structuralSection').at(-1);
    if (legacy === undefined) throw new Error('Missing legacy fixture');
    nodes = change(select(nodes, 'assembly.guide.standardSize'), legacy.key);
    for (const row of STEEL_PRODUCTS) {
      nodes = change(select(nodes, 'assembly.steel.materialGuide'), row.materialGrade);
      expect(optionValues(select(nodes, 'assembly.steel.shapeGuide'))).toEqual({
        SS400: ['flatBar', 'roundBar', 'equalAngle', 'channel', 'hBeam'],
        S45C: ['roundBar', 'flatBar'], SGP: ['steelPipe'],
      }[row.materialGrade]);
      nodes = change(select(nodes, 'assembly.steel.shapeGuide'), row.catalog);
      const sizes = select(nodes, 'assembly.guide.standardSize');
      expect(optionValues(sizes)).toEqual(steelProducts(row.materialGrade, row.catalog).map((item) => `steel:${item.key}`));
      expect(optionValues(sizes)).not.toContain(legacy.key);
      nodes = change(sizes, `steel:${row.key}`);
      if (row.geometry === 'profileSection') {
        expect(nodes.some((item) => item.props.children === t('assembly.steel.profile'))).toBe(true);
        const evidence = one(nodes, (item) => item.type === 'a'
          && item.props.children === t('assembly.steel.profileSource'));
        expect(evidence.props.href).toBe(row.profileEvidence?.url);
        expect(evidence.props.title).toBe(row.profileEvidence?.locator);
      }
      const source = submit(nodes);
      expect(source).toMatchObject({ catalog: row.catalog, size: row.size,
        catalogRevision: 'jp-steel-2026-10-10-r1', generatorRevision: '3-steel-profile-1' });
      expect(source.options).toEqual({ ...steelProductOptions(row), length: '1000' });
      expect(buildStandardPartFromSource(source)).not.toBeNull();
      expect(buildStandardPartFromSource(source)?.sketches[0].features.some((feature) => feature.kind === 'arc'))
        .toBe(row.geometry === 'profileSection');
      nodes = render();
    }
    expect(useAppStore.getState().assembly?.components).toHaveLength(459);
    nodes = change(select(nodes, 'assembly.steel.materialGuide'), 'unspecified');
    expect(optionValues(select(nodes, 'assembly.guide.standardSize'))).toHaveLength(109);
    expect(select(nodes, 'assembly.guide.standardSize').props.value).toBe(standardPartChoices('structuralSection')[0].key);
  });

  it('shows repeated nested quantities and plain omissions, and the real CSV button saves that same report', async () => {
    const component = (name: string, source: ComponentSource, suppressed = false): AssemblyComponent => ({
      id: name, name, source, placement: DEFAULT_COMPONENT_PLACEMENT,
      fixed: false, visible: false, suppressed,
    });
    const product = steelProducts('SS400', 'roundBar')[0];
    const source = createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '1000' });
    const child = { ...createAssemblyDocument('Child'), components: [
      component('Round stock', source), component('Suppressed stock', source, true),
      component('Legacy stock', createStandardPartSource('equalAngle', 'L 50×50×6', { length: '1000' })),
      component('Cycle', { kind: 'subAssembly', assemblyRef: 'child' }),
    ] };
    const assembly = { ...createAssemblyDocument('Root'), components: [
      component('Left assembly', { kind: 'subAssembly', assemblyRef: 'child' }),
      component('Right assembly', { kind: 'subAssembly', assemblyRef: 'child' }),
      component('Missing assembly', { kind: 'subAssembly', assemblyRef: 'missing' }),
      component('Suppressed assembly', { kind: 'subAssembly', assemblyRef: 'missing' }, true),
    ] };
    useAppStore.getState().openAssembly(assembly, { ...EMPTY_PART_LIBRARY, assemblies: new Map([['child', child]]) });
    useAppStore.getState().openStandardPartPicker();
    const save = vi.fn<(name: string, kind: string, bytes: Uint8Array) => Promise<boolean>>(() => Promise.resolve(true));
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs: save } });
    const nodes = structuralPanel();
    const table = one(nodes, (item) => item.type === 'table');
    const cells = elements(table.props.children as ReactNode).filter((item) => item.type === 'td');
    expect(cells.map((item) => item.props.children)).toEqual(['SS400', product.size, 1000, 1000, 2, 2000, 'jp-steel-2026-10-10-r1', '3-steel-profile-1', 2, 2000]);
    const omissions = nodes.filter((item) => item.type === 'li');
    const texts = omissions.map((item) => Children.toArray(item.props.children as ReactNode).map((child) => {
      if (typeof child !== 'string' && typeof child !== 'number') throw new Error('Expected primitive omission text');
      return String(child);
    }).join(''));
    expect(texts).toEqual([
      `Left assembly › Legacy stock: ${t('assembly.steel.omittedMaterial')}`,
      `Left assembly › Cycle: ${t('assembly.steel.omittedCycle')}`,
      `Right assembly › Legacy stock: ${t('assembly.steel.omittedMaterial')}`,
      `Right assembly › Cycle: ${t('assembly.steel.omittedCycle')}`,
      `Missing assembly: ${t('assembly.steel.omittedMissing')}`,
    ]);
    expect(nodes.some((item) => item.props.children === t('assembly.steel.stockPartial'))).toBe(true);
    const button = one(nodes, (item) => item.type === 'button' && item.props.title === t('assembly.steel.csv.exportGuide'));
    expect(button.props.type).toBe('button');
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const [name, kind, bytes] = save.mock.calls[0];
    expect([name, kind]).toEqual(['steel-stock-list.csv', 'csv']);
    const csv = new TextDecoder().decode(bytes);
    expect(csv).toContain(',1000,2,2000,');
    expect(csv).toContain(t('assembly.steel.omittedMaterial'));
    expect(csv).toContain(t('assembly.steel.omittedCycle'));
    expect(csv).toContain(t('assembly.steel.omittedMissing'));
    expect(csv).not.toContain('Suppressed stock');
    expect(csv).not.toContain('Suppressed assembly');
    expect(useAppStore.getState().assembly).toBe(assembly);
    expect(useAppStore.getState().assembly?.components).toHaveLength(4);
  });
});

describe('steel provenance in visible list and CSV', () => {
  it('keeps otherwise identical saved generator rows visibly distinct', () => {
    const product = steelProducts('SS400', 'roundBar').find(item => item.size === 'φ25');
    if (product === undefined) throw new Error('Missing independent stock fixture');
    const current = createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '1000' });
    const assembly = { ...createAssemblyDocument('Two saved generators'), components: [
      { id: 'current', name: 'current', source: current, placement: DEFAULT_COMPONENT_PLACEMENT,
        fixed: false, visible: true, suppressed: false },
      { id: 'legacy', name: 'legacy', source: { ...current, generatorRevision: '2-steel-1' },
        placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false },
    ] };
    useAppStore.getState().openAssembly(assembly, EMPTY_PART_LIBRARY);
    useAppStore.getState().openStandardPartPicker();
    const nodes = structuralPanel();
    const table = one(nodes, item => item.type === 'table');
    const contents = elements(table.props.children as ReactNode);
    expect(contents.filter(item => item.type === 'th').map(item => item.props.children)).toEqual(expect.arrayContaining([
      t('assembly.steel.csv.catalogRevision'), t('assembly.steel.csv.generatorRevision'),
    ]));
    const values = contents.filter(item => item.type === 'td').map(item => item.props.children);
    expect(values).toEqual([
      'SS400', 'φ25', 1000, 1000, 1, 1000, 'jp-steel-2026-10-10-r1', '3-steel-profile-1',
      'SS400', 'φ25', 1000, 1000, 1, 1000, 'jp-steel-2026-10-10-r1', '2-steel-1', 2, 2000,
    ]);
  });

  it('refreshes both views from an edited library snapshot and restores the original on undo', async () => {
    const product = steelProducts('SS400', 'roundBar')[0];
    const source = createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '1000' });
    const part = buildStandardPartFromSource(source);
    if (part === null) throw new Error('Missing stock fixture');
    const assembly = { ...createAssemblyDocument('Root'), components: [{ id: 'steel', name: 'steel',
      source: { kind: 'part' as const, partRef: 'steel' }, placement: DEFAULT_COMPONENT_PLACEMENT,
      fixed: false, visible: true, suppressed: false }] };
    const library = { ...EMPTY_PART_LIBRARY, parts: new Map([['steel', part]]) };
    useAppStore.getState().openAssembly(assembly, library);
    useAppStore.getState().openStandardPartPicker();
    const values = (nodes: Element[]) => elements(one(nodes, item => item.type === 'table').props.children as ReactNode)
      .filter(item => item.type === 'td').map(item => item.props.children);
    const before = values(structuralPanel());
    expect(before).toEqual(['SS400', product.size, 1000, 1000, 1, 1000, 'jp-steel-2026-10-10-r1', '3-steel-profile-1', 1, 1000]);
    useAppStore.setState({ assemblyLibrary: { ...library, parts: new Map([['steel', { ...part, solids: [] }]]) } });
    const nodes = render();
    expect(values(nodes)).toEqual(['SS400', product.size, 1000, t('assembly.steel.finishedUnknown'), 1, 1000, 'jp-steel-2026-10-10-r1', '3-steel-profile-1', 1, 1000]);
    const save = vi.fn<(name: string, kind: string, bytes: Uint8Array) => Promise<boolean>>(() => Promise.resolve(true));
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs: save } });
    const button = one(render(), item => item.type === 'button' && item.props.title === t('assembly.steel.csv.exportGuide'));
    (button.props.onClick as () => void)();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(save.mock.calls[0][2])).toContain(t('assembly.steel.finishedUnknown'));
    useAppStore.setState({ assemblyLibrary: library });
    expect(values(render())).toEqual(before);
  });
});

describe('actual picker bend callbacks and keyboard boundary', () => {
  function enableBend(): Element[] {
    const nodes = structuralPanel();
    const checkbox = one(nodes, item => item.type === 'input' && item.props.title === t('assembly.steel.bend.enableGuide'));
    (checkbox.props.onChange as (event: { currentTarget: { checked: boolean } }) => void)({ currentTarget: { checked: true } });
    return render();
  }
  it('submits a real editable bend to ready placement rather than a straight source', () => {
    const nodes = enableBend();
    const form = one(nodes, item => item.type === 'form');
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    const placement = useAppStore.getState().assemblyPlacement;
    if (placement?.kind !== 'ready') throw new Error('No actual bent-part placement callback');
    expect(placement.document.solids[0].kind).toBe('sweep');
    expect(placement.document.steelStockSource?.catalog).toBe('flatBar');
    expect(Number(placement.document.steelStockSource?.options.length)).toBeCloseTo(400 + 125 * Math.PI / 2, 12);
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
  });
  it('retains IME Enter without submitting and Escape cancellation without mutation', () => {
    const nodes = enableBend();
    const form = one(nodes, item => item.type === 'form');
    const key = form.props.onKeyDown as (event: { key: string; nativeEvent: { isComposing: boolean };
      preventDefault: () => void; stopPropagation: () => void }) => void;
    const before = useAppStore.getState();
    const preventDefault = vi.fn();
    key({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault, stopPropagation: vi.fn() });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(before);
    key({ key: 'Escape', nativeEvent: { isComposing: true }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(useAppStore.getState().standardPartPickerOpen).toBe(true);
    key({ key: 'Escape', nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });
  it('updates expression controls and shows an invalid geometry reason without a callback commit', () => {
    const nodes = enableBend();
    const child = one(nodes, item => item.type === SteelBendFields);
    const sources = child.props.sources as SteelBendSources;
    const update = child.props.onChange as (sources: SteelBendSources) => void;
    const fields = elements(SteelBendFields({ sources, result: null, onChange: update }));
    const angleLabel = one(fields, item => item.type === 'label'
      && elements(item.props.children as ReactNode).some(span => span.props.children === t('assembly.steel.bend.angle')));
    const input = one(elements(angleLabel.props.children as ReactNode), item => item.type === 'input');
    (input.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '90*2' } });
    const invalidNodes = render();
    const invalidChild = one(invalidNodes, item => item.type === SteelBendFields);
    expect(invalidChild.props.sources).toMatchObject({ angleDegrees: '90*2' });
    const invalidResult = invalidChild.props.result as Parameters<typeof SteelBendFields>[0]['result'];
    expect(invalidResult).toEqual({ ok: false, reason: 'invalidAngle' });
    const invalidFields = elements(SteelBendFields({ sources: invalidChild.props.sources as SteelBendSources,
      result: invalidResult, onChange: update }));
    expect(one(invalidFields, item => item.props.role === 'alert').props.children).toBe(t('assembly.steel.bend.invalidAngle'));
    const before = useAppStore.getState();
    const form = one(invalidNodes, item => item.type === 'form');
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect(useAppStore.getState()).toBe(before);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });
  it('exposes the direction expression and passes it through the existing picker change callback', () => {
    const nodes = enableBend();
    const child = one(nodes, item => item.type === SteelBendFields);
    const sources = child.props.sources as SteelBendSources;
    const update = child.props.onChange as (sources: SteelBendSources) => void;
    const fields = elements(SteelBendFields({ sources, result: null, onChange: update }));
    const label = one(fields, item => item.type === 'label'
      && elements(item.props.children as ReactNode).some(span => span.props.children === t('assembly.steel.bend.direction')));
    const input = one(elements(label.props.children as ReactNode), item => item.type === 'input');
    expect(input.props.value).toBe('0');
    (input.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '45*2' } });
    const next = one(render(), item => item.type === SteelBendFields);
    expect(next.props.sources).toMatchObject({ directionDegrees: '45*2' });
    const result = next.props.result as Parameters<typeof SteelBendFields>[0]['result'];
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) throw new Error('Direction callback did not build a bend');
    expect(result.document.references).toMatchObject([{ plane: { kind: 'tilted', angle: { value: 90 } } }]);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });
  it('maps the public inside/outside radius and leg selects through the picker callback; outside R = inside R + width is the same bend', () => {
    const nodes = enableBend();
    const child = one(nodes, item => item.type === SteelBendFields);
    const sources = child.props.sources as SteelBendSources;
    const inside = child.props.result as Parameters<typeof SteelBendFields>[0]['result'];
    if (inside?.ok !== true) throw new Error('Default bend did not build');
    expect(sources.radiusConvention).toBe('inside');
    const update = child.props.onChange as (sources: SteelBendSources) => void;
    const fields = elements(SteelBendFields({ sources, result: inside, onChange: update }));
    const radiusSelect = select(fields, 'assembly.steel.bend.radiusConvention');
    expect(optionValues(radiusSelect)).toEqual(['inside', 'outside']);
    expect(optionValues(select(fields, 'assembly.steel.bend.legConvention'))).toEqual(['tangent', 'inside', 'outside']);
    // An unknown option value is ignored rather than coerced.
    expect(one(change(radiusSelect, 'centre'), item => item.type === SteelBendFields).props.sources).toEqual(sources);
    // Outside convention with the outside radius of the default bend describes the same geometry.
    const outsideChild = one(change(radiusSelect, 'outside'), item => item.type === SteelBendFields);
    const outsideSources = outsideChild.props.sources as SteelBendSources;
    expect(outsideSources).toEqual({ ...sources, radiusConvention: 'outside' });
    const radiusLabel = one(elements(SteelBendFields({ sources: outsideSources, result: null, onChange: update })), item => item.type === 'label'
      && elements(item.props.children as ReactNode).some(span => span.props.children === t('assembly.steel.bend.radius')));
    const radiusInput = one(elements(radiusLabel.props.children as ReactNode), item => item.type === 'input');
    (radiusInput.props.onChange as (event: { currentTarget: { value: string } }) => void)(
      { currentTarget: { value: String(inside.geometry.outsideRadiusMm) } });
    const outside = one(render(), item => item.type === SteelBendFields).props.result as Parameters<typeof SteelBendFields>[0]['result'];
    if (outside?.ok !== true) throw new Error('Outside-radius bend did not build');
    expect(outside.geometry.insideRadiusMm).toBe(inside.geometry.insideRadiusMm);
    expect(outside.geometry.outsideRadiusMm).toBe(inside.geometry.outsideRadiusMm);
    expect(outside.geometry.centrelineLengthMm).toBeCloseTo(inside.geometry.centrelineLengthMm, 12);
    // The leg select reaches the picker sources unchanged.
    const legSelect = select(elements(SteelBendFields({ sources, result: inside, onChange: update })), 'assembly.steel.bend.legConvention');
    const legChild = one(change(legSelect, 'inside'), item => item.type === SteelBendFields);
    expect(legChild.props.sources).toEqual({ ...sources, legDimension: 'inside' });
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });
});


interface PickerFormHandlers {
  readonly onKeyDown: (event: { readonly key: string;
    readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
    readonly preventDefault: () => void; readonly stopPropagation: () => void }) => void;
  readonly onSubmit: (event: { readonly preventDefault: () => void }) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: () => void;
  readonly onPointerDownCapture: () => void;
}
function imeForm(bending: boolean): PickerFormHandlers {
  let nodes = structuralPanel();
  if (bending) {
    const checkbox = one(nodes, item => item.type === 'input' && item.props.title === t('assembly.steel.bend.enableGuide'));
    (checkbox.props.onChange as (event: { currentTarget: { checked: boolean } }) => void)({ currentTarget: { checked: true } });
    nodes = render();
  }
  const form = one(nodes, item => item.type === 'form');
  return {
    onKeyDown: form.props.onKeyDown as PickerFormHandlers['onKeyDown'],
    onSubmit: form.props.onSubmit as PickerFormHandlers['onSubmit'],
    onCompositionStart: form.props.onCompositionStart as PickerFormHandlers['onCompositionStart'],
    onCompositionEnd: form.props.onCompositionEnd as PickerFormHandlers['onCompositionEnd'],
    onPointerDownCapture: form.props.onPointerDownCapture as PickerFormHandlers['onPointerDownCapture'],
  };
}
function imeKey(form: PickerFormHandlers, key: string, keyCode = 0, isComposing = false) {
  const preventDefault = vi.fn(), stopPropagation = vi.fn();
  form.onKeyDown({ key, nativeEvent: { key, keyCode, isComposing }, preventDefault, stopPropagation });
  return { preventDefault, stopPropagation };
}
describe.each([false, true])('actual picker IME guard, bending=%s', bending => {
  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false],
    ['Escape', 229, false], ['Process', 0, false],
  ] as const)('preserves input defaults and refuses submit/cancel for %s/%i/%s', (key, code, composing) => {
    const form = imeForm(bending), before = useAppStore.getState();
    const event = imeKey(form, key, code, composing);
    const submitDefault = vi.fn();
    form.onSubmit({ preventDefault: submitDefault });
    expect(submitDefault).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(before);
  });
  it.each(['pointer', 'Enter'] as const)('blocks compositionend implicit submit, then explicit %s places exactly once', activation => {
    const form = imeForm(bending), before = useAppStore.getState();
    let placements = 0;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (bending ? state.assemblyPlacement !== previous.assemblyPlacement && state.assemblyPlacement?.kind === 'ready'
        : state.assembly !== previous.assembly) placements++;
    });
    try {
      form.onCompositionStart();
      const event = imeKey(form, 'Enter', 13, false);
      form.onCompositionEnd();
      form.onSubmit({ preventDefault: vi.fn() });
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(useAppStore.getState()).toBe(before);
      expect(placements).toBe(0);
      if (activation === 'pointer') form.onPointerDownCapture();
      else imeKey(form, 'Enter', 13);
      form.onSubmit({ preventDefault: vi.fn() });
      expect(placements).toBe(1);
      if (bending) {
        const placement = useAppStore.getState().assemblyPlacement;
        if (placement?.kind !== 'ready') throw new Error('Missing actual bend placement');
        expect(placement.document.solids[0].kind).toBe('sweep');
        expect(useAppStore.getState().assembly).toBe(before.assembly);
      } else expect(useAppStore.getState().assembly?.components).toHaveLength(1);
    } finally { unsubscribe(); }
  });
  it('keeps composing Escape open and normal Escape cancels without document/history changes', () => {
    const form = imeForm(bending), before = useAppStore.getState();
    form.onCompositionStart();
    expect(imeKey(form, 'Escape', 27).preventDefault).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(before);
    form.onCompositionEnd();
    const event = imeKey(form, 'Escape', 27);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(useAppStore.getState().assemblyPlacement).toBeNull();
  });
});

const REEDIT_SOURCES: SteelBendSources = { radius: '(30) + 0', angleDegrees: '(90) + 0',
  directionDegrees: '(0) + 0', firstLeg: '(100) + 0', secondLeg: '(200) + 0',
  radiusConvention: 'inside', legDimension: 'tangent' };

function renderEditor(target: SteelBendEditTarget, onClose: () => void): Element[] {
  hooks.state = 0;
  let tree: ReactNode = null;
  function Probe(): null { tree = SteelBendEditForm({ target, onClose }); return null; }
  renderToStaticMarkup(<Probe />);
  const nodes = elements(tree);
  const fields = nodes.find(node => node.type === SteelBendFields);
  // Run the real shared controls, including their actual onChange handlers.
  return fields === undefined ? nodes : [...nodes,
    ...elements(SteelBendFields(fields.props as Parameters<typeof SteelBendFields>[0]))];
}

async function savedEditor(sources = REEDIT_SOURCES, transform: (part: PartDocument) => PartDocument = part => part) {
  const row = STEEL_PRODUCTS.find(product => product.key === 'SS400:flatBar:FB 50×6');
  if (row === undefined) throw new Error('Missing W03 fixture row');
  const built = buildSteelBendChoice(row, sources);
  if (!built.ok) throw new Error(built.reason);
  const reopened = readPcadFile(writePcadFile(built.document));
  if (!reopened.ok) throw new Error('Saved bend did not reopen');
  expect(beginSteelBendPlacement({ ...built, document: transform(reopened.document) })).toBe(true);
  await commitPlaceComponent();
  useAppStore.getState().openStandardPartPicker();
  const before = useAppStore.getState();
  let nodes = render();
  const entry = one(nodes, node => node.type === 'button' && node.props.title === t('assembly.steel.bend.reedit.entryGuide'));
  (entry.props.onClick as () => void)();
  nodes = render();
  const editor = one(nodes, node => node.type === SteelBendEditForm);
  const target = editor.props.target as SteelBendEditTarget;
  const onClose = vi.fn(editor.props.onClose as () => void);
  hooks.values = []; hooks.state = 0;
  expect(useAppStore.getState()).toBe(before);
  return { target, before, onClose, render: () => renderEditor(target, onClose) };
}

function editorInput(nodes: Element[], label: Parameters<typeof t>[0]): Element {
  const field = one(nodes, node => node.type === 'label'
    && elements(node.props.children as ReactNode).some(child => child.type === 'span' && child.props.children === t(label)));
  return one(elements(field.props.children as ReactNode), child => child.type === 'input');
}
function editValue(element: Element, value: string): void {
  (element.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } });
}
function editorForm(nodes: Element[]): PickerFormHandlers {
  const form = one(nodes, node => node.type === 'form');
  return {
    onKeyDown: form.props.onKeyDown as PickerFormHandlers['onKeyDown'],
    onSubmit: form.props.onSubmit as PickerFormHandlers['onSubmit'],
    onCompositionStart: form.props.onCompositionStart as PickerFormHandlers['onCompositionStart'],
    onCompositionEnd: form.props.onCompositionEnd as PickerFormHandlers['onCompositionEnd'],
    onPointerDownCapture: form.props.onPointerDownCapture as PickerFormHandlers['onPointerDownCapture'],
  };
}
function expectEditorUnchanged(before: ReturnType<typeof useAppStore.getState>): void {
  const after = useAppStore.getState();
  expect(after.assembly).toBe(before.assembly);
  expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
  expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
}

describe('W04 actual selected bend entry and exact saved controls', () => {
  // Same 12 FB 50x6 convention fixtures as W03 steelBendRoundtrip.test.ts,
  // with W03's authored-expression wrapper to detect accidental number/default replacement.
  const cases = (['inside', 'outside'] as const).flatMap(radiusConvention =>
    (['tangent', 'inside', 'outside'] as const).flatMap(legDimension => [0, 90].map(direction =>
      ({ radiusConvention, legDimension, direction }))));
  it.each(cases)('$radiusConvention R / $legDimension legs / $direction restores every original source string', async test => {
    const width = test.direction === 0 ? 50 : 6;
    const setback = test.legDimension === 'tangent' ? 0 : test.legDimension === 'inside' ? 30 : 30 + width;
    const sources: SteelBendSources = { radiusConvention: test.radiusConvention, legDimension: test.legDimension,
      radius: `(${test.radiusConvention === 'inside' ? 30 : 30 + width}) + 0`, angleDegrees: '(90) + 0',
      directionDegrees: `(${test.direction}) + 0`, firstLeg: `(${100 + setback}) + 0`, secondLeg: `(${200 + setback}) + 0` };
    const editor = await savedEditor(sources), nodes = editor.render();
    expect(editorInput(nodes, 'assembly.steel.bend.radius').props.value).toBe(sources.radius);
    expect(editorInput(nodes, 'assembly.steel.bend.angle').props.value).toBe(sources.angleDegrees);
    expect(editorInput(nodes, 'assembly.steel.bend.direction').props.value).toBe(sources.directionDegrees);
    expect(editorInput(nodes, 'assembly.steel.bend.firstLeg').props.value).toBe(sources.firstLeg);
    expect(editorInput(nodes, 'assembly.steel.bend.secondLeg').props.value).toBe(sources.secondLeg);
    expect(select(nodes, 'assembly.steel.bend.radiusConvention').props.value).toBe(sources.radiusConvention);
    expect(select(nodes, 'assembly.steel.bend.legConvention').props.value).toBe(sources.legDimension);
    expect(one(nodes, node => node.type === 'button' && node.props.type === 'submit').props.disabled).toBe(false);
    expectEditorUnchanged(editor.before);
  });

  it('applies actual control changes once; Undo and Redo restore full source, identity and geometry', async () => {
    const editor = await savedEditor();
    editValue(select(editor.render(), 'assembly.steel.bend.radiusConvention'), 'outside');
    editValue(editorInput(editor.render(), 'assembly.steel.bend.radius'), '30 + 50');
    editValue(editorInput(editor.render(), 'assembly.steel.bend.firstLeg'), '125 * 2');
    const nodes = editor.render(), form = editorForm(nodes);
    expectEditorUnchanged(editor.before);
    form.onSubmit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(editor.onClose).toHaveBeenCalledOnce());
    const after = useAppStore.getState(), edited = after.assemblyLibrary.parts.get(editor.target.partRef);
    if (edited === undefined) throw new Error('Missing edited part');
    expect(readSteelBendEditInput(edited)).toMatchObject({ ok: true, sources: { ...REEDIT_SOURCES,
      radiusConvention: 'outside', radius: '30 + 50', firstLeg: '125 * 2' } });
    expect(edited.id).toBe(editor.target.document.id);
    expect(edited.sketches).not.toEqual(editor.target.document.sketches);
    expect(after.assemblyUndoStack?.past.length).toBe((editor.before.assemblyUndoStack?.past.length ?? 0) + 1);
    expect(after.standardPartPickerOpen).toBe(false);
    after.undoAssembly();
    expect(useAppStore.getState().assemblyLibrary).toEqual(editor.before.assemblyLibrary);
    useAppStore.getState().redoAssembly();
    expect(useAppStore.getState().assemblyLibrary).toEqual(after.assemblyLibrary);
  });

  it.each(['button', 'Escape', 'invalid submit'] as const)('%s discards the edited source draft without a document or history change', async mode => {
    const editor = await savedEditor();
    editValue(editorInput(editor.render(), 'assembly.steel.bend.radius'), mode === 'invalid submit' ? 'unfinished(' : '31');
    const nodes = editor.render();
    if (mode === 'button') {
      const cancel = one(nodes, node => node.type === 'button' && node.props.title === t('assembly.steel.bend.reedit.cancelGuide'));
      (cancel.props.onClick as () => void)();
    } else if (mode === 'Escape') imeKey(editorForm(nodes), 'Escape', 27);
    else {
      expect(one(nodes, node => node.props.role === 'alert').props.children).toBe(t('assembly.steel.bend.invalidExpression'));
      expect(one(nodes, node => node.type === 'button' && node.props.type === 'submit').props.disabled).toBe(true);
      editorForm(nodes).onSubmit({ preventDefault: vi.fn() });
    }
    expect(editor.onClose).toHaveBeenCalledTimes(mode === 'invalid submit' ? 0 : 1);
    expectEditorUnchanged(editor.before);
  });

  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false],
    ['Escape', 229, false], ['Process', 0, false],
  ] as const)('IME %s/%i/%s leaves the uncommitted expression and history unchanged', async (key, code, composing) => {
    const editor = await savedEditor();
    editValue(editorInput(editor.render(), 'assembly.steel.bend.radius'), '30 + 1');
    const form = editorForm(editor.render()), event = imeKey(form, key, code, composing);
    form.onSubmit({ preventDefault: vi.fn() });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(editor.onClose).not.toHaveBeenCalled();
    expectEditorUnchanged(editor.before);
    expect(editorInput(editor.render(), 'assembly.steel.bend.radius').props.value).toBe('30 + 1');
  });

  it.each(['pointer', 'Enter'] as const)('IME confirmation does not submit; the following explicit %s commits once', async activation => {
    const editor = await savedEditor(), form = editorForm(editor.render());
    form.onCompositionStart();
    imeKey(form, 'Enter', 13);
    form.onCompositionEnd();
    form.onSubmit({ preventDefault: vi.fn() });
    expectEditorUnchanged(editor.before);
    expect(editor.onClose).not.toHaveBeenCalled();
    if (activation === 'pointer') form.onPointerDownCapture();
    else imeKey(form, 'Enter', 13);
    form.onSubmit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(editor.onClose).toHaveBeenCalledOnce());
    expect(useAppStore.getState().assemblyUndoStack?.past.length).toBe((editor.before.assemblyUndoStack?.past.length ?? 0) + 1);
  });
});

describe('W04 unavailable saved recipes show their reason and never open default editable inputs', () => {
  it.each([
    { variant: 'missing', reason: 'missing' }, { variant: 'modified shape', reason: 'modified' },
    { variant: 'unknown bend revision', reason: 'unsupported' }, { variant: 'unknown stock revision', reason: 'unsupported' },
    { variant: 'unknown row', reason: 'unsupported' }, { variant: 'duplicate ID', reason: 'modified' },
  ] as const)('$variant disables Apply and shows $reason in the selected bend entry', async test => {
    const editor = await savedEditor(REEDIT_SOURCES, part => {
      const owner = part.solids[0];
      if (owner.kind !== 'sweep' || owner.steelBend === undefined) throw new Error('Missing fixture input');
      const input = owner.steelBend;
      if (test.variant === 'missing') {
        const legacy = { ...owner }; delete legacy.steelBend;
        return { ...part, solids: [legacy] };
      }
      if (test.variant === 'modified shape') return { ...part, solids: [{ ...owner, suppressed: true }] };
      if (test.variant === 'duplicate ID') return { ...part, solids: [owner, { ...owner }] };
      const steelBend = test.variant === 'unknown bend revision' ? { ...input, generatorRevision: 'steel-bend-future' }
        : test.variant === 'unknown stock revision' ? { ...input, stockSource: { ...input.stockSource, generatorRevision: 'stock-future' } }
          : { ...input, productKey: 'unknown-row', stockSource: { ...input.stockSource,
            options: { ...input.stockSource.options, steelProduct: 'unknown-row' } } };
      return { ...part, solids: [{ ...owner, steelBend }] };
    });
    const nodes = editor.render(), key = `assembly.steel.bend.reedit.${test.reason}` as const;
    expect(nodes.filter(node => node.type === 'input' || node.type === 'select')).toEqual([]);
    expect(one(nodes, node => node.props.role === 'alert').props.children).toBe(t(key));
    expect(t(key)).not.toBe(key);
    expect(one(nodes, node => node.type === 'button' && node.props.type === 'submit').props.disabled).toBe(true);
    editorForm(nodes).onSubmit({ preventDefault: vi.fn() });
    expect(await commitSteelBendEdit(editor.target, REEDIT_SOURCES)).toEqual({ ok: false, reason: test.reason });
    expect(editor.onClose).not.toHaveBeenCalled();
    expectEditorUnchanged(editor.before);
  });
});

describe('W11 rejected steel selections and Escape preserve past and future history', () => {
  function retainedHistoryPicker(): Element[] {
    submit(structuralPanel());
    const placed = useAppStore.getState().assembly;
    if (placed === null) throw new Error('Expected seeded steel assembly');
    useAppStore.getState().applyAssembly({ ...placed, name: 'W11 retained past' });
    useAppStore.getState().applyAssembly({ ...placed, name: 'W11 retained future' });
    useAppStore.getState().undo();
    expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(2);
    expect(useAppStore.getState().assemblyUndoStack?.future).toHaveLength(1);
    return structuralPanel();
  }
  function snapshotHistory() {
    const state = useAppStore.getState();
    const stack = state.assemblyUndoStack;
    if (stack === null) throw new Error('Expected retained assembly history');
    return { state, documentBytes: new TextEncoder().encode(JSON.stringify(state.assembly)),
      historyBytes: new TextEncoder().encode(JSON.stringify(stack)),
      past: stack.past.length, future: stack.future.length };
  }
  function expectHistoryUnchanged(before: ReturnType<typeof snapshotHistory>): void {
    const state = useAppStore.getState();
    expect(state.assembly).toBe(before.state.assembly);
    expect(new TextEncoder().encode(JSON.stringify(state.assembly))).toEqual(before.documentBytes);
    expect(state.assemblyLibrary).toBe(before.state.assemblyLibrary);
    expect(state.assemblyUndoStack).toBe(before.state.assemblyUndoStack);
    expect(new TextEncoder().encode(JSON.stringify(state.assemblyUndoStack))).toEqual(before.historyBytes);
    expect(state.assemblyUndoStack?.past).toHaveLength(before.past);
    expect(state.assemblyUndoStack?.future).toHaveLength(before.future);
    expect(state.canUndo).toBe(before.state.canUndo);
    expect(state.canRedo).toBe(before.state.canRedo);
    expect(state.documentVersion).toBe(before.state.documentVersion);
  }

  it.each(['0', '12001', 'not-a-number', '1/0', '', ' '])('actual submit rejects length %j without a history step', length => {
    let nodes = retainedHistoryPicker();
    const before = snapshotHistory();
    nodes = change(one(nodes, node => node.type === 'input'
      && node.props.title === t('assembly.guide.standardLength')), length);
    const form = one(nodes, node => node.type === 'form');
    const preventDefault = vi.fn();
    (form.props.onSubmit as PickerFormHandlers['onSubmit'])({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    nodes = render();
    expect(one(nodes, node => node.props.role === 'alert').props.children).toBe(t('assembly.steel.invalidLength'));
    expect(one(nodes, node => node.type === 'input'
      && node.props.title === t('assembly.guide.standardLength')).props['aria-invalid']).toBe(true);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(true);
    expectHistoryUnchanged(before);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.name).toBe('W11 retained future');
  });

  it.each([
    { field: 'assembly.guide.standardSize', value: 'steel:SS400:flatBar:FB missing' },
    { field: 'assembly.steel.selectWidthGuide', value: 'steel:SS400:flatBar:FB missing' },
    { field: 'assembly.guide.standardSize', value: 'steel:S45C:equalAngle:L 40×40×5' },
    { field: 'assembly.guide.standardSize', value: 'steel:SGP:hBeam:H 150×150×7×10' },
  ] as const)('actual $field handler refuses $value without changing document/history', test => {
    let nodes = retainedHistoryPicker();
    const before = snapshotHistory();
    const previousChoice = select(nodes, 'assembly.guide.standardSize').props.value;
    nodes = change(select(nodes, test.field), test.value);
    expect(select(nodes, 'assembly.guide.standardSize').props.value).toBe(previousChoice);
    expectHistoryUnchanged(before);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.name).toBe('W11 retained future');
  });

  it.each([
    'steel:SGP:steelPipe:20A', 'steel:SGP:steelPipe:20A:whitePipe-zincCoated',
  ])('Escape cancels the unconfirmed %s draft without consuming or clearing history', choice => {
    let nodes = retainedHistoryPicker();
    const before = snapshotHistory();
    nodes = change(select(nodes, 'assembly.steel.materialGuide'), 'SGP');
    nodes = change(select(nodes, 'assembly.guide.standardSize'), choice);
    expect(select(nodes, 'assembly.guide.standardSize').props.value).toBe(choice);
    nodes = change(one(nodes, node => node.type === 'input'
      && node.props.title === t('assembly.guide.standardLength')), '777 + 1');
    expectHistoryUnchanged(before);
    const form = one(nodes, node => node.type === 'form');
    const preventDefault = vi.fn(), stopPropagation = vi.fn();
    (form.props.onKeyDown as PickerFormHandlers['onKeyDown'])({ key: 'Escape',
      nativeEvent: { key: 'Escape', keyCode: 27, isComposing: false }, preventDefault, stopPropagation });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
    expect(render()).toEqual([]);
    expectHistoryUnchanged(before);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly?.name).toBe('W11 retained future');
  });
});
