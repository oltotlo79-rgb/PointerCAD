/**
 * 生成物(手で直さない): 資料 SF-1 のジョイントバー・スタッド・ローレットナットのうち、8 回目の記入のままの読み 2 本で形の値が同じになった行。
 * 担当の道具 make_fitting_rows.py が書いた(値は読みごとに §6-2 で作り、2 本で同じ物だけ。2 本目の文字は fixture
 * `tSlotFittingOracle.fixture.json` に文字のまま書き、検査が照らす)。製造元の名前・型番は書かない。
 */
import type { JointBarRecord, KnurledNutRecord, StudRecord } from './tSlotFittingCatalog.js';

export const JOINT_BAR_RECORDS: readonly JointBarRecord[] = [
  { key: 's6-120x10x4.1-m5x4-steel', size: 'ジョイントバー 溝幅 6 120×10×4.1（めねじ M5×4・鋼）', slot: 6, material: 'steel', page: 72, length: 120,
    width: 10, thickness: 4.1, neckWidth: 5.8, thread: 'M5', holeOffsets: [10, 50, 70, 110], massG: 25,
    simplified: ['首の段(記入が無いので作らず包んだ)', 'ねじの山'] },
  { key: 's8-140x15x6.3-m6x4-steel', size: 'ジョイントバー 溝幅 8 140×15×6.3（めねじ M6×4・鋼）', slot: 8, material: 'steel', page: 146, length: 140,
    width: 15, thickness: 6.3, neckWidth: 7.8, thread: 'M6', holeOffsets: [10, 60, 80, 130], massG: 86,
    simplified: ['首の段(記入が無いので作らず包んだ)', 'ねじの山'] },
  { key: 's10-200x17x9-m8x4-steel', size: 'ジョイントバー 溝幅 10 200×17×9（めねじ M8×4・鋼）', slot: 10, material: 'steel', page: 240, length: 200,
    width: 17, thickness: 9, neckWidth: 9.8, thread: 'M8', holeOffsets: [15, 85, 115, 185], massG: 169,
    simplified: ['首の段(記入が無いので作らず包んだ)', 'ねじの山'] },
  { key: 's6-120x10x4.1-m5x4-stainless', size: 'ジョイントバー 溝幅 6 120×10×4.1（めねじ M5×4・ステンレス）', slot: 6, material: 'stainless', page: 72,
    length: 120, width: 10, thickness: 4.1, neckWidth: 5.8, thread: 'M5', holeOffsets: [10, 50, 70, 110], massG: 29.3,
    simplified: ['首の段(記入が無いので作らず包んだ)', 'ねじの山'] },
  { key: 's8-140x15x6.3-m6x4-stainless', size: 'ジョイントバー 溝幅 8 140×15×6.3（めねじ M6×4・ステンレス）', slot: 8, material: 'stainless', page: 146,
    length: 140, width: 15, thickness: 6.3, neckWidth: 7.8, thread: 'M6', holeOffsets: [10, 60, 80, 130], massG: 87,
    simplified: ['首の段(記入が無いので作らず包んだ)', 'ねじの山'] },
  { key: 's10-200x17x9-m8x4-stainless', size: 'ジョイントバー 溝幅 10 200×17×9（めねじ M8×4・ステンレス）', slot: 10, material: 'stainless', page: 240,
    length: 200, width: 17, thickness: 9, neckWidth: 9.8, thread: 'M8', holeOffsets: [15, 85, 115, 185], massG: 174,
    simplified: ['首の段(記入が無いので作らず包んだ)', 'ねじの山'] },
];

export const STUD_RECORDS: readonly StudRecord[] = [
  { key: 's10-19.8x10-m5-l17.5-steel', size: 'スタッド 溝幅 10 板 19.8×10×2（おねじ M5×17.5・鋼）', slot: 10, material: 'steel', page: 240, width: 19.8,
    depth: 10, plateThickness: 2, thread: 'M5', threadLength: 17.5, massG: 5, simplified: ['中央の張り出し(幅の記入が無いので作っていない)', 'ねじの山', '頭の角の面取り'] },
  { key: 's8-16.3x7.8-m5-l15.5-steel', size: 'スタッド 溝幅 8 板 16.3×7.8×2（おねじ M5×15.5・鋼）', slot: 8, material: 'steel', page: 146, width: 16.3,
    depth: 7.8, plateThickness: 2, thread: 'M5', threadLength: 15.5, massG: 4, simplified: ['中央の張り出し(幅の記入が無いので作っていない)', 'ねじの山'] },
];

export const KNURLED_NUT_RECORDS: readonly KnurledNutRecord[] = [
  { key: 's8-d12-h9-m5-brass', size: 'ローレットナット 溝幅 8 φ12×9（めねじ M5・黄銅）', slot: 8, material: 'brass', page: 146, diameter: 12,
    flangeDiameter: 11, height: 9, thread: 'M5', massG: 6, simplified: ['段の高さ(記入が無いので、太い段の径の円柱で包んだ)', 'ローレットの刻み', 'ねじの山'] },
];
