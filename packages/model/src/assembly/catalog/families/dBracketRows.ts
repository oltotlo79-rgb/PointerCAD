/**
 * 生成物(手で直さない): 資料 1 のダイカストのリブつきの L 形のブラケットの本体のうち、2 本の読みで形の欄が一致した行。
 * 寝た脚の穴の幅の向きの位置の記入が無いので、寝た脚の穴は作らない(統括の決定 2026-11-18 08:4x の (B) と同じ形)。
 * 担当の道具 make_d_bracket_rows.py が、33 回目の読みの 2 本から §6-2 で読みごとに作り、2 つで同じ物だけを書いた。
 * 2 本目の読みの文字は fixture `dBracketOracle.fixture.json` に文字のまま書き、検査が照らす。製造元の名前・型番は書かない。
 */
import type { AngleBracketRecord } from './framePartCatalog.js';

export const D_BRACKET_RECORDS: readonly AngleBracketRecord[] = [
  { key: 's6-28x28x12-t4.5-hb1-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 6 28×28×幅 12（厚さ 4.5・立つ脚の穴 1・φ5.2・アルミ）', slot: 6,
    material: 'aluminum', page: 50, ribbed: true, legA: 28, legB: 28, width: 12, thickness: 4.5, holeDiameter: 5.2, alongA: [],
    acrossA: [], alongB: [21], acrossB: [7], massG: 11,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '側面のめねじ(タップ付きの品だけにある。作っていない)'] },
  { key: 's6-35x35x34-t5-hb2-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 6 35×35×幅 34（厚さ 5・立つ脚の穴 2・φ5.7・アルミ）', slot: 6,
    material: 'aluminum', page: 52, ribbed: true, legA: 35, legB: 35, width: 34, thickness: 5, holeDiameter: 5.7, alongA: [], acrossA: [],
    alongB: [30], acrossB: [7, 27], massG: 34,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '側面のめねじ(タップ付きの品だけにある。作っていない)'] },
  { key: 's8-28x28x20-t4.5-hb1-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 8 28×28×幅 20（厚さ 4.5・立つ脚の穴 1・φ6.3・アルミ）', slot: 8,
    material: 'aluminum', page: 114, ribbed: true, legA: 28, legB: 28, width: 20, thickness: 4.5, holeDiameter: 6.3, alongA: [],
    acrossA: [], alongB: [20], acrossB: [10], massG: 13,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '側面のめねじ(タップ付きの品だけにある。作っていない)'] },
  { key: 's8-45x45x50-t9-hb2-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 8 45×45×幅 50（厚さ 9・立つ脚の穴 2・φ6.5・アルミ）', slot: 8,
    material: 'aluminum', page: 116, ribbed: true, legA: 45, legB: 45, width: 50, thickness: 9, holeDiameter: 6.5, alongA: [], acrossA: [],
    alongB: [35], acrossB: [10, 40], massG: 100,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '側面のめねじ(タップ付きの品だけにある。作っていない)'] },
  { key: 's8-55x55x50-t5-hb4-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 8 55×55×幅 50（厚さ 5・立つ脚の穴 4・φ6.5・アルミ）', slot: 8,
    material: 'aluminum', page: 116, ribbed: true, legA: 55, legB: 55, width: 50, thickness: 5, holeDiameter: 6.5, alongA: [], acrossA: [],
    alongB: [15, 45], acrossB: [10, 40], massG: 65,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '側面のめねじ(タップ付きの品だけにある。作っていない)'] },
  { key: 's10-43x43x30-t9-hb1-rib-aluminum', size: 'L 形のブラケット（リブつきの形・寝た脚の穴なし） 溝幅 10 43×43×幅 30（厚さ 9・立つ脚の穴 1・φ8.2・アルミ）', slot: 10,
    material: 'aluminum', page: 204, ribbed: true, legA: 43, legB: 43, width: 30, thickness: 9, holeDiameter: 8.2, alongA: [], acrossA: [],
    alongB: [30], acrossB: [15], massG: 53.3,
    simplified: ['寝た脚の穴(幅の向きの位置の記入が無いので作っていない)', '立つ脚の厚さは記入が無いので、寝た脚の厚さで作った', 'リブ', '補強の抜き穴(記入が無いので作っていない)', '回り止めの突起', '側面のめねじ(タップ付きの品だけにある。作っていない)'] },
];
