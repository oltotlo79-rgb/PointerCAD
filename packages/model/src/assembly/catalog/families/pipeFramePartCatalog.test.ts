// 規格資料の出典は規格番号と一般名で照合する。
/**
 * 資料 2 のパイプ形のフレームのキャップとフットの 2 族の検査: 族の版・線図・数え方、行の名乗り(出どころ・note・簡略の印)、
 * 全部の行で形が作れる事、体積が段の形の式と合う事、質量が資料の値である事、密度の材質を持たない行の扱い。製品が使う口(族の書き出しと行の表)で確かめる。
 */
import { describe, expect, it } from 'vitest';

import { findDensityMaterial } from '../../../appearance/densityMaterials.js';
import { stackedPartVolume } from '../profiles/stackedPart.js';
import type { CatalogItemRow } from '../types.js';
import { PIPE_FRAME_CAP_FAMILY, PIPE_FRAME_FOOT_FAMILY, type PipeFramePartRecord } from './pipeFramePartCatalog.js';
import { PIPE_FRAME_CAP_RECORDS, PIPE_FRAME_FOOT_RECORDS } from './pipeFramePartRows.js';

const PAIRS = [[PIPE_FRAME_CAP_FAMILY, PIPE_FRAME_CAP_RECORDS], [PIPE_FRAME_FOOT_FAMILY, PIPE_FRAME_FOOT_RECORDS]] as const;

function rowOf(rows: readonly CatalogItemRow[], record: PipeFramePartRecord): CatalogItemRow {
  const row = rows.find((candidate) => candidate.key === record.key);
  if (row === undefined) throw new Error(`行 ${record.key} が無い`);
  return row;
}

describe('資料 2 のパイプ形のフレームのキャップとフット', () => {
  it('族の id・群・種類の鍵・版・線図・数え方を凍結し、行は行の表の行を同じ順で持ち、鍵と呼びは族の中で重ならない', () => {
    expect(PAIRS.map(([family]) => [family.id, family.group, family.kindKey, family.catalogRevision, family.generatorRevision, family.diagram,
      family.stock, family.options.length])).toEqual([
      ['pipe-frame-cap', 'aluminumFrame', 'catalog.frame.kind.pipeFrameCap', 'pipe-frame-cap-2026-11-r1', 'pipe-frame-part-1', 'pipeFrameCap', 'count', 0],
      ['pipe-frame-foot', 'aluminumFrame', 'catalog.frame.kind.pipeFrameFoot', 'pipe-frame-foot-2026-11-r1', 'pipe-frame-part-1', 'pipeFrameFoot', 'count',
        0],
    ]);
    expect(PAIRS.map(([, records]) => records.length)).toEqual([18, 15]);
    for (const [family, records] of PAIRS) {
      expect(family.rows.map((row) => [row.key, row.size])).toEqual(records.map((record) => [record.key, record.size]));
      expect(new Set(family.rows.map((row) => row.key)).size).toBe(family.rows.length);
      expect(new Set(family.rows.map((row) => row.size)).size).toBe(family.rows.length);
    }
    // キャップの族は種類にキャップの語を持つ行だけ、フットの族は持たない行だけ。
    expect(PIPE_FRAME_CAP_RECORDS.every((record) => record.kind.includes('キャップ'))).toBe(true);
    expect(PIPE_FRAME_FOOT_RECORDS.some((record) => record.kind.includes('キャップ'))).toBe(false);
  });

  it('行は規格の行を名乗らず、出どころは資料の番号と頁だけで、note と簡略の印は行の表の印から作る', () => {
    for (const [family, records] of PAIRS) {
      for (const record of records) {
        const row = rowOf(family.rows, record);
        expect([row.standardLabel, row.materialLabel, row.verification, row.verified, row.simplified], record.key)
          .toEqual(['製造元の寸法に合わせた物', record.materialLabel, 'manufacturer-catalog', true, record.simplified]);
        expect([row.evidence.title, row.evidence.reference], record.key)
          .toEqual(['資料 2 パイプ形のフレームの総合カタログ(製造元の寸法に合わせた物)', '']);
        expect(row.evidence.locator).toBe(`PDF ${record.page} 頁 部品の図(段の寸法)と質量の記入`);
        const mass = record.massG === null ? '質量は資料に記入が無いので、形 × 密度' : '質量は資料の 1 個の値';
        expect(row.note, record.key).toBe(record.simplified.length > 0 ? `形は簡略(${record.simplified.join('・')})。${mass}` : mass);
      }
    }
  });

  it('全部の行で形が作れ、名前は呼び、体積は段の形の式、質量は資料の 1 個の値(記入の無い行は null)', () => {
    for (const [family, records] of PAIRS) {
      for (const record of records) {
        const row = rowOf(family.rows, record);
        const part = family.build(row, {});
        expect(part, record.key).not.toBeNull();
        expect(part?.name).toBe(record.size);
        expect(family.nominalVolume(row, {}), record.key).toBeCloseTo(stackedPartVolume({ segments: record.segments, thread: record.thread }) ?? NaN, 9);
        expect(family.nominalMassG?.(row, {}) ?? null, record.key).toBe(record.massG);
      }
    }
  });

  it('密度の材質を持たない行(LDPE・導電 PP・PU・NBR・部位ごとに材料の違う物)は行に材質の id を持たず、必ず資料の質量を持つ。持つ行の id は密度の表にある', () => {
    for (const [family, records] of PAIRS) {
      for (const record of records) {
        const row = rowOf(family.rows, record);
        if (record.densityMaterialId === null) {
          expect('densityMaterialId' in row, record.key).toBe(false);
          expect(record.massG, record.key).not.toBeNull();
        } else {
          expect(row.densityMaterialId, record.key).toBe(record.densityMaterialId);
          expect(findDensityMaterial(record.densityMaterialId), record.key).toBeDefined();
        }
      }
    }
    expect(PAIRS.flatMap(([, records]) => records).filter((record) => record.densityMaterialId === null).length).toBe(25);
  });
});
