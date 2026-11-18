/**
 * 生成物(手で直さない): 資料 2 のキャップと足の部品の行(外形を包む形。統括の決定 2026-11-18 14:4x の (3)・16:2x)。担当の道具 make_connector_rows.py が、
 * 21 回目の読み 2 本で一致した値から書いた。2 本目の文字は fixture `capFootBoxOracle.fixture.json`。製造元の名前・型番・品名は書かない。
 */
import type { PanelPartRecord } from './panelPartCatalog.js';

export const CAP_FOOT_BOX_RECORDS: readonly PanelPartRecord[] = [
  { key: 'pipe-stand-103.5x103.5x104-resin', size: 'パイプのスタンド 103.5×103.5×104（外形を包む形・樹脂）', page: 96, kind: 'パイプのスタンド', material: 'mixed',
    materialText: '樹脂', width: 103.5, depth: 103.5, height: 104, massG: 297, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'pipe-stand-103.5x37x104-resin', size: 'パイプのスタンド 103.5×37×104（外形を包む形・樹脂）', page: 96, kind: 'パイプのスタンド', material: 'mixed',
    materialText: '樹脂', width: 103.5, depth: 37, height: 104, massG: 227, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'pipe-stand-170x103.5x104-resin', size: 'パイプのスタンド 170×103.5×104（外形を包む形・樹脂）', page: 96, kind: 'パイプのスタンド', material: 'mixed',
    materialText: '樹脂', width: 170, depth: 103.5, height: 104, massG: 372, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'pipe-stand-170x37x104-resin', size: 'パイプのスタンド 170×37×104（外形を包む形・樹脂）', page: 96, kind: 'パイプのスタンド', material: 'mixed', materialText: '樹脂',
    width: 170, depth: 37, height: 104, massG: 285, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'anchor-bracket-105.4x38x150-al', size: '床留めのブラケット 105.4×38×150（外形を包む形・アルミ）', page: 97, kind: '床留めのブラケット', material: 'aluminum',
    width: 105.4, depth: 38, height: 150, massG: 271, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'base-stand-185x38x70-al-fe', size: '台のスタンド 185×38×70（外形を包む形・アルミ・鉄）', page: 97, kind: '台のスタンド', material: 'mixed', materialText: 'アルミ・鉄',
    width: 185, depth: 38, height: 70, massG: 411, simplified: ['外形を包む形で、細部は作っていない'] },
  { key: 'stand-connector-71.8x33x49-al', size: 'スタンドのつなぎ 71.8×33×49（外形を包む形・アルミ）', page: 97, kind: 'スタンドのつなぎ', material: 'aluminum', width: 71.8,
    depth: 33, height: 49, massG: 83, simplified: ['外形を包む形で、細部は作っていない'] },
];
