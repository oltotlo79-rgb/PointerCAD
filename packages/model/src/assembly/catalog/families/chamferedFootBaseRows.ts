/**
 * 生成物(手で直さない): 資料 1 の左右上の角を斜めに切った板(汎用のキャスターの板)のうち、39 回目の 2 本の読み(互いに独立)で
 * 外形・穴・材質・質量が揃った型番の行。担当の道具 make_chamfer_plate_rows.py が書いた。外形は左の斜辺 45°(上辺の鎖の左の数 = 縦 − 左の短辺)、
 * 右の斜辺は上辺の鎖の閉じ(横 − 左の数 − 間の数)が左と同じ時だけ左の鏡。穴の横の位置は斜辺からの法線の距離 n から x = y − 左の短辺 + n√2
 * (右は鏡。0.001 mm に丸めた)。めねじ(キャスターを付ける所)は作らず印。質量は資料の値が形 × 密度と 10% 以内の時だけ。
 * 2 本目の読みの文字は fixture `chamferedFootBaseOracle.fixture.json` に書き、検査が照らす。製造元の名前・型番は書かない。
 */
import type { FootBaseRecord } from './framePartCatalog.js';

export const CHAMFERED_FOOT_BASE_RECORDS: readonly FootBaseRecord[] = [
  { key: 'caster-plate-240x60x6-c53-h4-d5.5-steel', size: 'キャスターの板 240×60×6（上の角の斜め切り 53・取付け穴 4・φ5.5・鋼）', slot: 0, material: 'steel', page: 75,
    kind: 'キャスターの板', width: 240, depth: 60, thickness: 6, outline: [[0, 0], [240, 0], [240, 7], [187, 60], [53, 60], [0, 7]],
    holes: [[14.314, 10, 5.5], [54.314, 50, 5.5], [185.686, 50, 5.5], [225.686, 10, 5.5]], massG: 523, simplified: ['キャスターを付けるめねじ'] },
  { key: 'caster-plate-240x60x6-c53-h4-d5.5-stainless', size: 'キャスターの板 240×60×6（上の角の斜め切り 53・取付け穴 4・φ5.5・ステンレス）', slot: 0, material: 'stainless',
    page: 75, kind: 'キャスターの板', width: 240, depth: 60, thickness: 6, outline: [[0, 0], [240, 0], [240, 7], [187, 60], [53, 60], [0, 7]],
    holes: [[14.314, 10, 5.5], [54.314, 50, 5.5], [185.686, 50, 5.5], [225.686, 10, 5.5]], massG: 510, simplified: ['キャスターを付けるめねじ'] },
  { key: 'caster-plate-260x60x9-c49-h4-d7-steel', size: 'キャスターの板 260×60×9（上の角の斜め切り 49・取付け穴 4・φ7・鋼）', slot: 0, material: 'steel', page: 151,
    kind: 'キャスターの板', width: 260, depth: 60, thickness: 9, outline: [[0, 0], [260, 0], [260, 11], [211, 60], [49, 60], [0, 11]],
    holes: [[14.556, 10, 7], [54.556, 50, 7], [205.444, 50, 7], [245.444, 10, 7]], massG: 900, simplified: ['キャスターを付けるめねじ'] },
  { key: 'caster-plate-260x60x9-c49-h4-d7-stainless', size: 'キャスターの板 260×60×9（上の角の斜め切り 49・取付け穴 4・φ7・ステンレス）', slot: 0, material: 'stainless',
    page: 151, kind: 'キャスターの板', width: 260, depth: 60, thickness: 9, outline: [[0, 0], [260, 0], [260, 11], [211, 60], [49, 60], [0, 11]],
    holes: [[14.556, 10, 7], [54.556, 50, 7], [205.444, 50, 7], [245.444, 10, 7]], massG: 909, simplified: ['キャスターを付けるめねじ'] },
  { key: 'caster-plate-320x90x12-c74-h4-d9-steel', size: 'キャスターの板 320×90×12（上の角の斜め切り 74・取付け穴 4・φ9・鋼）', slot: 0, material: 'steel', page: 246,
    kind: 'キャスターの板', width: 320, depth: 90, thickness: 12, outline: [[0, 0], [320, 0], [320, 16], [246, 90], [74, 90], [0, 16]],
    holes: [[20.213, 15, 9], [80.213, 75, 9], [239.787, 75, 9], [299.787, 15, 9]], massG: 2100, simplified: ['キャスターを付けるめねじ'] },
  { key: 'caster-plate-320x90x12-c74-h4-d9-stainless', size: 'キャスターの板 320×90×12（上の角の斜め切り 74・取付け穴 4・φ9・ステンレス）', slot: 0, material: 'stainless',
    page: 246, kind: 'キャスターの板', width: 320, depth: 90, thickness: 12, outline: [[0, 0], [320, 0], [320, 16], [246, 90], [74, 90], [0, 16]],
    holes: [[20.213, 15, 9], [80.213, 75, 9], [239.787, 75, 9], [299.787, 15, 9]], massG: 2100, simplified: ['キャスターを付けるめねじ'] },
];
