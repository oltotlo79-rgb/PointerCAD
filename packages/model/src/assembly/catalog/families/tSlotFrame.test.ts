/**
 * E-03 汎用の T スロットフレーム(寸法を指定して作る): 規格の行を名乗らない事、欄、断面の面積(式と輪の両方)、形が成り立つ条件、
 * 形と体積、保存の形、長さを持つ族として切断の一覧に出る事の検査。表を持たない族なので、照合の fixture は無い。
 */
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../../createAssemblyDocument.js';
import { buildSteelStockList } from '../../standard/steelStockList.js';
import type { AssemblyComponent } from '../../types.js';
import { tSlotProfile, type TSlotDimensions } from '../profiles/tSlot.js';
import { createCatalogRegistry } from '../registry.js';
import { createCatalogItemSource } from '../source.js';
import { T_SLOT_FRAME_FAMILY } from './tSlotFrame.js';

const DEFAULTS = { width: '40', slotOpening: '8', shoulder: '4', slotInnerWidth: '18', slotDepth: '7', centerHole: '8',
  cornerRadius: '2', length: '1000' };
const ROW = T_SLOT_FRAME_FAMILY.rows[0];

/** 設計の式の面積(mm²): A² − (4 − π)R² − 4[w·s + (wi − d)·d] − π h²/4。 */
function formulaArea(dims: TSlotDimensions): number {
  const { width: a, slotOpening: w, shoulder: s, slotInnerWidth: wi, slotDepth: d, centerHole: h, cornerRadius: r } = dims;
  return a ** 2 - (4 - Math.PI) * r ** 2 - 4 * (w * s + (wi - d) * d) - Math.PI * h ** 2 / 4;
}

const dimsOf = (values: Readonly<Record<string, string>>): TSlotDimensions => ({
  width: Number(values.width), height: Number(values.width), slotPitch: Number(values.width), slotOpening: Number(values.slotOpening),
  shoulder: Number(values.shoulder), slotInnerWidth: Number(values.slotInnerWidth), slotDepth: Number(values.slotDepth),
  centerHole: Number(values.centerHole), cornerRadius: Number(values.cornerRadius), cornerHoleDiameter: 0, cornerHoleInset: 0,
});

describe('E-03 汎用の T スロットフレーム', () => {
  it('族の版・欄を凍結し、行は寸法指定の 1 行だけで、規格・資料の値を名乗らない', () => {
    expect([T_SLOT_FRAME_FAMILY.id, T_SLOT_FRAME_FAMILY.group, T_SLOT_FRAME_FAMILY.kindKey, T_SLOT_FRAME_FAMILY.catalogRevision,
      T_SLOT_FRAME_FAMILY.generatorRevision, T_SLOT_FRAME_FAMILY.stock, T_SLOT_FRAME_FAMILY.diagram]).toEqual(['t-slot-frame-specified',
      'aluminumFrame', 'catalog.frame.kind.tSlotSpecified', 't-slot-frame-specified-2026-11-r1', 't-slot-1', 'linear', 'tSlotFrame']);
    // 最後の 2 つは一括配置の留めの任意の欄(J-01 包み 5。miterOption.test.ts)。
    expect(T_SLOT_FRAME_FAMILY.options.filter((spec) => spec.optional !== true)
      .map((spec) => [spec.key, spec.kind, spec.min, spec.max, spec.defaultValue]))
      .toEqual(Object.entries(DEFAULTS).map(([key, value]) => [key, 'lengthExpression', undefined, undefined, value]));
    expect(T_SLOT_FRAME_FAMILY.options.map((spec) => spec.key).slice(-2)).toEqual(['startMiter', 'endMiter']);
    expect(T_SLOT_FRAME_FAMILY.rows.map((row) => [row.key, row.size, row.standardLabel, row.materialLabel, row.densityMaterialId,
      row.verification, row.verified, Object.keys(row.dims).length])).toEqual([['specified', '寸法指定', '寸法指定(規格の行ではない)',
      'アルミ', 'aluminum', 'unverified', false, 0]]);
    expect([ROW?.evidence.url, ROW?.evidence.sha256]).toEqual(['', '']);
  });

  it('断面の面積は設計の式と輪の面積(線分と円弧)が合い、外の輪は 1 本で中心の穴は内の輪 1 本', () => {
    for (const values of [DEFAULTS, { ...DEFAULTS, width: '30', slotOpening: '6', shoulder: '3', slotInnerWidth: '13', slotDepth: '5',
      centerHole: '5', cornerRadius: '1.5' }]) {
      const profile = tSlotProfile(dimsOf(values));
      if (profile === null) throw new Error('profile refused');
      expect(profile.areaMm2).toBeCloseTo(formulaArea(dimsOf(values)), 9);
      expect(profile.holes).toHaveLength(1);
      // 外の輪: 各面の溝の口と部屋で 9 本の線分、各角の円弧 1 つと、角の前後の外の面の線分。輪は閉じる。
      const segments = profile.segments;
      expect(segments.filter((segment) => segment.kind === 'arc')).toHaveLength(4);
      for (const [index, segment] of segments.entries()) {
        const next = segments[(index + 1) % segments.length];
        expect(next?.from[0]).toBeCloseTo(segment.to[0], 9);
        expect(next?.from[1]).toBeCloseTo(segment.to[1], 9);
      }
    }
  });

  it('形は外の輪の押し出しから穴の押し出しを引いた物で、体積は 面積 × 長さ、名前に外形と長さを入れる', () => {
    if (ROW === undefined) throw new Error('row is missing');
    const part = T_SLOT_FRAME_FAMILY.build(ROW, DEFAULTS);
    expect(part?.name).toBe('アルミフレーム(寸法指定) 40角×1000');
    expect(part?.solids.map((feature) => feature.kind)).toEqual(['extrude', 'extrude', 'boolean']);
    expect(T_SLOT_FRAME_FAMILY.nominalVolume(ROW, DEFAULTS)).toBeCloseTo(formulaArea(dimsOf(DEFAULTS)) * 1000, 6);
    expect(createCatalogItemSource(T_SLOT_FRAME_FAMILY, ROW).options).toEqual({ family: 't-slot-frame-specified', item: 'specified',
      ...DEFAULTS });
  });

  it('形が成り立たない組(口が部屋より広い・部屋の底が無い・斜めの肉が無い・穴が芯より大きい・角の丸みが溝の部屋に届く・式でない)は作らない', () => {
    if (ROW === undefined) throw new Error('row is missing');
    // 角の丸みの条件は R < A/2 − wi/2(初めの値では 20 − 9 = 11)。11 で届き、10.9 なら届かない。
    const bads: readonly Readonly<Record<string, string>>[] = [{ slotOpening: '18' }, { slotInnerWidth: '14' }, { slotInnerWidth: '40' },
      { centerHole: '18' }, { cornerRadius: '11' }, { width: '0' }, { slotDepth: 'abc' }, { length: '-1' }, { shoulder: '20' }];
    expect(T_SLOT_FRAME_FAMILY.build(ROW, { ...DEFAULTS, cornerRadius: '10.9' })).not.toBeNull();
    for (const bad of bads) {
      const values = { ...DEFAULTS, ...bad };
      expect(T_SLOT_FRAME_FAMILY.build(ROW, values)).toBeNull();
      expect(T_SLOT_FRAME_FAMILY.nominalVolume(ROW, values)).toBeNull();
    }
  });

  it('長さを持つ族なので、置いた部品は切断の一覧の族の行(長さ・本数・アルミの密度の質量)に出る', async () => {
    if (ROW === undefined) throw new Error('row is missing');
    const registry = createCatalogRegistry([{ id: T_SLOT_FRAME_FAMILY.id, group: T_SLOT_FRAME_FAMILY.group,
      kindKey: T_SLOT_FRAME_FAMILY.kindKey, load: () => Promise.resolve(T_SLOT_FRAME_FAMILY) }]);
    await registry.ensure([T_SLOT_FRAME_FAMILY.id]);
    const source = createCatalogItemSource(T_SLOT_FRAME_FAMILY, ROW, { length: '500' });
    const placed = (id: string): AssemblyComponent => ({ id, name: id, source, placement: DEFAULT_COMPONENT_PLACEMENT,
      fixed: false, visible: true, suppressed: false });
    const list = buildSteelStockList({ ...createAssemblyDocument('フレーム'), components: [placed('a'), placed('b')] },
      new Map(), new Map(), registry);
    expect(list.catalogRows.map((row) => [row.familyId, row.size, row.standardLabel, row.lengthMm, row.quantity, row.totalLengthMm]))
      .toEqual([['t-slot-frame-specified', '寸法指定', '寸法指定(規格の行ではない)', 500, 2, 1000]]);
    expect(list.catalogRows[0]?.massEachG).toBeCloseTo(formulaArea(dimsOf(DEFAULTS)) * 500 * 2.68e-3, 6);
  });

  it('断面の外形は原点が中心の外形の正方形で(線に沿って並べる時に使う)、形が作れない組は null', () => {
    if (ROW === undefined) throw new Error('row is missing');
    expect(T_SLOT_FRAME_FAMILY.sectionBounds?.(ROW, DEFAULTS)).toEqual({ minX: -20, minY: -20, maxX: 20, maxY: 20 });
    expect(T_SLOT_FRAME_FAMILY.sectionBounds?.(ROW, { ...DEFAULTS, width: '50' })).toEqual({ minX: -25, minY: -25, maxX: 25, maxY: 25 });
    expect(T_SLOT_FRAME_FAMILY.sectionBounds?.(ROW, { ...DEFAULTS, slotOpening: '18' })).toBeNull();
  });
});
