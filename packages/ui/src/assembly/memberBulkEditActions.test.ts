/**
 * 置いた後の部材の一括の書き換え(J-01 包み 8)の流れの検査: 選んだ部材の長さを 1 回で替えて Undo 1 回で戻り、合致が指している時は
 * 差し替えの計算で解いてから選び直し、選び直せない物がある時だけ今の差し替えの予告に出し、作れない時は理由を返す事。
 * 形の計算は検査の中の差し替えの計算(体を返す偽物)で置き換える(カーネルは起動しない)。
 */
import {
  createAssemblyDocument, createCatalogItemSource, DEFAULT_COMPONENT_PLACEMENT, PRODUCT_CATALOG_REGISTRY, type AssemblyComponent,
  type AssemblyDocument, type MateTarget,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subShapeRefOf } from '../solid/subShapeSelection.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitCatalogItemChoice } from './catalogFamilyChoices.js';
import { planeBody } from './filletWeldBodies.testSupport.js';
import { memberBulkMessage, startMemberBulkEdit } from './memberBulkEditActions.js';
import { confirmReplacementPreview } from './replaceActions.js';

const FAMILY_ID = 't-slot-frame-series';

function frame(id: string, length: string): AssemblyComponent {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(FAMILY_ID);
  const row = family?.rows.find((candidate) => candidate.key === 's6-20x20');
  if (family === undefined || row === undefined) throw new Error('family');
  return { id, name: id, source: createCatalogItemSource(family, row, { length }), placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false,
    visible: true, suppressed: false };
}

const lengths = (): readonly (string | undefined)[] => (useAppStore.getState().assembly?.components ?? [])
  .map((component) => (component.source.kind === 'standardPart' ? component.source.options.length : undefined));

function open(document: AssemblyDocument, selection: readonly string[]): void {
  useAppStore.getState().openAssembly(document);
  useAppStore.getState().setSelection(selection);
}

beforeEach(async () => {
  resetTestStore();
  await PRODUCT_CATALOG_REGISTRY.ensure([FAMILY_ID]);
});
afterEach(() => { resetTestStore(); });

describe('部材の一括の書き換え', () => {
  it('合致の無い 2 本の長さを 1 回で替え、Undo 1 回で戻る', async () => {
    open({ ...createAssemblyDocument('一括'), components: [frame('a', '500'), frame('b', '300')] }, ['a', 'b']);
    expect(await startMemberBulkEdit({ length: '600' })).toEqual({ kind: 'applied', count: 2 });
    expect(lengths()).toEqual(['600', '600']);
    expect(useAppStore.getState().selection).toEqual(['a', 'b']);
    useAppStore.getState().undoAssembly();
    expect(lengths()).toEqual(['500', '300']);
  });

  it('置いた時の名前は替えた長さの名前になり(合致の無い道・合致を選び直す道の両方)、Undo で戻る', async () => {
    const placedName = (length: string): string => {
      const committed = commitCatalogItemChoice(FAMILY_ID, 's6-20x20', { length });
      if (!committed.ok) throw new Error(committed.reason);
      return committed.value.name;
    };
    const named = (id: string, length: string): AssemblyComponent => ({ ...frame(id, length), name: `${placedName(length)}:1` });
    const names = (): readonly string[] => (useAppStore.getState().assembly?.components ?? []).map((component) => component.name);
    open({ ...createAssemblyDocument('一括'), components: [named('a', '500'), named('b', '300')] }, ['a', 'b']);
    expect(await startMemberBulkEdit({ length: '600' })).toEqual({ kind: 'applied', count: 2 });
    expect(names()).toEqual([`${placedName('600')}:1`, `${placedName('600')}:2`]);
    useAppStore.getState().undoAssembly();
    expect(names()).toEqual([`${placedName('500')}:1`, `${placedName('300')}:1`]);
    const origin = (componentId: string): MateTarget => ({ kind: 'origin', componentId, element: 'xy' });
    open({ ...createAssemblyDocument('一括'), components: [named('a', '500'), frame('b', '500')],
      mates: [{ id: 'mate-1', name: '一致', kind: 'coincident', a: origin('a'), b: origin('b'), flipped: false, suppressed: false }] }, ['a']);
    useAppStore.setState({ assemblyReplacementRunner: { resolve: vi.fn(() => Promise.resolve([])) } });
    expect(await startMemberBulkEdit({ length: '700' })).toEqual({ kind: 'applied', count: 1 });
    expect(names()).toEqual([`${placedName('700')}:1`, 'b']);
  });

  it('作れない時は何も替えずに理由を返し、結果の文字を出す', async () => {
    open({ ...createAssemblyDocument('一括'), components: [frame('a', '500')] }, []);
    const refused = await startMemberBulkEdit({ length: '600' });
    expect(refused).toEqual({ kind: 'refused', reason: 'noSelection' });
    expect(memberBulkMessage(refused).role).toBe('alert');
    expect(memberBulkMessage({ kind: 'applied', count: 2 }).text).toContain('2');
    expect(lengths()).toEqual(['500']);
  });

  it('合致が原点を指す時は差し替えの計算で解いてから選び直し、全部選び直せればそのまま替える', async () => {
    const resolve = vi.fn(() => Promise.resolve([]));
    const origin = (componentId: string): MateTarget => ({ kind: 'origin', componentId, element: 'xy' });
    open({ ...createAssemblyDocument('一括'), components: [frame('a', '500'), frame('b', '500')],
      mates: [{ id: 'mate-1', name: '一致', kind: 'coincident', a: origin('a'), b: origin('b'), flipped: false, suppressed: false }] }, ['a']);
    useAppStore.setState({ assemblyReplacementRunner: { resolve } });
    expect(await startMemberBulkEdit({ length: '700' })).toEqual({ kind: 'applied', count: 1 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(lengths()).toEqual(['700', '500']);
    expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
  });

  it('選び直せない合致がある時は今の差し替えの予告に出し、確かめると 1 回で替わる', async () => {
    const body = planeBody([[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]], [0, 0, 1]);
    const ref = subShapeRefOf([body], `${body.featureId}#face:0`);
    if (ref === null) throw new Error('ref');
    const face: MateTarget = { kind: 'subShape', componentId: 'a', ref };
    const other: MateTarget = { kind: 'origin', componentId: 'b', element: 'xy' };
    open({ ...createAssemblyDocument('一括'), components: [frame('a', '500'), frame('b', '500')],
      mates: [{ id: 'mate-1', name: '一致', kind: 'coincident', a: face, b: other, flipped: false, suppressed: false }] }, ['a', 'b']);
    useAppStore.setState({ assemblyReplacementRunner: { resolve: () => Promise.resolve([]) } });
    expect(await startMemberBulkEdit({ length: '800' })).toEqual({ kind: 'preview', count: 2 });
    expect(useAppStore.getState().assemblyReplacementPreview?.prepared.plan.unmatchedCount).toBe(1);
    expect(lengths()).toEqual(['500', '500']);
    confirmReplacementPreview();
    expect(lengths()).toEqual(['800', '800']);
  });
});
