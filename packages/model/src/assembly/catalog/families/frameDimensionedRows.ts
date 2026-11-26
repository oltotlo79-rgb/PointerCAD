import type { TSlotCatalogRecord } from './tSlotFrameCatalog.js';

/** 同じ溝幅 6 の族で、図の寸法端と輪郭を照合した長方形の断面。図の右が +X、上が +Y、長さは +Z。 */
export const T_SLOT_DIMENSIONED_RECORDS: readonly TSlotCatalogRecord[] = [
  { key: 's6-20x20-tb', size: '溝幅 6 20×20 2 面溝（向かい合う・上下）', slot: 6, figurePage: 43, tablePage: 384, massSource: 'table',
    width: 20, height: 20, slotPitch: 20, slotsAcross: 1, faces: 'tb', slotOpening: 6, shoulder: 2, slotInnerWidth: 12, slotDepth: 4,
    centerHole: 4.2, cornerRadius: 1, cornerHoleDiameter: 0, cornerHoleInset: 0, areaMm2: 200, unitMassKgPerM: 0.54, ixCm4: 0.75,
    iyCm4: 0.89, zxCm3: 0.75, zyCm3: 0.89, simplified: ['左右の閉じた内空と溝の細部'] },
  { key: 's6-20x40-tl', size: '溝幅 6 20×40 2 面溝（上 1 本・左 2 本）', slot: 6, figurePage: 45, tablePage: null, massSource: 'box',
    width: 20, height: 40, slotPitch: 20, slotsAcross: 1, faces: 'tl', slotOpening: 6, shoulder: 2, slotInnerWidth: 12, slotDepth: 4,
    centerHole: 4.2, connectedAxialHoles: true, cornerRadius: 1, cornerHoleDiameter: 0, cornerHoleInset: 0, areaMm2: null, unitMassKgPerM: 0.78,
    ixCm4: null, iyCm4: null, zxCm3: null, zyCm3: null, simplified: ['寸法表の軸穴とそれにつながる内空・溝の細部'] },
  // 通し穴の縦横の中心間は図示の 18.5 mm。外面からの距離は (25 − 18.5) / 2。
  { key: 's6-25x25', size: '溝幅 6 25×25（中央穴 Ø6.8・四隅穴 4-Ø4.2）', slot: 6, figurePage: 46, tablePage: 384, massSource: 'table',
    width: 25, height: 25, slotPitch: 25, slotsAcross: 1, faces: 'tblr', slotOpening: 6, shoulder: 2, slotInnerWidth: 12, slotDepth: 4,
    centerHole: 6.8, cornerRadius: 1, cornerHoleDiameter: 4.2, cornerHoleInset: 3.25, areaMm2: 288, unitMassKgPerM: 0.78, ixCm4: 1.64,
    iyCm4: 1.64, zxCm3: 1.31, zyCm3: 1.31, simplified: ['穴の周りの切り欠きと溝の細部'] },
];
