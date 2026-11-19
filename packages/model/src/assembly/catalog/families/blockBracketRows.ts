/**
 * 生成物(手で直さない): 資料 1 のブロック形のブラケット(直方体 + 上の面と前の面の座ぐり穴)のうち、37 回目の 2 本の読み(互いに独立)で
 * 外形・穴・座ぐり・合う溝幅(頁の見出し)・質量が揃った本体の行。担当の道具 make_block_rows.py が書いた。
 * 2 本目の読みの文字は fixture `blockBracketOracle.fixture.json` に書き、検査が照らす。製造元の名前・型番は書かない。
 */
import type { BlockBracketRecord } from './blockBracketCatalog.js';

export const BLOCK_BRACKET_RECORDS: readonly BlockBracketRecord[] = [
  { key: 's10-30x40x40-h2-aluminum', size: 'ブロック形のブラケット 溝幅 10 30×40×高さ 40（穴 2・φ9・座ぐり φ14・アルミ）', slot: 10, material: 'aluminum', page: 215,
    width: 30, depth: 40, height: 40, massG: 103, simplified: [],
    holes: [
      { face: 'top', u: 15, v: 10, diameter: 9, counterbore: { diameter: 14, depth: 34 } },
      { face: 'front', u: 15, v: 20, diameter: 9, counterbore: { diameter: 14, depth: 34 } },
    ] },
  { key: 's10-30x40x50-h2-aluminum', size: 'ブロック形のブラケット 溝幅 10 30×40×高さ 50（穴 2・φ9・座ぐり φ15・アルミ）', slot: 10, material: 'aluminum', page: 215,
    width: 30, depth: 40, height: 50, massG: 135, simplified: [],
    holes: [
      { face: 'top', u: 15, v: 17.5, diameter: 9, counterbore: { diameter: 15, depth: 36 } },
      { face: 'front', u: 15, v: 41, diameter: 9, counterbore: { diameter: 15, depth: 26 } },
    ] },
  { key: 's10-30x40x55-h2-aluminum', size: 'ブロック形のブラケット 溝幅 10 30×40×高さ 55（穴 2・φ9・座ぐり φ15・アルミ）', slot: 10, material: 'aluminum', page: 216,
    width: 30, depth: 40, height: 55, massG: 149, simplified: [],
    holes: [
      { face: 'top', u: 15, v: 15, diameter: 9, counterbore: { diameter: 15, depth: 41 } },
      { face: 'front', u: 15, v: 41, diameter: 9, counterbore: { diameter: 15, depth: 26 } },
    ] },
];
