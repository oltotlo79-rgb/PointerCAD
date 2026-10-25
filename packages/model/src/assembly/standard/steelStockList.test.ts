import { expressionValueFromNumber } from '@pointercad/expression';
import type { CutFeature, PartDocument } from '../../part/types.js';
import { embedPart, EMPTY_PART_LIBRARY, replacePartDocument } from '../partLibrary.js';
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource } from '../types.js';
import { buildStandardPartFromSource, createStandardPartSource } from './buildStandardPart.js';
import { steelProductOptions, steelProducts } from './steelCatalog.js';
import { buildSteelStockList } from './steelStockList.js';

function source(grade: 'SS400' | 'S45C', length: string) {
  const row = steelProducts(grade, 'roundBar').find((candidate) => candidate.size === 'φ25');
  if (row === undefined) throw new Error('Missing stock fixture');
  return createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length });
}
function component(id: string, input: ComponentSource, extra: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return { id, name: id, source: input, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false, visible: true, suppressed: false, ...extra };
}

describe('occurrence-aware steel stock list', () => {
  it('keeps different supported profiles and dimensions in separate rows at the same grade, revisions and length', () => {
    const selected = (catalog: 'roundBar' | 'flatBar', size: string) => {
      const product = steelProducts('SS400', catalog).find(row => row.size === size);
      if (product === undefined) throw new Error('Missing independent mixed-profile fixture');
      return createStandardPartSource(catalog, size, { ...steelProductOptions(product), length: '1000' });
    };
    const assembly = { ...createAssemblyDocument('Mixed stock profiles'), components: [
      component('round-25-a', selected('roundBar', 'φ25')),
      component('round-19', selected('roundBar', 'φ19')),
      component('flat-50-6', selected('flatBar', 'FB 50×6')),
      component('round-25-b', selected('roundBar', 'φ25')),
    ] };
    const before = structuredClone(assembly);
    const result = buildSteelStockList(assembly);
    expect(result.rows.map(row => [row.product.materialGrade, row.product.catalog, row.product.size,
      row.catalogRevision, row.generatorRevision, row.lengthMm, row.finishedLengthMm, row.quantity, row.totalLengthMm]))
      .toEqual([
        ['SS400', 'roundBar', 'φ25', 'jp-steel-2026-10-10-r1', '3-steel-profile-1', 1000, 1000, 2, 2000],
        ['SS400', 'roundBar', 'φ19', 'jp-steel-2026-10-10-r1', '3-steel-profile-1', 1000, 1000, 1, 1000],
        ['SS400', 'flatBar', 'FB 50×6', 'jp-steel-2026-10-10-r1', '3-steel-profile-1', 1000, 1000, 1, 1000],
      ]);
    expect(result.rows.map(row => row.occurrencePaths)).toEqual([
      [['round-25-a'], ['round-25-b']], [['round-19']], [['flat-50-6']],
    ]);
    expect([result.totalQuantity, result.totalLengthMm]).toEqual([4, 4000]);
    expect(result.issues).toEqual([]);
    expect(assembly).toEqual(before);
  });

  it('groups equal numeric cut lengths, counts hidden parts, excludes suppressed and separates grades', () => {
    const assembly = { ...createAssemblyDocument('組立'), components: [
      component('a', source('SS400', '500*2')),
      component('b', source('SS400', '1000'), { visible: false }),
      component('c', source('SS400', '1000'), { suppressed: true }),
      component('d', source('S45C', '1000')),
      component('e', source('SS400', '500')),
    ] };
    const before = structuredClone(assembly);
    const result = buildSteelStockList(assembly);
    expect(result.rows.map((row) => [row.product.materialGrade, row.lengthMm, row.quantity, row.totalLengthMm]))
      .toEqual([['SS400', 1000, 2, 2000], ['S45C', 1000, 1, 1000], ['SS400', 500, 1, 500]]);
    expect(result.rows[0].componentIds).toEqual(['a', 'b']);
    expect(result.totalQuantity).toBe(4);
    expect(result.totalLengthMm).toBe(3500);
    expect(assembly).toEqual(before);
  });

  it('reports unsupported versions, invalid lengths, unassigned grade and missing subassemblies', () => {
    const valid = source('S45C', '1000');
    const result = buildSteelStockList({ ...createAssemblyDocument('組立'), components: [
      component('unknown', { ...valid, generatorRevision: 'future' }),
      component('bad-length', { ...valid, options: { ...valid.options, length: '0' } }),
      component('old', createStandardPartSource('equalAngle', 'L 50×50×6', { length: '1000' })),
      component('nested', { kind: 'subAssembly', assemblyRef: 'sub-1' }),
      component('bolt', createStandardPartSource('hexBolt', 'M8')),
      component('part', { kind: 'part', partRef: 'part-1' }),
    ] });
    expect(result.rows).toEqual([]);
    expect(result.totalQuantity).toBe(0);
    expect(result.totalLengthMm).toBe(0);
    expect(result.unresolvedComponentIds).toEqual(['unknown', 'bad-length']);
    expect(result.unassignedSectionComponentIds).toEqual(['old']);
    expect(result.subAssemblyComponentIds).toEqual(['nested']);
    expect(result.issues).toEqual([
      { reason: 'unknownSteel', occurrencePath: ['unknown'], occurrenceNames: ['unknown'] },
      { reason: 'unknownSteel', occurrencePath: ['bad-length'], occurrenceNames: ['bad-length'] },
      { reason: 'unassignedMaterial', occurrencePath: ['old'], occurrenceNames: ['old'] },
      { reason: 'missingAssembly', occurrencePath: ['nested'], occurrenceNames: ['nested'], assemblyRef: 'sub-1' },
    ]);
  });

  it('counts every repeated nested placement and keeps exact paths without inferring old grades', () => {
    const inner = { ...createAssemblyDocument('inner'), components: [
      component('cut', source('SS400', '250*2')),
      component('old', createStandardPartSource('channel', 'C 100×50×5×7.5', { length: '500' })),
      component('suppressed', source('SS400', '1000'), { suppressed: true }),
    ] };
    const child = { ...createAssemblyDocument('child'), components: [
      component('bar', source('SS400', '1000')),
      component('inner', { kind: 'subAssembly', assemblyRef: 'inner' }),
    ] };
    const root = { ...createAssemblyDocument('root'), components: [
      component('direct/with/slashes', source('SS400', '1000')),
      component('one', { kind: 'subAssembly', assemblyRef: 'shared' }),
      component('two', { kind: 'subAssembly', assemblyRef: 'shared' }, { visible: false }),
      component('excluded', { kind: 'subAssembly', assemblyRef: 'missing' }, { suppressed: true }),
    ] };
    const library = new Map([['shared', child], ['inner', inner]]);
    const before = structuredClone({ root, library });
    const result = buildSteelStockList(root, library);
    expect(result.rows.map((row) => [row.lengthMm, row.quantity, row.totalLengthMm]))
      .toEqual([[1000, 3, 3000], [500, 2, 1000]]);
    expect(result.rows[0].occurrencePaths).toEqual([['direct/with/slashes'], ['one', 'bar'], ['two', 'bar']]);
    expect(result.rows[1].occurrencePaths).toEqual([['one', 'inner', 'cut'], ['two', 'inner', 'cut']]);
    expect(result.totalQuantity).toBe(5);
    expect(result.totalLengthMm).toBe(4000);
    expect(result.subAssemblyComponentIds).toEqual([]);
    expect(result.issues).toEqual([
      { reason: 'unassignedMaterial', occurrencePath: ['one', 'inner', 'old'], occurrenceNames: ['one', 'inner', 'old'] },
      { reason: 'unassignedMaterial', occurrencePath: ['two', 'inner', 'old'], occurrenceNames: ['two', 'inner', 'old'] },
    ]);
    expect({ root, library }).toEqual(before);
  });

  it('reports cycles per occurrence and keeps valid siblings', () => {
    const a = { ...createAssemblyDocument('a'), components: [component('bar', source('SS400', '100')),
      component('b', { kind: 'subAssembly', assemblyRef: 'B' })] };
    const b = { ...createAssemblyDocument('b'), components: [component('bar', source('S45C', '200')),
      component('a-again', { kind: 'subAssembly', assemblyRef: 'A' })] };
    const root = { ...createAssemblyDocument('root'), components: [
      component('first', { kind: 'subAssembly', assemblyRef: 'A' }),
      component('second', { kind: 'subAssembly', assemblyRef: 'A' }),
      component('absent', { kind: 'subAssembly', assemblyRef: 'missing' }),
    ] };
    const result = buildSteelStockList(root, new Map([['A', a], ['B', b]]));
    expect(result.rows.map((row) => [row.product.materialGrade, row.quantity])).toEqual([['SS400', 2], ['S45C', 2]]);
    expect(result.totalLengthMm).toBe(600);
    expect(result.issues).toEqual([
      { reason: 'cycle', occurrencePath: ['first', 'b', 'a-again'], occurrenceNames: ['first', 'b', 'a-again'], assemblyRef: 'A' },
      { reason: 'cycle', occurrencePath: ['second', 'b', 'a-again'], occurrenceNames: ['second', 'b', 'a-again'], assemblyRef: 'A' },
      { reason: 'missingAssembly', occurrencePath: ['absent'], occurrenceNames: ['absent'], assemblyRef: 'missing' },
    ]);
  });

  it('includes eight nested levels and explicitly omits the ninth using the resolver boundary', () => {
    const library = new Map<string, AssemblyDocument>();
    for (let level = 1; level <= 9; level += 1) {
      library.set(String(level), { ...createAssemblyDocument(String(level)), components: [
        component('bar', source('SS400', '100')),
        ...(level === 9 ? [] : [component(`level-${level + 1}`, { kind: 'subAssembly', assemblyRef: String(level + 1) })]),
      ] });
    }
    const root = { ...createAssemblyDocument('root'), components: [
      component('level-1', { kind: 'subAssembly', assemblyRef: '1' }),
    ] };
    const result = buildSteelStockList(root, library);
    expect(result.totalQuantity).toBe(8);
    expect(result.totalLengthMm).toBe(800);
    expect(result.issues).toEqual([{ reason: 'depthLimit',
      occurrencePath: Array.from({ length: 9 }, (_, index) => `level-${index + 1}`),
      occurrenceNames: Array.from({ length: 9 }, (_, index) => `level-${index + 1}`), assemblyRef: '9' }]);
  });
});

describe('explicit steel provenance after part edits', () => {
  it('retains purchased stock across nested repeated edited parts and undo without inferring non-steel', async () => {
    const purchased = source('SS400', '1000');
    const part = buildStandardPartFromSource(purchased);
    if (part === null) throw new Error('Missing generated steel');
    const first = part.solids[0];
    if (first.kind !== 'primitive' || first.shape.kind !== 'cylinder') throw new Error('Expected round stock');
    const edited = { ...part, solids: [{ ...first, shape: { ...first.shape,
      height: { ...first.shape.height, source: '500', value: 500, display: '500' } } }] };
    const child = { ...createAssemblyDocument('child'), components: [
      component('machined', { kind: 'part', partRef: 'steel' }),
      component('non-steel', { kind: 'part', partRef: 'plain' }),
    ] };
    const root = { ...createAssemblyDocument('root'), components: [
      component('left', { kind: 'subAssembly', assemblyRef: 'child' }),
      component('right', { kind: 'subAssembly', assemblyRef: 'child' }),
      component('standard', purchased),
    ] };
    const assemblies = new Map([['child', child]]);
    const before = buildSteelStockList(root, assemblies, new Map([['steel', part]]));
    expect(before.rows.map(row => [row.lengthMm, row.finishedLengthMm, row.quantity])).toEqual([[1000, 1000, 3]]);
    const plain = buildStandardPartFromSource(createStandardPartSource('hexBolt', 'M8'));
    if (plain === null) throw new Error('Missing non-steel fixture');
    const changed = buildSteelStockList(root, assemblies, new Map([['steel', edited], ['plain', plain]]));
    expect(changed.rows.map(row => [row.lengthMm, row.finishedLengthMm, row.quantity])).toEqual([[1000, 500, 2], [1000, 1000, 1]]);
    expect(changed.totalQuantity).toBe(3);
    expect(changed.totalLengthMm).toBe(3000);
    expect(edited.steelStockSource).toEqual(purchased);
    const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'stock.pcad', 'stock.pcad');
    const library = await replacePartDocument(embedded.library, embedded.partRef, edited);
    expect(library.parts.get(embedded.partRef)?.steelStockSource).toEqual(purchased);
    const missingHistory = buildSteelStockList(root, assemblies, new Map([['steel', { ...edited, solids: [] }]]));
    expect(missingHistory.rows[0].finishedLengthMm).toBeNull();
    expect(buildSteelStockList(root, assemblies, new Map([['steel', part]]))).toEqual(before);
  });
});

describe('strict transverse cut finished-length proof', () => {
  function fixture() {
    const purchased = source('SS400', '1000');
    const document = buildStandardPartFromSource(purchased);
    if (document === null) throw new Error('Missing stock');
    const assembly = { ...createAssemblyDocument('root'), components: [component('bar', { kind: 'part', partRef: 'bar' })] };
    const row = (part: PartDocument) => buildSteelStockList(assembly, new Map(), new Map([['bar', part]])).rows[0];
    const cut = (id: string, targetFeatureId: string, z: number, keep: CutFeature['keep']): CutFeature => ({
      id, name: id, kind: 'cut', suppressed: false, targetFeatureId, pairedWith: null,
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(z) }, keep,
    });
    return { document, row, cut, target: document.solids.at(-1)?.id ?? '' };
  }
  it('intersects signed half-spaces in sequence, keeps purchase length and returns original after undo', () => {
    const { document, row, cut, target } = fixture();
    const before = structuredClone(document);
    const first = cut('cut-1', target, 200, 'positive');
    const second = cut('cut-2', first.id, 800, 'negative');
    const edited = { ...document, solids: [...document.solids, first, second] };
    expect([row(edited).lengthMm, row(edited).finishedLengthMm, row(edited).totalLengthMm]).toEqual([1000, 600, 1000]);
    const single = { ...document, solids: [...document.solids, cut('cut-1', target, 250, 'negative')] };
    expect(row(single).finishedLengthMm).toBe(250);
    expect(row(document).finishedLengthMm).toBe(1000);
    expect(document).toEqual(before);
  });
  it.each(['branch', 'both', 'oblique', 'empty', 'unresolved', 'duplicate'] as const)('keeps %s unproved instead of guessing length', cause => {
    const { document, row, cut, target } = fixture();
    let feature = cut('cut-1', target, 500, 'negative');
    if (cause === 'branch') feature = { ...feature, targetFeatureId: 'missing' };
    if (cause === 'both') feature = { ...feature, pairedWith: 'other-cut' };
    if (cause === 'oblique') feature = { ...feature, plane: { kind: 'workPlane', planeId: 'xz', offset: expressionValueFromNumber(500) } };
    if (cause === 'empty') feature = { ...feature, keep: 'positive', plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(1200) } };
    if (cause === 'unresolved') feature = { ...feature, plane: { kind: 'workPlane', planeId: 'xy', offset: { source: 'missing', value: 500, display: '500' } } };
    if (cause === 'duplicate') feature = { ...feature, id: target };
    expect(row({ ...document, solids: [...document.solids, feature] }).finishedLengthMm).toBeNull();
    expect(row({ ...document, solids: [...document.solids, feature] }).lengthMm).toBe(1000);
  });
});
