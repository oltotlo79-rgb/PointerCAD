/**
 * 生成物(手で直さない): 資料 1 の平らな L 形のアングルブラケットのうち、37 回目の 2 本の読み(互いに独立)で寸法が揃った本体の行。
 * 担当の道具 make_extra_angle_rows.py が書いた。立つ脚の穴は幅の向きの位置の記入が無いので作らず印、寝た脚の厚さは立つ脚の厚さで作り印。
 * 合う溝幅は頁の系列の見出し、質量は資料の値。2 本目の読みの文字は fixture `extraAngleBracketOracle.fixture.json` に書き、検査が照らす。
 * 製造元の名前・型番は書かない。
 */
import type { AngleBracketRecord } from './framePartCatalog.js';

export const EXTRA_ANGLE_BRACKET_RECORDS: readonly AngleBracketRecord[] = [
  { key: 's10-51x40x20-t14-ha1-aluminum', size: 'L 形のブラケット（立つ脚の穴なし） 溝幅 10 51×40×幅 20（厚さ 14・寝た脚の穴 1・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 215, ribbed: false, legA: 51, legB: 40, width: 20, thickness: 14, holeDiameter: 9, alongA: [41],
    acrossA: [10], alongB: [], acrossB: [], massG: 52, simplified: ['立つ脚の穴(幅の向きの位置の記入が無いので作っていない)', '寝た脚の厚さは記入が無いので、立つ脚の厚さで作った'] },
  { key: 's10-51x40x65-t14-ha2-aluminum', size: 'L 形のブラケット（立つ脚の穴なし） 溝幅 10 51×40×幅 65（厚さ 14・寝た脚の穴 2・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 217, ribbed: false, legA: 51, legB: 40, width: 65, thickness: 14, holeDiameter: 9, alongA: [41],
    acrossA: [10, 55], alongB: [], acrossB: [], massG: 182, simplified: ['立つ脚の穴(幅の向きの位置の記入が無いので作っていない)', '寝た脚の厚さは記入が無いので、立つ脚の厚さで作った'] },
  { key: 's10-51x40x25-t14-ha1-aluminum', size: 'L 形のブラケット（立つ脚の穴なし） 溝幅 10 51×40×幅 25（厚さ 14・寝た脚の穴 1・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 216, ribbed: false, legA: 51, legB: 40, width: 25, thickness: 14, holeDiameter: 9, alongA: [41],
    acrossA: [12.5], alongB: [], acrossB: [], massG: 66.9, simplified: ['立つ脚の穴(幅の向きの位置の記入が無いので作っていない)', '寝た脚の厚さは記入が無いので、立つ脚の厚さで作った'] },
  { key: 's10-51x40x70-t14-ha2-aluminum', size: 'L 形のブラケット（立つ脚の穴なし） 溝幅 10 51×40×幅 70（厚さ 14・寝た脚の穴 2・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 216, ribbed: false, legA: 51, legB: 40, width: 70, thickness: 14, holeDiameter: 9, alongA: [41],
    acrossA: [10, 60], alongB: [], acrossB: [], massG: 191, simplified: ['立つ脚の穴(幅の向きの位置の記入が無いので作っていない)', '寝た脚の厚さは記入が無いので、立つ脚の厚さで作った'] },
  { key: 's10-51x51x30-t9-h2-rib-aluminum-sheet', size: 'L 形のブラケット（リブつきの形・摩擦シート付き） 溝幅 10 51×51×幅 30（厚さ 9・穴 2・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 208, ribbed: true, legA: 51, legB: 51, width: 30, thickness: 9, holeDiameter: 9, alongA: [41],
    acrossA: [15], alongB: [41], acrossB: [15], massG: 66, simplified: ['立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '摩擦シート(付属品。形は作っていない)'] },
  { key: 's10-51x51x30-t9-h2-rib-aluminum-antirot', size: 'L 形のブラケット（リブつきの形・回り止め付き） 溝幅 10 51×51×幅 30（厚さ 9・穴 2・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 210, ribbed: true, legA: 51, legB: 51, width: 30, thickness: 9, holeDiameter: 9, alongA: [41],
    acrossA: [15], alongB: [41], acrossB: [15], massG: 67,
    simplified: ['立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '回り止めの突起(寸法の意味が決まらないので形は作っていない)'] },
  { key: 's10-80x80x30-t14-h2-rib-aluminum-antirot', size: 'L 形のブラケット（リブつきの形・回り止め付き） 溝幅 10 80×80×幅 30（厚さ 14・穴 2・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 210, ribbed: true, legA: 80, legB: 80, width: 30, thickness: 14, holeDiameter: 9, alongA: [70],
    acrossA: [15], alongB: [70], acrossB: [15], massG: 156,
    simplified: ['立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '回り止めの突起(寸法の意味が決まらないので形は作っていない)'] },
  { key: 's8-51x51x20-t9-h2-rib-aluminum-sheet', size: 'L 形のブラケット（リブつきの形・摩擦シート付き） 溝幅 8 51×51×幅 20（厚さ 9・穴 2・φ7・アルミ）', slot: 8,
    material: 'aluminum', page: 119, ribbed: true, legA: 51, legB: 51, width: 20, thickness: 9, holeDiameter: 7, alongA: [41],
    acrossA: [10], alongB: [41], acrossB: [10], massG: 44, simplified: ['立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '摩擦シート(付属品。形は作っていない)'] },
];
