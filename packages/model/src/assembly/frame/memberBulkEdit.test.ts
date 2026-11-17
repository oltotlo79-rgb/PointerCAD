/**
 * 置いた後の部材の一括の書き換え(J-01 包み 8)の純関数の検査: 同じ族の族の部品(または同じ鋼材の製品)の時だけ、行と長さ
 * (鋼材は長さだけ)を替えた次の保存の形を部品ごとに作り、留めなどほかの欄は残し、作れない時は理由を返す事。
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { T_SLOT_FRAME_SERIES_FAMILY } from '../catalog/families/tSlotFrameSeries.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { createStandardPartSource } from '../standard/buildStandardPart.js';
import { ALL_STEEL_PRODUCTS, steelProductOptions } from '../standard/steelCatalog.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, MateTarget } from '../types.js';
import { planMemberBulkEdit } from './memberBulkEdit.js';

const FAMILY = T_SLOT_FRAME_SERIES_FAMILY;
const ROW_20 = FAMILY.rows.find((row) => row.key === 's6-20x20');
const ROW_40 = FAMILY.rows.find((row) => row.key === 's6-20x40');
const FLAT = ALL_STEEL_PRODUCTS.find((row) => row.key === 'SS400:flatBar:FB 50×6');

function component(id: string, source: ComponentSource): AssemblyComponent {
  return { id, name: id, source, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false };
}

function frame(id: string, values: Readonly<Record<string, string>>): AssemblyComponent {
  if (ROW_20 === undefined) throw new Error('row');
  return component(id, createCatalogItemSource(FAMILY, ROW_20, values));
}

function steel(id: string, length: string): AssemblyComponent {
  if (FLAT === undefined) throw new Error('flat bar');
  return component(id, createStandardPartSource(FLAT.catalog, FLAT.size, { ...steelProductOptions(FLAT), length }));
}

const documentOf = (components: readonly AssemblyComponent[]): AssemblyDocument => ({ ...createAssemblyDocument('一括'), components });

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure([FAMILY.id]); });

describe('部材の一括の書き換えの計画', () => {
  it('同じ族の部品の長さと行を替え、留めの欄は残し、指している合致の数を出す', () => {
    const assembly = documentOf([frame('a', { length: '500', startMiter: 'x+' }), frame('b', { length: '300' })]);
    const plan = planMemberBulkEdit(assembly, ['a', 'b'], { itemKey: ROW_40?.key, length: '600' });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.kind).toBe('catalogItem');
    expect(plan.entries.map((entry) => [entry.componentId, entry.nextSource.size, entry.nextSource.options]))
      .toEqual([['a', ROW_40?.size, { family: FAMILY.id, item: 's6-20x40', length: '600', startMiter: 'x+' }],
        ['b', ROW_40?.size, { family: FAMILY.id, item: 's6-20x40', length: '600' }]]);
    expect(plan.referencingCount).toBe(0);
  });

  it('鋼材は同じ製品の部品の長さだけを替え、行を替えようとすると断る', () => {
    const assembly = documentOf([steel('s1', '500'), steel('s2', '700')]);
    const plan = planMemberBulkEdit(assembly, ['s1', 's2'], { length: '650' });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.kind).toBe('steel');
    expect(plan.entries.map((entry) => entry.nextSource.options.length)).toEqual(['650', '650']);
    expect(planMemberBulkEdit(assembly, ['s1'], { itemKey: 'x', length: '650' })).toEqual({ ok: false, reason: 'steelRow' });
  });

  it('作れない時は何も替えずに理由を返す(選んでいない・替える物が無い・種類が混ざる・部材でない・作れない長さ・無い行)', () => {
    const assembly = documentOf([frame('a', { length: '500' }), steel('s1', '500'),
      component('p', { kind: 'part', partRef: 'part' })]);
    expect(planMemberBulkEdit(assembly, [], { length: '1' })).toEqual({ ok: false, reason: 'noSelection' });
    expect(planMemberBulkEdit(assembly, ['a'], {})).toEqual({ ok: false, reason: 'noChange' });
    expect(planMemberBulkEdit(assembly, ['a', 's1'], { length: '600' })).toEqual({ ok: false, reason: 'mixed' });
    expect(planMemberBulkEdit(assembly, ['a', 'p'], { length: '600' })).toEqual({ ok: false, reason: 'notMember' });
    expect(planMemberBulkEdit(assembly, ['a'], { length: '-5' })).toEqual({ ok: false, reason: 'invalidOption' });
    expect(planMemberBulkEdit(assembly, ['a'], { itemKey: 'missing' })).toEqual({ ok: false, reason: 'unknownItem' });
  });

  it('名前が置いた時の「部品名:番号」なら新しい部品名に替え(重ならない連番)、付け直した名前は替えない', () => {
    if (ROW_20 === undefined) throw new Error('row');
    const name = (length: string): string => FAMILY.partName(ROW_20, { length, startMiter: 'none', endMiter: 'none' });
    const named = (id: string, length: string, label: string): AssemblyComponent => ({ ...frame(id, { length }), name: label });
    const assembly = documentOf([named('a', '500', `${name('500')}:1`), named('b', '300', `${name('300')}:1`),
      named('c', '300', '左の柱'), named('d', '600', `${name('600')}:1`)]);
    const plan = planMemberBulkEdit(assembly, ['a', 'b', 'c'], { length: '600' });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.entries.map((entry) => entry.nextName)).toEqual([`${name('600')}:2`, `${name('600')}:3`, '左の柱']);
    // 名前が「部品名:番号」でない(番号の後ろに文字がある)物も替えない。
    const odd = documentOf([named('a', '500', `${name('500')}:1 予備`)]);
    const oddPlan = planMemberBulkEdit(odd, ['a'], { length: '600' });
    expect(oddPlan.ok ? oddPlan.entries.map((entry) => entry.nextName) : null).toEqual([`${name('500')}:1 予備`]);
  });

  it('鋼材も置いた時の名前(材質 呼び 長さ)なら長さを替えた名前にする', () => {
    if (FLAT === undefined) throw new Error('flat bar');
    const assembly = documentOf([{ ...steel('s1', '500'), name: `${FLAT.materialGrade} ${FLAT.size} 長さ500:1` }]);
    const plan = planMemberBulkEdit(assembly, ['s1'], { length: '650' });
    expect(plan.ok ? plan.entries.map((entry) => entry.nextName) : null).toEqual([`${FLAT.materialGrade} ${FLAT.size} 長さ650:1`]);
  });

  it('替える部品を指している合致とジョイントを数える(ほかの部品だけの物は数えない)', () => {
    const base = documentOf([frame('a', { length: '500' }), frame('b', { length: '500' }), frame('c', { length: '500' })]);
    const target = (componentId: string): MateTarget => ({ kind: 'origin', componentId, element: 'xy' });
    const assembly: AssemblyDocument = { ...base, mates: [
      { id: 'm1', name: 'm1', kind: 'coincident', a: target('a'), b: target('c'), flipped: false, suppressed: false },
      { id: 'm2', name: 'm2', kind: 'coincident', a: target('c'), b: target('c'), flipped: false, suppressed: false },
    ] };
    const plan = planMemberBulkEdit(assembly, ['a', 'b'], { length: '600' });
    expect(plan.ok ? plan.referencingCount : null).toBe(1);
  });
});
