/**
 * 生成物(手で直さない): 資料 1 の長方形の板(アジャスタプレート・アジャスタキャスタープレート)のうち、39 回目の 2 本の読み(互いに独立)で
 * 外形・穴の並び・材質・質量が揃った型番の行。担当の道具 make_extra_plate_rows.py が、穴の位置の鎖を読み解いて 2 本で照らして書いた。
 * めねじは作らず印。質量は資料の値が形 × 密度と 10% 以内の時だけ(ほかは null で、部品表は形 × 密度)。
 * 2 本目の読みの文字は fixture `extraFootBaseOracle.fixture.json` に書き、検査が照らす。製造元の名前・型番は書かない。
 */
import type { FootBaseRecord } from './framePartCatalog.js';

export const EXTRA_FOOT_BASE_RECORDS: readonly FootBaseRecord[] = [
  { key: 'adjuster-166x125x9-h8-d7-steel', size: 'アジャスターベース（キャスターも付けられる板） 166×125×9（取付け穴 8・φ7・鋼）', slot: 0, material: 'steel', page: 153,
    kind: 'アジャスターベース', width: 166, depth: 125, thickness: 9,
    holes: [[14, 95, 7], [14, 115, 7], [34, 95, 7], [34, 115, 7], [96, 14, 7], [96, 34, 7], [156, 14, 7], [156, 34, 7]], massG: null,
    simplified: ['アジャスターのめねじ'] },
  { key: 'adjuster-166x125x9-h5-d14-9-steel', size: 'アジャスターベース（キャスターも付けられる板） 166×125×9（取付け穴 5・φ14・φ9・鋼）', slot: 0, material: 'steel', page: 248,
    kind: 'アジャスターベース', width: 166, depth: 125, thickness: 9, holes: [[20, 15, 9], [20, 60, 9], [20, 105, 14], [65, 105, 9], [151, 105, 9]],
    massG: null, simplified: ['アジャスターのめねじ'] },
  { key: 'adjuster-166x125x9-h5-d14-9-stainless', size: 'アジャスターベース（キャスターも付けられる板） 166×125×9（取付け穴 5・φ14・φ9・ステンレス）', slot: 0, material: 'stainless',
    page: 248, kind: 'アジャスターベース', width: 166, depth: 125, thickness: 9,
    holes: [[20, 15, 9], [20, 60, 9], [20, 105, 14], [65, 105, 9], [151, 105, 9]], massG: null, simplified: ['アジャスターのめねじ'] },
  { key: 'adjuster-150x150x12-h10-d9-steel', size: 'アジャスターベース（キャスターも付けられる板） 150×150×12（取付け穴 10・φ9・鋼）', slot: 0, material: 'steel', page: 248,
    kind: 'アジャスターベース', width: 150, depth: 150, thickness: 12,
    holes: [[15, 15, 9], [15, 55, 9], [15, 95, 9], [55, 15, 9], [55, 55, 9], [55, 135, 9], [95, 95, 9], [95, 135, 9], [135, 95, 9], [135, 135, 9]],
    massG: 2000, simplified: ['アジャスターのめねじ'] },
  { key: 'adjuster-150x150x12-h10-d9-stainless', size: 'アジャスターベース（キャスターも付けられる板） 150×150×12（取付け穴 10・φ9・ステンレス）', slot: 0, material: 'stainless',
    page: 248, kind: 'アジャスターベース', width: 150, depth: 150, thickness: 12,
    holes: [[15, 15, 9], [15, 55, 9], [15, 95, 9], [55, 15, 9], [55, 55, 9], [55, 135, 9], [95, 95, 9], [95, 135, 9], [135, 95, 9], [135, 135, 9]],
    massG: 2020, simplified: ['アジャスターのめねじ'] },
];
