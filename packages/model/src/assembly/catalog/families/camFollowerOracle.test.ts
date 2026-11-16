/**
 * M-28 カムフォロア(スタッド形、メートル系)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の camFollower)の突合せ、
 * 寸法の整合と形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogItemRow } from '../types.js';
import { CAM_FOLLOWER_FAMILY, camFollowerThreadLabel } from './camFollower.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const firstEvidence = (rows: readonly CatalogItemRow[]): CatalogItemRow['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const CAM_FOLLOWER_ORACLE = CATALOG_ORACLES.camFollower;
const CAM_FOLLOWER_ROWS = CAM_FOLLOWER_FAMILY.rows;
const CAM_FOLLOWER_EVIDENCE = firstEvidence(CAM_FOLLOWER_ROWS);

/** 印刷の 1 行を、比べる形の文字列にする(D|C|d|G|G1|B1|B2)。 */
const printed = (row: readonly string[]): string => row.join('|');
const fromProduct = (row: (typeof CAM_FOLLOWER_ROWS)[number]): string => [row.dims.outsideDiameter, row.dims.ringWidth,
  row.dims.studDiameter, camFollowerThreadLabel(row), row.dims.threadLength, row.dims.overallLength, row.dims.studLength]
  .map(String).join('|');

describe('M-28 カムフォロア 資料の表との突合せ', () => {
  it('資料の 33 行(呼び番号ごと)は、外径ごとに寸法が同じで、製品の 17 行と順も値も一致する', () => {
    expect(CAM_FOLLOWER_ORACLE.rows).toHaveLength(33);
    const byDiameter = new Map<string, Set<string>>();
    for (const row of CAM_FOLLOWER_ORACLE.rows) {
      const set = byDiameter.get(row[0]) ?? new Set<string>();
      set.add(printed(row));
      byDiameter.set(row[0], set);
    }
    // 同じ外径の行(総ころ形・保持器付き・六角穴付き)は寸法が 1 通り。
    for (const variants of byDiameter.values()) expect(variants.size).toBe(1);
    const unique = [...byDiameter.values()].map((variants) => [...variants][0]);
    expect(CAM_FOLLOWER_ROWS.map(fromProduct)).toEqual(unique);
  });

  it('出どころは資料の PDF の SHA-256 と頁を持ち、全ての行が同じ出どころを指す', () => {
    expect(CAM_FOLLOWER_EVIDENCE.sha256).toBe(CAM_FOLLOWER_ORACLE.pdfSha256);
    expect(CAM_FOLLOWER_EVIDENCE.locator).toContain(`PDF ${CAM_FOLLOWER_ORACLE.page} 頁`);
    // 出どころの欄は資料の番号・SHA・頁だけ(URL と発行元は製品に書かない)。
    expect(CAM_FOLLOWER_EVIDENCE.title.startsWith('資料 K4-2 ')).toBe(true);
    expect(CAM_FOLLOWER_EVIDENCE.url).toBe('');
    expect(CAM_FOLLOWER_ROWS.every((row) => row.evidence === CAM_FOLLOWER_EVIDENCE
      && row.verification === 'manufacturer-catalog' && row.verified && row.note === '')).toBe(true);
  });

  it('寸法が形として整う: ねじの呼びの径はスタッドの径、G1 < B2 < B1、外輪の幅 C < B1 − B2、d < D', () => {
    for (const row of CAM_FOLLOWER_ROWS) {
      const { outsideDiameter: D, ringWidth: C, studDiameter: d, threadLength: G1, overallLength: B1, studLength: B2 } = row.dims;
      expect(camFollowerThreadLabel(row).startsWith(`M${d}×`)).toBe(true);
      expect(G1).toBeLessThan(B2);
      expect(B2).toBeLessThan(B1);
      expect(C).toBeLessThan(B1 - B2);
      expect(d).toBeLessThan(D);
    }
  });

  it('行の鍵・呼び・部品の名前は外径とねじの呼びだけで表し(型番を持たない)、重ならない', () => {
    const keys = CAM_FOLLOWER_ROWS.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(CAM_FOLLOWER_ROWS.map((row) => `D${row.dims.outsideDiameter}`));
    for (const row of CAM_FOLLOWER_ROWS) {
      expect(row.size).toBe(row.key);
      expect(CAM_FOLLOWER_FAMILY.partName(row, {})).toMatch(/^カムフォロア 外径[0-9]+ M[0-9]+×[0-9.]+$/u);
    }
    expect(CAM_FOLLOWER_FAMILY.partName(CAM_FOLLOWER_ROWS[2], {})).toBe('カムフォロア 外径16 M6×1.0');
  });

  it('族の版の文字列と指定を凍結する(保存されるので版の中で変えない)', () => {
    expect([CAM_FOLLOWER_FAMILY.id, CAM_FOLLOWER_FAMILY.catalogRevision, CAM_FOLLOWER_FAMILY.generatorRevision])
      .toEqual(['cam-follower-stud-metric', 'cam-follower-2026-11-r1', 'cam-follower-1']);
    expect(CAM_FOLLOWER_FAMILY.options).toEqual([]);
    expect([CAM_FOLLOWER_FAMILY.group, CAM_FOLLOWER_FAMILY.stock, CAM_FOLLOWER_FAMILY.diagram])
      .toEqual(['mechanical', 'count', 'camFollower']);
  });

  it('形は外輪とスタッドの 2 つの円柱の和で、体積は 外輪 + 外に出たスタッド', () => {
    for (const row of CAM_FOLLOWER_ROWS) {
      const part = CAM_FOLLOWER_FAMILY.build(row, {});
      expect(part?.name).toBe(CAM_FOLLOWER_FAMILY.partName(row, {}));
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
      const { outsideDiameter: D, ringWidth: C, studDiameter: d, overallLength: B1 } = row.dims;
      expect(CAM_FOLLOWER_FAMILY.nominalVolume(row, {}))
        .toBeCloseTo(Math.PI * (D / 2) ** 2 * C + Math.PI * (d / 2) ** 2 * (B1 - C), 9);
    }
    // 外径 16: π·8²·11 + π·3²·17 = 857π。
    expect(CAM_FOLLOWER_FAMILY.nominalVolume(CAM_FOLLOWER_ROWS[2], {})).toBeCloseTo(857 * Math.PI, 9);
  });
});
