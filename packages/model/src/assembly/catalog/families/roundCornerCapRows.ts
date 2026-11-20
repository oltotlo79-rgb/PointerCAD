/**
 * 生成物(手で直さない): 資料 1 の端のキャップのうち、1 つの角が大きな R のフレームに合うキャップの行(外形の四角の左上の角を大きな R にした板)。
 * 担当の道具 make_round_cap_rows.py が、38 回目の 2 本の読み(互いに独立)で外形・左上の R・厚さ・頁・材質・質量が揃い、合うフレームの行と
 * 外形と R が同じ物だけを書いた。2 本目の読みの文字は fixture `roundCornerCapOracle.fixture.json`。製造元の名前・型番は書かない。
 */
import type { FrameCapRecord } from './framePartCatalog.js';

export const ROUND_CORNER_CAP_RECORDS: readonly FrameCapRecord[] = [
  { key: 's6-20x20-r15', size: '端のキャップ 溝幅 6 20×20（1 つの角が R15）', slot: 6, shape: 'r', material: 'nylon', page: 73, width: 20, height: 20,
    thickness: 3, armWidth: null, cornerRadius: 0, largeRadius: 15, massG: 1.2, fitsFrameKeys: ['s6-20x20-r15'], simplified: ['取付けの脚と穴', '角の形'] },
  { key: 's8-30x30-r22', size: '端のキャップ 溝幅 8 30×30（1 つの角が R22）', slot: 8, shape: 'r', material: 'nylon', page: 149, width: 30, height: 30,
    thickness: 3, armWidth: null, cornerRadius: 0, largeRadius: 22, massG: 2.4, fitsFrameKeys: ['s8-30x30-r22'], simplified: ['取付けの脚と穴', '角の形'] },
  { key: 's10-40x40-r32', size: '端のキャップ 溝幅 10 40×40（1 つの角が R32）', slot: 10, shape: 'r', material: 'nylon', page: 243, width: 40, height: 40,
    thickness: 3, armWidth: null, cornerRadius: 0, largeRadius: 32, massG: 4.8, fitsFrameKeys: ['s10-40x40-r32'], simplified: ['取付けの脚と穴', '角の形'] },
  { key: 's10-45x45-r35', size: '端のキャップ 溝幅 10 45×45（1 つの角が R35）', slot: 10, shape: 'r', material: 'nylon', page: 243, width: 45, height: 45,
    thickness: 3, armWidth: null, cornerRadius: 0, largeRadius: 35, massG: 6.1, fitsFrameKeys: ['s10-45x45-r35'], simplified: ['取付けの脚と穴', '角の形'] },
  { key: 's8-60x60-r48', size: '端のキャップ 溝幅 8 60×60（1 つの角が R48）', slot: 8, shape: 'r', material: 'nylon', page: 149, width: 60, height: 60,
    thickness: 3, armWidth: null, cornerRadius: 0, largeRadius: 48, massG: 8.9, fitsFrameKeys: ['s8-60x60-r48'], simplified: ['取付けの脚と穴', '角の形'] },
];
