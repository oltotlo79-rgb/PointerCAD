/**
 * 生成物(手で直さない): 資料 2 のアクセサリの行(外形を包む形。統括の指示 2026-11-18 21:45)。担当の道具 make_connector_rows.py が、
 * 32 回目の読み 2 本で一致した値から書いた。2 本目の文字は fixture `accessoryBoxOracle.fixture.json`。製造元の名前・型番・品名は書かない。
 */
import type { PanelPartRecord } from './panelPartCatalog.js';

export const ACCESSORY_BOX_RECORDS: readonly PanelPartRecord[] = [
  { key: 'slot-assist-13.6x21x50-al-sus', size: '溝の補助具 13.6×21×50（外形を包む形・アルミ・ステンレス）', page: 246, kind: '溝の補助具', material: 'mixed',
    materialText: 'アルミ・ステンレス', width: 13.6, depth: 21, height: 50, massG: 18, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'parts-container-89x92.3x55-resin', size: '部品入れ 89×92.3×55（外形を包む形・樹脂）', page: 251, kind: '部品入れ', material: 'mixed', materialText: '樹脂',
    width: 89, depth: 92.3, height: 55, massG: 51, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'offset-connector-64x25x58-al', size: 'ずらしたつなぎ 64×25×58（外形を包む形・アルミ）', page: 252, kind: 'ずらしたつなぎ', material: 'aluminum', width: 64,
    depth: 25, height: 58, massG: 59, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'cable-lock-17x15x13.2-resin', size: 'ケーブルの留め具 17×15×13.2（外形を包む形・樹脂）', page: 259, kind: 'ケーブルの留め具', material: 'mixed', materialText: '樹脂',
    width: 17, depth: 15, height: 13.2, massG: 2, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'lamp-bracket-48.7x34x45.7-al', size: 'ランプのブラケット 48.7×34×45.7（外形を包む形・アルミ）', page: 259, kind: 'ランプのブラケット', material: 'aluminum',
    width: 48.7, depth: 34, height: 45.7, massG: 67, simplified: ['外形を包む形で、細部は作っていない'] },
];
