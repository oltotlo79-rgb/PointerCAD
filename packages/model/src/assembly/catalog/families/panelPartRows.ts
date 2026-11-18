/**
 * 生成物(手で直さない): 資料 2 のパネル扉の部品とパネル用のフレームの行(外形を包む形。統括の決定 2026-11-18 14:1x の (1))。
 * 担当の道具 make_panel_part_rows.py が、17 回目の読み 2 本で一致した値から書いた。2 本目の文字は fixture `panelPartOracle.fixture.json`。
 * 製造元の名前・型番・商品名は書かない。
 */
import type { PanelCoverFrameRecord, PanelPartRecord } from './panelPartCatalog.js';

export const PANEL_PART_RECORDS: readonly PanelPartRecord[] = [
  { key: 'board-holder-23.8x20x30.5', size: '板の押さえ 23.8×20×30.5（外形を包む形・アルミ）', page: 268, kind: '板の押さえ', material: 'aluminum', width: 23.8,
    depth: 20, height: 30.5, massG: 18, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'flat-connector-m5-28x20x28', size: '平たいつなぎ M5 28×20×28（外形を包む形・アルミ・鉄）', page: 268, kind: '平たいつなぎ', material: 'mixed',
    materialText: 'アルミ・鉄', width: 28, depth: 20, height: 28, massG: 37, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'flat-connector-m6-28x20x28', size: '平たいつなぎ M6 28×20×28（外形を包む形・アルミ・鉄）', page: 268, kind: '平たいつなぎ', material: 'mixed',
    materialText: 'アルミ・鉄', width: 28, depth: 20, height: 28, massG: 36, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'flat-connector-d4.5-28x20x28', size: '平たいつなぎ φ4.5 28×20×28（外形を包む形・アルミ・鉄）', page: 268, kind: '平たいつなぎ', material: 'mixed',
    materialText: 'アルミ・鉄', width: 28, depth: 20, height: 28, massG: 37, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'flat-connector-d6.5-28x20x28', size: '平たいつなぎ φ6.5 28×20×28（外形を包む形・アルミ・鉄）', page: 268, kind: '平たいつなぎ', material: 'mixed',
    materialText: 'アルミ・鉄', width: 28, depth: 20, height: 28, massG: 36, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'hinge-57x54.5x82.6', size: 'ヒンジ 57×54.5×82.6（外形を包む形・アルミ・ステンレス・鉄）', page: 270, kind: 'ヒンジ', material: 'mixed', materialText: 'アルミ・ステンレス・鉄',
    width: 57, depth: 54.5, height: 82.6, massG: 123, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'hinge-52x54.5x82.5', size: 'ヒンジ 52×54.5×82.5（外形を包む形・アルミ・ステンレス・鉄）', page: 270, kind: 'ヒンジ', material: 'mixed', materialText: 'アルミ・ステンレス・鉄',
    width: 52, depth: 54.5, height: 82.5, massG: 144, simplified: ['外形を包む形で、細部は作っていない'] },
];

export const PANEL_COVER_FRAME_RECORDS: readonly PanelCoverFrameRecord[] = [
  { key: 'cover-frame-44x33', size: 'パネル用のフレーム 44×33（外形を包む形）', page: 276, width: 44, height: 33, unitMassKgPerM: 0.58,
    simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cover-frame-60x33', size: 'パネル用のフレーム 60×33（外形を包む形）', page: 276, width: 60, height: 33, unitMassKgPerM: 0.67,
    simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cover-frame-49x49', size: 'パネル用のフレーム 49×49（外形を包む形）', page: 276, width: 49, height: 49, unitMassKgPerM: 0.82,
    simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cover-frame-63x63', size: 'パネル用のフレーム 63×63（外形を包む形）', page: 276, width: 63, height: 63, unitMassKgPerM: 1.14,
    simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cover-frame-49x38', size: 'パネル用のフレーム 49×38（外形を包む形）', page: 276, width: 49, height: 38, unitMassKgPerM: 0.97,
    simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cover-frame-60x38', size: 'パネル用のフレーム 60×38（外形を包む形）', page: 276, width: 60, height: 38, unitMassKgPerM: 0.97,
    simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cover-frame-68x68', size: 'パネル用のフレーム 68×68（外形を包む形）', page: 276, width: 68, height: 68, unitMassKgPerM: 1.66,
    simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cover-frame-98x68', size: 'パネル用のフレーム 98×68（外形を包む形）', page: 276, width: 98, height: 68, unitMassKgPerM: 2.04,
    simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cover-frame-98x98', size: 'パネル用のフレーム 98×98（外形を包む形）', page: 276, width: 98, height: 98, unitMassKgPerM: 2.46,
    simplified: ['外形を包む形で、細部は作っていない'] },
];
