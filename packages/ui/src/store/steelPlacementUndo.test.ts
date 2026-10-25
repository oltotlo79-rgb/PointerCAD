import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, applyReplacement, changeStandardSize, createAssemblyDocument,
  createComponentFor, createStandardPartSource, DEFAULT_COMPONENT_PLACEMENT,
  type AssemblyComponent, type AssemblyDocument, type StandardPartSource, type SteelSectionCatalog,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

interface SteelCase {
  readonly catalog: SteelSectionCatalog;
  readonly grade: string;
  readonly size: string;
  readonly nextSize: string;
  readonly materialStandard: string;
  readonly productStandard: string;
  readonly condition: string;
  readonly evidence: string;
  readonly suffix?: string;
}

// Fixed saved strings from the catalog's original producer rows and the added white-pipe rows.
// Changing size must retain the same grade, condition and standard, rather than pick a similar row.
const CASES: readonly SteelCase[] = [
  { catalog: 'flatBar', grade: 'SS400', size: 'FB 50×6', nextSize: 'FB 50×9',
    materialStandard: 'JIS G 3101', productStandard: t('assembly.steel.producerFlatDimensions'),
    condition: 'hotRolled-heatTreatmentUnspecified', evidence: 'flat' },
  { catalog: 'roundBar', grade: 'S45C', size: 'φ20', nextSize: 'φ25',
    materialStandard: 'JIS G 4051', productStandard: 'JIS G 3123',
    condition: 'brightBar-heatTreatmentUnspecified', evidence: 'brightRound' },
  { catalog: 'equalAngle', grade: 'SS400', size: 'L 40×40×5', nextSize: 'L 50×50×6',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192',
    condition: 'hotRolled-heatTreatmentUnspecified', evidence: 'osaka' },
  { catalog: 'channel', grade: 'SS400', size: '[ 75×40×5×7', nextSize: '[ 100×50×5×7.5',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192',
    condition: 'hotRolled-heatTreatmentUnspecified', evidence: 'osaka' },
  { catalog: 'hBeam', grade: 'SS400', size: 'H 150×150×7×10', nextSize: 'H 200×200×8×12',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192',
    condition: 'hotRolled-heatTreatmentUnspecified', evidence: 'yamato' },
  { catalog: 'steelPipe', grade: 'SGP', size: '15A', nextSize: '20A',
    materialStandard: 'JIS G 3452', productStandard: 'JIS G 3452',
    condition: 'blackPipe-plainEnds', evidence: 'pipe' },
  { catalog: 'steelPipe', grade: 'SGP', size: '15A', nextSize: '20A',
    materialStandard: 'JIS G 3452', productStandard: 'JIS G 3452',
    condition: 'whitePipe-zincCoated', evidence: 'pipe', suffix: ':whitePipe-zincCoated' },
];
const LENGTH = '(250) * 4';

function key(test: SteelCase, size = test.size): string {
  return `${test.grade}:${test.catalog}:${size}${test.suffix ?? ''}`;
}
function expectedSource(test: SteelCase, size = test.size): StandardPartSource {
  return createStandardPartSource(test.catalog, size, {
    steelProduct: key(test, size), materialGrade: test.grade,
    materialStandard: test.materialStandard, productStandard: test.productStandard,
    condition: test.condition, evidence: test.evidence, length: LENGTH,
  });
}
function document(): AssemblyDocument {
  const value = useAppStore.getState().assembly;
  if (value === null) throw new Error('Expected an active assembly');
  return value;
}
function history() {
  const value = useAppStore.getState().assemblyUndoStack;
  if (value === null) throw new Error('Expected assembly history');
  return value;
}
function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
function lastComponent(): AssemblyComponent {
  const component = document().components.at(-1);
  if (component === undefined) throw new Error('Expected placed steel');
  return component;
}
function place(test: SteelCase): void {
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
  expect(useAppStore.getState().placeStandardPart('structuralSection', `steel:${key(test)}`, LENGTH)).toBe(true);
}
function historyWithRedo(): void {
  const depth = history().past.length;
  useAppStore.getState().applyAssembly({ ...document(), name: 'Retained past' });
  useAppStore.getState().applyAssembly({ ...document(), name: 'Retained future' });
  useAppStore.getState().undo();
  expect(history().past).toHaveLength(depth + 1);
  expect(history().future).toHaveLength(1);
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
}
function snapshot() {
  const state = useAppStore.getState();
  return { state, documentBytes: bytes(state.assembly), historyBytes: bytes(history()),
    past: history().past.length, future: history().future.length };
}
function expectUnchanged(before: ReturnType<typeof snapshot>): void {
  const after = useAppStore.getState();
  expect(after.assembly).toBe(before.state.assembly);
  expect(bytes(after.assembly)).toEqual(before.documentBytes);
  expect(after.assemblyLibrary).toBe(before.state.assemblyLibrary);
  expect(history()).toBe(before.state.assemblyUndoStack);
  expect(bytes(history())).toEqual(before.historyBytes);
  expect(history().past).toHaveLength(before.past);
  expect(history().future).toHaveLength(before.future);
  expect(after.canUndo).toBe(before.state.canUndo);
  expect(after.canRedo).toBe(before.state.canRedo);
  expect(after.documentVersion).toBe(before.state.documentVersion);
}

beforeEach(() => {
  resetTestStore();
  const base = createAssemblyDocument('Steel undo');
  const anchor = createComponentFor(base, createStandardPartSource('hexBolt', 'M8'), { partName: 'Anchor' });
  useAppStore.getState().openAssembly(addComponent(base, { ...anchor,
    placement: { position: [expressionValueFromNumber(11), expressionValueFromNumber(-22),
      expressionValueFromNumber(33)], rotation: [0, 0, 1, 0] } }));
});
afterEach(resetTestStore);

describe('steel placement and size change use exactly one assembly undo step', () => {
  it.each(CASES)('places $grade/$catalog/$condition, undoes once and redoes identical saved bytes', test => {
    const initial = document(), initialBytes = bytes(initial), depth = history().past.length;
    place(test);
    const placed = document(), placedBytes = bytes(placed), component = lastComponent();
    expect(placed.components).toHaveLength(initial.components.length + 1);
    expect(placed.components[0]).toEqual(initial.components[0]);
    expect(component.id).not.toBe(initial.components[0].id);
    expect(component.source).toEqual(expectedSource(test));
    expect(component.placement).toEqual(DEFAULT_COMPONENT_PLACEMENT);
    expect(history().past).toHaveLength(depth + 1);
    expect(history().future).toHaveLength(0);

    useAppStore.getState().undo();
    expect(document().components).toHaveLength(placed.components.length - 1);
    expect(bytes(document())).toEqual(initialBytes);
    expect(history().past).toHaveLength(depth);
    expect(history().future).toHaveLength(1);

    useAppStore.getState().redo();
    expect(bytes(document())).toEqual(placedBytes);
    expect(lastComponent()).toEqual(component);
    expect(lastComponent().source).toEqual(expectedSource(test));
    expect(history().past).toHaveLength(depth + 1);
    expect(history().future).toHaveLength(0);
  });

  it.each(CASES)('changes $grade/$catalog/$condition size and restores the full source in one undo/redo', test => {
    place(test);
    const component = lastComponent();
    const moved = { ...component, placement: { position: [expressionValueFromNumber(17),
      expressionValueFromNumber(-23), expressionValueFromNumber(41)] as const,
      rotation: [0, 0, 1, 0] as const } };
    useAppStore.getState().applyAssembly({ ...document(), components: [document().components[0], moved] });
    const original = document(), originalBytes = bytes(original), depth = history().past.length;
    expect(moved.source).toEqual(expectedSource(test));

    // No mates or subshape references exist here, so no resolved bodies are required by replacement.
    const plan = changeStandardSize(original, moved.id, test.nextSize, { bodies: [] });
    if (plan === null) throw new Error('Expected a same-family size change plan');
    expect(plan.before).toBe(original);
    expect(plan.unmatchedCount).toBe(0);
    expect(bytes(document())).toEqual(originalBytes);
    expect(history().past).toHaveLength(depth);
    useAppStore.getState().applyAssembly(applyReplacement(plan));
    const changedBytes = bytes(document());
    expect(lastComponent()).toEqual({ ...moved, source: expectedSource(test, test.nextSize) });
    expect(document().components[0]).toEqual(original.components[0]);
    expect(history().past).toHaveLength(depth + 1);
    expect(history().future).toHaveLength(0);

    useAppStore.getState().undo();
    expect(bytes(document())).toEqual(originalBytes);
    expect(lastComponent().source).toEqual(expectedSource(test));
    expect(lastComponent().placement).toEqual(moved.placement);
    expect(history().past).toHaveLength(depth);
    expect(history().future).toHaveLength(1);

    useAppStore.getState().redo();
    expect(bytes(document())).toEqual(changedBytes);
    expect(lastComponent()).toEqual({ ...moved, source: expectedSource(test, test.nextSize) });
    expect(history().past).toHaveLength(depth + 1);
    expect(history().future).toHaveLength(0);
  });
});

describe('rejected steel placement and cancelled drafts retain both history directions', () => {
  it.each(['0', '12001', 'not-a-number', '1/0', '', ' '])('rejects length %j without publishing a document', length => {
    historyWithRedo();
    const before = snapshot();
    expect(useAppStore.getState().placeStandardPart('structuralSection', 'steel:SS400:flatBar:FB 50×6', length)).toBe(false);
    expectUnchanged(before);
    useAppStore.getState().redo();
    expect(document().name).toBe('Retained future');
  });

  it.each([
    'steel:SS400:flatBar:FB missing', 'steel:SGP:steelPipe:9999A',
    'steel:S45C:equalAngle:L 40×40×5', 'steel:SGP:hBeam:H 150×150×7×10',
  ])('rejects missing or forbidden choice %s without clearing redo', choice => {
    historyWithRedo();
    const before = snapshot();
    expect(useAppStore.getState().placeStandardPart('structuralSection', choice, '1000')).toBe(false);
    expectUnchanged(before);
    useAppStore.getState().redo();
    expect(document().name).toBe('Retained future');
  });

  it.each(CASES)('rejects an unknown size change for $grade/$catalog/$condition without changing history', test => {
    place(test);
    historyWithRedo();
    const before = snapshot();
    expect(changeStandardSize(document(), lastComponent().id, 'missing-size', { bodies: [] })).toBeNull();
    expectUnchanged(before);
  });
});
