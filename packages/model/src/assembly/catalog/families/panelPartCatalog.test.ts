// 規格資料の出典は規格番号と一般名で照合する。
/**
 * 資料 2 のパネル扉の部品・パネル用のフレーム・コネクタ(外形を包む形。統括の決定 2026-11-18 14:1x の (1)・15:0x の (2))と、
 * キャップと足の部品・可動の部品・アクセサリ(統括の指示 2026-11-18 21:31・21:45・21:47)の族の検査: 族の版・欄・線図・数え方、
 * 行の名乗りと簡略の印、箱と四角の断面の形と体積、質量(部品は資料の 1 個の値、フレームは単位質量 × 長さ)、材料の密度の持ち方、
 * 切断の一覧に出る事、断面の性質を持たず梁の解析の部材にならない(解析から外した部品として数えられるだけ)事。
 */
import { describe, expect, it } from 'vitest';

import { beamCadFixture, testComponent } from '../../../analysis/beamInputs.testSupport.js';
import { standardMembersToBeamAnalysis } from '../../../analysis/standardBeamAdapter.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../../createAssemblyDocument.js';
import { partKeyOf } from '../../resolveAssembly.js';
import { buildSteelStockList } from '../../standard/steelStockList.js';
import type { AssemblyComponent } from '../../types.js';
import { weldTestBody } from '../../welding/filletWeld.testSupport.js';
import { createCatalogRegistry, PRODUCT_CATALOG_REGISTRY } from '../registry.js';
import { catalogItemNominalMass, createCatalogItemSource } from '../source.js';
import type { CatalogItemRow } from '../types.js';
import { ACCESSORY_BOX_RECORDS } from './accessoryBoxRows.js';
import { CAP_FOOT_BOX_RECORDS } from './capFootBoxRows.js';
import { CAP_FOOT_LOCK_RECORDS } from './capFootLockRows.js';
import { CONNECTOR_BOX_RECORDS } from './connectorBoxRows.js';
import { CONNECTOR_BOX_SERIES_RECORDS } from './connectorBoxSeriesRows.js';
import { MOVABLE_PART_BOX_RECORDS } from './movablePartBoxRows.js';
import { ACCESSORY_BOX_FAMILY, CAP_FOOT_BOX_FAMILY, CONNECTOR_BOX_FAMILY, MOVABLE_PART_BOX_FAMILY, PANEL_COVER_FRAME_FAMILY,
  PANEL_PART_BOX_FAMILY } from './panelPartCatalog.js';
import { PANEL_COVER_FRAME_RECORDS, PANEL_PART_RECORDS } from './panelPartRows.js';

const MARK = '外形を包む形で、細部は作っていない';
/** 可動の部品の行だけが続ける 2 つ目の簡略の印。 */
const MOVABLE_MARK = '動く仕組みは作っていない';
/** コネクタの族の行(はじめの章の表に系列の章の表を続ける)。 */
const CONNECTOR_RECORDS = [...CONNECTOR_BOX_RECORDS, ...CONNECTOR_BOX_SERIES_RECORDS];
/** キャップと足の部品の族の行(21 回目の表に足回りのロックの表を続ける)。 */
const CAP_FOOT_RECORDS = [...CAP_FOOT_BOX_RECORDS, ...CAP_FOOT_LOCK_RECORDS];
const DENSITY: Readonly<Record<string, number>> = { aluminum: 2.68, stainless: 7.93, steel: 7.85 };
const length = (value: number): Readonly<Record<string, string>> => ({ length: String(value) });

function frameRow(key: string): CatalogItemRow {
  const row = PANEL_COVER_FRAME_FAMILY.rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`行 ${key} が無い`);
  return row;
}

describe('資料 2 のパネル扉の部品・パネル用のフレーム・コネクタ・キャップと足の部品・可動の部品・アクセサリの 6 族', () => {
  it('族の id・群・種類の鍵・版・線図・数え方・欄を凍結し、行は行の表の行を同じ順で持つ', () => {
    expect([PANEL_PART_BOX_FAMILY, PANEL_COVER_FRAME_FAMILY, CONNECTOR_BOX_FAMILY, CAP_FOOT_BOX_FAMILY, MOVABLE_PART_BOX_FAMILY,
      ACCESSORY_BOX_FAMILY].map((family) => [family.id, family.group, family.kindKey, family.catalogRevision, family.generatorRevision,
      family.diagram, family.stock, family.options.map((spec) => spec.key)])).toEqual([
      ['panel-part-box', 'aluminumFrame', 'catalog.board.kind.partBox', 'panel-part-box-2026-11-r1', 'panel-part-1', 'panelPartBox', 'count', []],
      ['panel-cover-frame', 'aluminumFrame', 'catalog.board.kind.coverFrame', 'panel-cover-frame-2026-11-r1', 'panel-part-1', 'panelCoverFrame',
        'linear', ['length', 'startMiter', 'endMiter']],
      ['connector-box', 'aluminumFrame', 'catalog.frame.kind.connectorBox', 'connector-box-2026-11-r1', 'panel-part-1', 'connectorBox', 'count', []],
      ['cap-foot-box', 'aluminumFrame', 'catalog.frame.kind.capFootBox', 'cap-foot-box-2026-11-r1', 'panel-part-1', 'capFootBox', 'count', []],
      ['movable-part-box', 'aluminumFrame', 'catalog.frame.kind.movableBox', 'movable-part-box-2026-11-r1', 'panel-part-1', 'movableBox', 'count', []],
      ['accessory-box', 'aluminumFrame', 'catalog.frame.kind.accessoryBox', 'accessory-box-2026-11-r1', 'panel-part-1', 'accessoryBox', 'count', []],
    ]);
    expect(PANEL_PART_BOX_FAMILY.rows.map((row) => [row.key, row.size])).toEqual(PANEL_PART_RECORDS.map((record) => [record.key, record.size]));
    expect(PANEL_COVER_FRAME_FAMILY.rows.map((row) => [row.key, row.size]))
      .toEqual(PANEL_COVER_FRAME_RECORDS.map((record) => [record.key, record.size]));
    expect(CONNECTOR_BOX_FAMILY.rows.map((row) => [row.key, row.size])).toEqual(CONNECTOR_RECORDS.map((record) => [record.key, record.size]));
    // キャップと足の部品の族は、21 回目の行の後に足回りのロックの行(39h)を続ける。
    expect(CAP_FOOT_BOX_FAMILY.rows.map((row) => [row.key, row.size])).toEqual(CAP_FOOT_RECORDS.map((record) => [record.key, record.size]));
    expect(MOVABLE_PART_BOX_FAMILY.rows.map((row) => [row.key, row.size]))
      .toEqual(MOVABLE_PART_BOX_RECORDS.map((record) => [record.key, record.size]));
    expect(ACCESSORY_BOX_FAMILY.rows.map((row) => [row.key, row.size])).toEqual(ACCESSORY_BOX_RECORDS.map((record) => [record.key, record.size]));
    expect([PANEL_PART_RECORDS.length, PANEL_COVER_FRAME_RECORDS.length, CONNECTOR_BOX_RECORDS.length, CONNECTOR_BOX_SERIES_RECORDS.length,
      CAP_FOOT_BOX_RECORDS.length, CAP_FOOT_LOCK_RECORDS.length, MOVABLE_PART_BOX_RECORDS.length, ACCESSORY_BOX_RECORDS.length])
      .toEqual([7, 9, 47, 27, 7, 1, 12, 5]);
    // コネクタの族は 2 つの章の表を合わせて 74 行で、鍵は重ならない(同じ鍵の行は道具が除いた)。
    expect(CONNECTOR_BOX_FAMILY.rows).toHaveLength(74);
    expect(new Set(CONNECTOR_BOX_FAMILY.rows.map((row) => row.key)).size).toBe(74);
  });

  it('行は製造元の寸法に合わせた物を名乗り、出どころは資料の番号と頁だけ、印は「外形を包む形で、細部は作っていない」(可動の部品は「動く仕組みは作っていない」を続ける)、呼びにも「外形を包む形」', () => {
    const marked = [...[PANEL_PART_BOX_FAMILY, PANEL_COVER_FRAME_FAMILY, CONNECTOR_BOX_FAMILY, CAP_FOOT_BOX_FAMILY, ACCESSORY_BOX_FAMILY]
      .map((family) => [family, [MARK]] as const), [MOVABLE_PART_BOX_FAMILY, [MARK, MOVABLE_MARK]] as const];
    for (const [family, marks] of marked) {
      for (const row of family.rows) {
        expect([row.standardLabel, row.verification, row.verified, row.simplified, row.evidence.reference], row.key)
          .toEqual(['製造元の寸法に合わせた物', 'manufacturer-catalog', true, marks, '']);
        expect(row.evidence.locator, row.key).toMatch(/^PDF [0-9]+ 頁 /u);
        expect(row.size, row.key).toContain('外形を包む形');
        expect(row.note, row.key).toContain(`形は簡略(${marks.join('・')})`);
      }
    }
  });

  it('部品とコネクタは幅 × 奥行 × 高さの箱で、体積は 3 つの積、質量は資料の 1 個の値。材料が 1 つの行は箱 × 密度より軽く、部位ごとに材料の違う行は密度を持たない', () => {
    for (const [family, records] of [[PANEL_PART_BOX_FAMILY, PANEL_PART_RECORDS], [CONNECTOR_BOX_FAMILY, CONNECTOR_RECORDS],
      [CAP_FOOT_BOX_FAMILY, CAP_FOOT_RECORDS], [MOVABLE_PART_BOX_FAMILY, MOVABLE_PART_BOX_RECORDS],
      [ACCESSORY_BOX_FAMILY, ACCESSORY_BOX_RECORDS]] as const) {
      for (const record of records) {
        const row = family.rows.find((candidate) => candidate.key === record.key);
        if (row === undefined) throw new Error(`行 ${record.key} が無い`);
        const volume = record.width * record.depth * record.height;
        expect(family.nominalVolume(row, {}), record.key).toBeCloseTo(volume, 9);
        expect(family.build(row, {})?.name, record.key).toBe(row.size);
        expect(family.nominalMassG?.(row, {}) ?? null, record.key).toBe(record.massG);
        if (record.material === 'mixed' || record.massG === null) {
          expect([row.densityMaterialId, row.materialLabel], record.key).toEqual([undefined, record.materialText]);
        } else {
          expect(row.densityMaterialId, record.key).toBe(record.material);
          expect(record.massG, record.key).toBeLessThan(volume * (DENSITY[record.material] ?? NaN) / 1000);
        }
      }
    }
  });

  it('質量の欄を持たない部品の行は、族が質量を返さない(汎用の行で確かめる)', () => {
    const first = PANEL_PART_BOX_FAMILY.rows[0];
    if (first === undefined) throw new Error('部品の行が無い');
    const row: CatalogItemRow = { ...first, dims: { width: 10, depth: 20, height: 30 } };
    expect(PANEL_PART_BOX_FAMILY.nominalMassG?.(row, {}) ?? null).toBeNull();
    expect(PANEL_PART_BOX_FAMILY.nominalVolume(row, {})).toBeCloseTo(6000, 9);
  });

  it('フレームは外形の四角の断面を長さだけ押し出した形で、体積は幅 × 高さ × 長さ、質量は単位質量 × 長さ、断面の外形は原点が中心の四角', () => {
    for (const record of PANEL_COVER_FRAME_RECORDS) {
      const row = frameRow(record.key);
      expect(PANEL_COVER_FRAME_FAMILY.nominalVolume(row, length(500)), record.key).toBeCloseTo(record.width * record.height * 500, 9);
      expect(PANEL_COVER_FRAME_FAMILY.nominalMassG?.(row, length(500)), record.key).toBeCloseTo(record.unitMassKgPerM * 500, 9);
      expect(PANEL_COVER_FRAME_FAMILY.build(row, length(500))?.name, record.key).toBe(`${row.size}×500`);
      expect(PANEL_COVER_FRAME_FAMILY.sectionBounds?.(row, length(500)), record.key).toEqual({ minX: -record.width / 2, minY: -record.height / 2,
        maxX: record.width / 2, maxY: record.height / 2 });
      // 断面の性質(Ix・Iy・Zx・Zy)と溝は持たない。
      expect(Object.keys(row.dims), record.key).toEqual(['width', 'height', 'unitMassKgPerM']);
      expect([row.densityMaterialId, row.materialLabel], record.key).toEqual(['aluminum', 'アルミ']);
    }
    expect('sectionSlots' in PANEL_COVER_FRAME_FAMILY).toBe(false);
    expect(PANEL_COVER_FRAME_FAMILY.build(frameRow('cover-frame-44x33'), length(0))).toBeNull();
  });

  it('フレームは切断の一覧に長さと単位質量で出て、部品は出ない。質量は登録口を通しても同じ', async () => {
    const registry = createCatalogRegistry([PANEL_PART_BOX_FAMILY, PANEL_COVER_FRAME_FAMILY].map((family) => ({ id: family.id, group: family.group,
      kindKey: family.kindKey, load: () => Promise.resolve(family) })));
    await registry.ensure(['panel-part-box', 'panel-cover-frame']);
    const part = PANEL_PART_BOX_FAMILY.rows[0];
    if (part === undefined) throw new Error('部品の行が無い');
    const box = createCatalogItemSource(PANEL_PART_BOX_FAMILY, part, {});
    const frame = createCatalogItemSource(PANEL_COVER_FRAME_FAMILY, frameRow('cover-frame-60x38'), length(750));
    expect(catalogItemNominalMass(frame, registry)).toBeCloseTo(0.97 * 750, 9);
    expect(catalogItemNominalMass(box, registry)).toBe(PANEL_PART_RECORDS[0]?.massG);
    const placed = (id: string, source: AssemblyComponent['source']): AssemblyComponent => ({ id, name: id, source,
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false });
    const list = buildSteelStockList({ ...createAssemblyDocument('部品'), components: [placed('a', box), placed('b', frame)] }, new Map(),
      new Map(), registry);
    expect(list.catalogRows.map((row) => [row.familyId, row.size, row.lengthMm, row.quantity, row.unitMassKgPerM]))
      .toEqual([['panel-cover-frame', 'パネル用のフレーム 60×38（外形を包む形）', 750, 1, 0.97]]);
  });

  it('フレームは梁の解析の部材にならず、解析から外した部品として単位質量 × 長さで数えられるだけ', async () => {
    const fixture = beamCadFixture();
    const frame: AssemblyComponent = { ...testComponent('cover'), source: createCatalogItemSource(PANEL_COVER_FRAME_FAMILY,
      frameRow('cover-frame-44x33'), length(600)) };
    const document = { ...fixture.document, components: [...fixture.document.components, frame] };
    const bodies = new Map([[partKeyOf(frame.source), [{ ...weldTestBody([], []), volume: 44 * 33 * 600 }]]]);
    await PRODUCT_CATALOG_REGISTRY.ensure(['panel-cover-frame']);
    const result = standardMembersToBeamAnalysis(document, fixture.definition, { currentSource: fixture.stamp, bodies, assemblyOptions: {} });
    if (!result.ok) throw new Error(result.issue.message);
    // 解析の部材は、定義の部材(鋼材の平鋼)だけ。フレームは部材に入らない。
    expect(result.document.members.length).toBe(fixture.definition.members.length);
    const excluded = result.excludedParts.find((group) => group.kind === 'catalogItem');
    expect(excluded?.count).toBe(1);
    expect(excluded?.massKg).toBeCloseTo(0.58 * 600 / 1000, 12);
  });
});
