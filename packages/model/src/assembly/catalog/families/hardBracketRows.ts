/**
 * 生成物(手で直さない): 資料 SF-1 のリブつきの L 形のブラケットのうち、寝た脚の穴の幅の向きの位置の記入が無いので、寝た脚の穴を作らない行
 * (統括の決定 2026-11-18 08:4x の (B))。担当の道具 make_hard_bracket_rows.py が、9 回目と 10 回目の読みの 2 つの組から §6-2 で作り、2 つで同じ物だけを書いた。
 * 2 つ目の組の文字は fixture `hardBracketOracle.fixture.json` に文字のまま書き、検査が照らす。製造元の名前・型番は書かない。
 */
import type { AngleBracketRecord } from './framePartCatalog.js';

export const HARD_BRACKET_RECORDS: readonly AngleBracketRecord[] = [
  { key: 's10-80x80x70-t14-hb4-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 10 80×80×幅 70（厚さ 14・立つ脚の穴 4・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 214, ribbed: true, legA: 80, legB: 80, width: 70, thickness: 14, holeDiameter: 9, alongA: [], acrossA: [],
    alongB: [24, 70], acrossB: [15, 55], massG: 327,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '角の側面の穴'] },
  { key: 's10-80x80x75-t14-hb4-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 10 80×80×幅 75（厚さ 14・立つ脚の穴 4・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 214, ribbed: true, legA: 80, legB: 80, width: 75, thickness: 14, holeDiameter: 9, alongA: [], acrossA: [],
    alongB: [24, 70], acrossB: [15, 60], massG: 353,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '角の側面の穴'] },
  { key: 's10-80x80x80-t14-hb4-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 10 80×80×幅 80（厚さ 14・立つ脚の穴 4・φ9・アルミ）', slot: 10,
    material: 'aluminum', page: 214, ribbed: true, legA: 80, legB: 80, width: 80, thickness: 14, holeDiameter: 9, alongA: [], acrossA: [],
    alongB: [24, 70], acrossB: [15, 65], massG: 375,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '角の側面の穴'] },
];
