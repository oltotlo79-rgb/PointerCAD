/**
 * 生成物(手で直さない): 資料 1 の溝つきフレームのうち、長方形の格子で表せない断面(1 つの角の大きな丸み)の行。
 * 担当の道具 outline_from_chains.py が、34 回目の読みの 2 本の寸法線の鎖から外周の頂点・角の丸み・溝の位置・穴を読みごとに作り、
 * 2 つで同じ物だけを書いた。断面の値と単位質量は断面性能の表(2 回の読みが一致)。2 本目の読みの文字は fixture
 * `frameOutlineOracle.fixture.json` に文字のまま書き、検査が照らす。製造元の名前・型番は書かない。
 */
import type { TSlotCatalogRecord } from './tSlotFrameCatalog.js';

export const T_SLOT_OUTLINE_RECORDS: readonly TSlotCatalogRecord[] = [
  { key: 's6-20x20-r15', size: '溝幅 6 20×20 1 つの角が R15（2 面溝・隣り合う）', slot: 6, figurePage: 46, tablePage: 384, massSource: 'table', width: 20,
    height: 20, slotPitch: 20, slotsAcross: 1, faces: 'br', slotOpening: 6, shoulder: 2, slotInnerWidth: 12, slotDepth: 4, centerHole: 3.3,
    cornerRadius: 1, cornerHoleDiameter: 0, cornerHoleInset: 0, areaMm2: 150, unitMassKgPerM: 0.41, ixCm4: 0.55, iyCm4: 0.55, zxCm3: 0.49,
    zyCm3: 0.49,
    outline: { vertices: [[-10, -10], [10, -10], [10, 10], [-10, 10]], radii: [1, 1, 1, 15],
      slots: [{ edge: 0, at: 10 }, { edge: 1, at: 10 }], holes: [{ x: 0, y: 0, diameter: 3.3 }] } },
  { key: 's8-30x30-r22', size: '溝幅 8 30×30 1 つの角が R22（2 面溝・隣り合う）', slot: 8, figurePage: 93, tablePage: 384, massSource: 'table', width: 30,
    height: 30, slotPitch: 30, slotsAcross: 1, faces: 'br', slotOpening: 8, shoulder: 2, slotInnerWidth: 16.5, slotDepth: 7,
    centerHole: 6.8, cornerRadius: 1, cornerHoleDiameter: 0, cornerHoleInset: 0, areaMm2: 305, unitMassKgPerM: 0.82, ixCm4: 2.42,
    iyCm4: 2.42, zxCm3: 1.53, zyCm3: 1.53,
    outline: { vertices: [[-15, -15], [15, -15], [15, 15], [-15, 15]], radii: [1, 2, 1, 22],
      slots: [{ edge: 0, at: 15 }, { edge: 1, at: 15 }], holes: [{ x: 0, y: 0, diameter: 6.8 }] } },
];
