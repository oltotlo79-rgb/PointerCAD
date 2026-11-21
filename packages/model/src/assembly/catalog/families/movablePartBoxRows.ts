/**
 * 生成物(手で直さない): 資料 2 の可動の部品の行(外形を包む形。統括の指示 2026-11-18 21:31・21:47。動く仕組みは作らない)。担当の道具 make_connector_rows.py が、
 * 30・31 回目の読み 2 本で一致した値から書いた。2 本目の文字は fixture `movablePartBoxOracle.fixture.json`。製造元の名前・型番・品名は書かない。
 */
import type { PanelPartRecord } from './panelPartCatalog.js';

export const MOVABLE_PART_BOX_RECORDS: readonly PanelPartRecord[] = [
  { key: 'hinge-connector-43x37x43-al-resin', size: '蝶番のつなぎ 43×37×43（外形を包む形・アルミ・樹脂）', page: 120, kind: '蝶番のつなぎ', material: 'mixed',
    materialText: 'アルミ・樹脂', width: 43, depth: 37, height: 43, massG: 31, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'hinge-connector-43x55x43-al-resin', size: '蝶番のつなぎ 43×55×43（外形を包む形・アルミ・樹脂）', page: 120, kind: '蝶番のつなぎ', material: 'mixed',
    materialText: 'アルミ・樹脂', width: 43, depth: 55, height: 43, massG: 45, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'hinge-connector-50x37x50-al-resin', size: '蝶番のつなぎ 50×37×50（外形を包む形・アルミ・樹脂）', page: 120, kind: '蝶番のつなぎ', material: 'mixed',
    materialText: 'アルミ・樹脂', width: 50, depth: 37, height: 50, massG: 62, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'hinge-stopper-47.5x12x43-al-sus-fe', size: '蝶番のつなぎの止め 47.5×12×43（外形を包む形・アルミ・ステンレス・鉄）', page: 121, kind: '蝶番のつなぎの止め', material: 'mixed',
    materialText: 'アルミ・ステンレス・鉄', width: 47.5, depth: 12, height: 43, massG: 33, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'linear-bushing-28x58x28-al-fe', size: '直動の軸受 28×58×28（外形を包む形・アルミ・鉄）', page: 127, kind: '直動の軸受', material: 'mixed', materialText: 'アルミ・鉄',
    width: 28, depth: 58, height: 28, massG: 91, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'slide-connector-43x37x43-al', size: '滑るつなぎ 43×37×43（外形を包む形・アルミ）', page: 128, kind: '滑るつなぎ', material: 'aluminum', width: 43, depth: 37,
    height: 43, massG: 35, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'slide-connector-43x55x43-al', size: '滑るつなぎ 43×55×43（外形を包む形・アルミ）', page: 128, kind: '滑るつなぎ', material: 'aluminum', width: 43, depth: 55,
    height: 43, massG: 48, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'slide-connector-50x37x50-al', size: '滑るつなぎ 50×37×50（外形を包む形・アルミ）', page: 128, kind: '滑るつなぎ', material: 'aluminum', width: 50, depth: 37,
    height: 50, massG: 70, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'linear-bushing-47.5x42.8x43-al-resin-fe', size: '直動の軸受 47.5×42.8×43（外形を包む形・アルミ・樹脂・鉄）', page: 129, kind: '直動の軸受', material: 'mixed',
    materialText: 'アルミ・樹脂・鉄', width: 47.5, depth: 42.8, height: 43, massG: 61, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'wire-lock-connector-23.5x27x24-al', size: 'ワイヤーを留めるつなぎ 23.5×27×24（外形を包む形・アルミ）', page: 134, kind: 'ワイヤーを留めるつなぎ', material: 'aluminum',
    width: 23.5, depth: 27, height: 24, massG: 26, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'hinge-connector-28x27x28-al', size: '蝶番のつなぎ 28×27×28（外形を包む形・アルミ）', page: 304, kind: '蝶番のつなぎ', material: 'aluminum', width: 28, depth: 27,
    height: 28, massG: 12, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'slide-connector-28x27x28-al', size: '滑るつなぎ 28×27×28（外形を包む形・アルミ）', page: 304, kind: '滑るつなぎ', material: 'aluminum', width: 28, depth: 27,
    height: 28, massG: 13, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
  { key: 'hinge-stopper-34.5x10x28-al-fe', size: '蝶番のつなぎの止め 34.5×10×28（外形を包む形・アルミ・鉄）', page: 305, kind: '蝶番のつなぎの止め', material: 'mixed',
    materialText: 'アルミ・鉄', width: 34.5, depth: 10, height: 28, massG: 13, simplified: ['外形を包む形で、細部は作っていない', '動く仕組みは作っていない'] },
];
