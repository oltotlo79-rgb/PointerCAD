import type { CatalogFamilyEntry } from '../types.js';

/**
 * 包み K6 の族の登録の一覧: アルミフレームとブラケット・ナットなど(寸法の出どころの判断の後に足す)。
 * この包みの族だけをここへ足す(登録口 `registry.ts` と他の包みの一覧は触らない)。1 行の形は `k4a.ts` と同じで、
 * 分類は `group: 'aluminumFrame'`。表は `load` の中の動的な読み込みで必要な時だけ読む(起動の時に読まない)。
 */
export const K6_CATALOG_FAMILIES: readonly CatalogFamilyEntry[] = [
  { id: 't-slot-frame-specified', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.tSlotSpecified',
    load: async () => (await import('../families/tSlotFrame.js')).T_SLOT_FRAME_FAMILY },
  { id: 't-slot-frame-series', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.tSlotSeries',
    load: async () => (await import('../families/tSlotFrameSeries.js')).T_SLOT_FRAME_SERIES_FAMILY },
  { id: 'angle-bracket-specified', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.angleBracket',
    load: async () => (await import('../families/frameParts.js')).ANGLE_BRACKET_FAMILY },
  { id: 'join-plate-specified', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.joinPlate',
    load: async () => (await import('../families/frameParts.js')).JOIN_PLATE_FAMILY },
  { id: 'slot-nut-specified', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.slotNut',
    load: async () => (await import('../families/frameParts.js')).SLOT_NUT_FAMILY },
  // 資料 SF-1 で寸法が確認できる溝つきフレーム(溝幅ごと)と共通フレームの形材(種類ごと)。2 回の読みが一致した行だけを持つ。
  { id: 't-slot-frame-s6', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.tSlotS6',
    load: async () => (await import('../families/tSlotFrameCatalog.js')).T_SLOT_CATALOG_FAMILIES.s6 },
  { id: 't-slot-frame-s8', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.tSlotS8',
    load: async () => (await import('../families/tSlotFrameCatalog.js')).T_SLOT_CATALOG_FAMILIES.s8 },
  { id: 't-slot-frame-s10', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.tSlotS10',
    load: async () => (await import('../families/tSlotFrameCatalog.js')).T_SLOT_CATALOG_FAMILIES.s10 },
  { id: 'aluminum-channel', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.channel',
    load: async () => (await import('../families/aluminumSections.js')).ALUMINUM_SECTION_FAMILIES.channel },
  { id: 'aluminum-square-pipe', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.squarePipe',
    load: async () => (await import('../families/aluminumSections.js')).ALUMINUM_SECTION_FAMILIES.squarePipe },
  { id: 'aluminum-round-bar', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.roundBar',
    load: async () => (await import('../families/aluminumSections.js')).ALUMINUM_SECTION_FAMILIES.roundBar },
  { id: 'aluminum-flat-bar', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.flatBar',
    load: async () => (await import('../families/aluminumSections.js')).ALUMINUM_SECTION_FAMILIES.flatBar },
  { id: 'aluminum-angle', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.angle',
    load: async () => (await import('../families/aluminumSections.js')).ALUMINUM_SECTION_FAMILIES.angle },
];
