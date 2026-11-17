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
  // 資料 SF-1 で寸法が確認できるフレームの部品(ナットの素材・ナット・丸ナット・端のキャップ・平板のブラケット)。2 回以上の読みで要る欄が一致した行だけを持つ。
  { id: 't-slot-nut-bar', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.nutBar',
    load: async () => (await import('../families/framePartCatalog.js')).T_SLOT_NUT_BAR_FAMILY },
  { id: 't-slot-nut', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.catalogNut',
    load: async () => (await import('../families/framePartCatalog.js')).T_SLOT_NUT_FAMILY },
  { id: 't-slot-round-nut', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.roundNut',
    load: async () => (await import('../families/framePartCatalog.js')).ROUND_NUT_FAMILY },
  { id: 't-slot-frame-cap', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.cap',
    load: async () => (await import('../families/framePartCatalog.js')).FRAME_CAP_FAMILY },
  { id: 't-slot-flat-plate', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.flatPlate',
    load: async () => (await import('../families/framePartCatalog.js')).FLAT_PLATE_FAMILY },
  { id: 't-slot-shaped-plate', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.shapedPlate',
    load: async () => (await import('../families/framePartCatalog.js')).SHAPED_PLATE_FAMILY },
  { id: 't-slot-angle-bracket', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.angleBracketCatalog',
    load: async () => (await import('../families/framePartCatalog.js')).ANGLE_BRACKET_CATALOG_FAMILY },
  { id: 't-slot-foot-base', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.footBase',
    load: async () => (await import('../families/framePartCatalog.js')).FOOT_BASE_FAMILY },
  { id: 't-slot-adjuster', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.adjuster',
    load: async () => (await import('../families/framePartCatalog.js')).ADJUSTER_FAMILY },
  // 資料 GF-2 のパイプ形のフレーム(1 本・溝つき・2 本つなぎ)。独立の読みの 2 つ以上が一致した行だけ。形は記入のある寸法だけで作る包む形。
  { id: 'pipe-frame', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.pipeFrame',
    load: async () => (await import('../families/pipeFrameCatalog.js')).PIPE_FRAME_FAMILIES.single },
  { id: 'pipe-frame-slotted', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.pipeFrameSlotted',
    load: async () => (await import('../families/pipeFrameCatalog.js')).PIPE_FRAME_FAMILIES.slotted },
  { id: 'pipe-frame-twin', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.pipeFrameTwin',
    load: async () => (await import('../families/pipeFrameCatalog.js')).PIPE_FRAME_FAMILIES.twin },
  // 資料 SF-1 の共通パーツの頁(PDF 337〜339)の小さい溝つきフレーム・その端のキャップ・ブラケット素材。2 本の読みが一致した行だけ。
  { id: 't-slot-frame-small', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.smallFrame',
    load: async () => (await import('../families/smallFrameCatalog.js')).SMALL_T_SLOT_FRAME_FAMILY },
  { id: 't-slot-frame-cap-small', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.smallFrameCap',
    load: async () => (await import('../families/smallFrameCatalog.js')).SMALL_FRAME_CAP_FAMILY },
  { id: 'bracket-stock', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.bracketStock',
    load: async () => (await import('../families/smallFrameCatalog.js')).BRACKET_STOCK_FAMILY },
  // 資料 GF-2 のパイプ形のフレームのキャップとフット(段の並びの部品)。2 本の独立の読みで段が一致した行だけ。
  { id: 'pipe-frame-cap', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.pipeFrameCap',
    load: async () => (await import('../families/pipeFramePartCatalog.js')).PIPE_FRAME_CAP_FAMILY },
  { id: 'pipe-frame-foot', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.pipeFrameFoot',
    load: async () => (await import('../families/pipeFramePartCatalog.js')).PIPE_FRAME_FOOT_FAMILY },
];
