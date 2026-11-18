/**
 * キャスターの族(families/casterCatalog.ts)の作り方の検査。行の表は読みの 2 段目の後なので、汎用の行(資料の行ではない)で族の作り方を確かめる:
 * 族の版・欄・線図・数え方、行の欄と欄からの戻し、形・体積・質量、材料の密度を持たない事、出どころの題と note と簡略の印。
 */
import { describe, expect, it } from 'vitest';

import { casterVolume } from '../profiles/casterShape.js';
import { casterDimensionsOf, createCasterFamily, type CasterRecord } from './casterCatalog.js';

const MARKS = ['フォークの形(決まった寸法から作った簡略の箱)', '旋回の向き・止めの機構(作っていない)', '車輪の溝・ゴムの形(作っていない)'];
const RECORDS: readonly CasterRecord[] = [
  { key: 'plate-swivel-brake-d50-w20-h75-e10-p60x50', size: 'キャスター(自在・止め付き・板) 車輪 φ50×20 高さ 75(板 60×50)', book: 1, page: 1,
    swivel: true, brake: true, wheelDiameter: 50, wheelWidth: 20, offset: 10, height: 75,
    mount: { kind: 'plate', width: 60, depth: 50, thickness: 3, holes: [[-24, -19, 6], [24, -19, 6], [-24, 19, 6], [24, 19, 6]] },
    materialText: '鋼(金具)・ゴム(車輪)', massG: 210, simplified: [...MARKS, '止め(作っていない)'] },
  { key: 'stem-rigid-d40-w18-h60-e0-m12x25', size: 'キャスター(固定・ねじ) 車輪 φ40×18 高さ 60(M12×25)', book: 2, page: 2, swivel: false, brake: false,
    wheelDiameter: 40, wheelWidth: 18, offset: 0, height: 60, mount: { kind: 'stem', thread: 'M12', length: 25 }, materialText: '樹脂',
    massG: null, simplified: MARKS },
  { key: 'stem-swivel-d50-w20-h70-e20-m12x30', size: 'キャスター(自在・ねじ) 車輪 φ50×20 高さ 70(M12×30)', book: 2, page: 3, swivel: true, brake: false,
    wheelDiameter: 50, wheelWidth: 20, offset: 20, height: 70, mount: { kind: 'stem', thread: 'M12', length: 30 }, materialText: 'ゴム(車輪)',
    massG: 180, simplified: MARKS, singleSource: ['wheelWidth'] },
  { key: 'insert-swivel-d50-w20-h70-e21', size: 'キャスター(自在・差込み) 車輪 φ50×20 高さ 70', book: 2, page: 4, swivel: true, brake: false,
    wheelDiameter: 50, wheelWidth: 20, offset: 21, height: 70, mount: { kind: 'none' }, materialText: 'ゴム(車輪)', massG: 120,
    simplified: [...MARKS, '差込みの軸は作っていない'], pinLength: 38.5 },
  { key: 'insert-rigid-d50-w20-h70-e0', size: 'キャスター(固定・差込み) 車輪 φ50×20 高さ 70', book: 2, page: 5, swivel: false, brake: false,
    wheelDiameter: 50, wheelWidth: 20, offset: 0, height: 70, mount: { kind: 'none' }, materialText: 'ゴム(車輪)', massG: null,
    simplified: [...MARKS, '差込みの軸は作っていない'], singleSource: ['wheelWidth'] },
  { key: 'stem-swivel-twin-d75-w12.5-g22-h84.5-e20-m12x14', size: 'キャスター(自在・ねじ・双輪) 車輪 φ75×12.5×2 すき間 22 高さ 84.5(M12×14)',
    book: 2, page: 6, swivel: true, brake: false, wheelDiameter: 75, wheelWidth: 12.5, offset: 20, height: 84.5,
    mount: { kind: 'stem', thread: 'M12', length: 14 }, materialText: 'エラストマー(車輪)', massG: 150, simplified: MARKS,
    singleSource: ['wheelWidth', 'twinGap'], twinGap: 22 },
];
const INSERT = '差込みの軸は作っていない(軸の外径の記入が無い)。部品表と高さの検討に使え、パイプへ差し込む合わせ(合致)には使えない。';
const SINGLE = '。車輪の幅: この寸法は 1 つの資料の値(製造元が公開している車輪の幅の一覧。一覧の車輪の径がカタログの径と同じ型番だけ)。';
const TWIN = '。車輪の幅とすき間: この寸法は 1 つの資料の値から作った(製造元が公開している車輪の幅の一覧の、全体の幅〔両輪の外側の面の間〕と'
  + '両輪の内側の面の間から、1 輪の幅 =(全体の幅 − 内側の間)÷ 2。1 輪の幅は外側の張り出しを含む。一覧の車輪の径がカタログの径と同じ型番だけ)。';
const FAMILY = createCasterFamily(RECORDS);

describe('キャスターの族の作り方(汎用の行)', () => {
  it('族の id・群・種類の鍵・版・線図・数え方・欄を凍結し、行は渡した行を同じ順で持つ', () => {
    expect([FAMILY.id, FAMILY.group, FAMILY.kindKey, FAMILY.catalogRevision, FAMILY.generatorRevision, FAMILY.diagram, FAMILY.stock, FAMILY.options])
      .toEqual(['t-slot-caster', 'aluminumFrame', 'catalog.frame.kind.caster', 't-slot-caster-2026-11-r1', 'caster-1', 'caster', 'count', []]);
    expect(FAMILY.rows.map((row) => [row.key, row.size])).toEqual(RECORDS.map((record) => [record.key, record.size]));
  });

  it('行の欄から寸法に戻せ、形が作れ、体積は形の式、質量は資料の 1 個の値(無ければ出さない)', () => {
    for (const [index, record] of RECORDS.entries()) {
      const row = FAMILY.rows[index];
      if (row === undefined) throw new Error(`行 ${record.key} が無い`);
      const dims = casterDimensionsOf(row);
      expect(dims, record.key).toEqual({ wheelDiameter: record.wheelDiameter, wheelWidth: record.wheelWidth, offset: record.offset,
        height: record.height, mount: record.mount, ...(record.twinGap === undefined ? {} : { twinGap: record.twinGap }) });
      expect(FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      expect(FAMILY.nominalVolume(row, {}), record.key).toBeCloseTo(dims === null ? NaN : casterVolume(dims) ?? NaN, 9);
      expect(FAMILY.nominalMassG?.(row, {}) ?? null, record.key).toBe(record.massG);
    }
  });

  it('密度を持たず、部品表の材質は資料の材質の文字、出どころは資料の番号と頁だけ、note に簡略の印と質量の出し方(1 つの資料の幅は印)', () => {
    for (const [index, record] of RECORDS.entries()) {
      const row = FAMILY.rows[index];
      const single = record.singleSource !== undefined;
      expect([row?.densityMaterialId, row?.materialLabel, row?.simplified], record.key).toEqual([undefined, record.materialText, record.simplified]);
      expect(row?.evidence.title, record.key).toBe(`資料 ${String(record.book)} アルミ構造材の総合カタログ(製造元の寸法に合わせた物)`);
      expect(row?.evidence.reference, record.key).toBe('');
      expect(row?.evidence.locator, record.key).toBe(`PDF ${String(record.page)} 頁 キャスターの図(寸法)と質量の記入`
        + (single ? '／車輪の幅は製造元が公開している車輪の幅の一覧' : ''));
      const insert = record.mount.kind === 'none' ? `${single ? '' : '。'}${INSERT}` : '';
      expect(row?.note, record.key).toBe(`形は簡略(${record.simplified.join('・')})。${record.massG === null ? '質量は資料に記入が無いので出さない'
        : '質量は資料の 1 個の値'}${single ? (record.twinGap === undefined ? SINGLE : TWIN) : ''}${insert}`);
      expect([row?.dims.pinLength, row?.dims.wheelGap], record.key).toEqual([record.pinLength, record.twinGap]);
    }
  });
});
