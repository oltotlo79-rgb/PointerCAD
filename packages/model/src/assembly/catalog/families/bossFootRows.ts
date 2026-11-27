/**
 * 生成物(手で直さない): 資料 1 のボス付きのベースの板の行(取付け穴は作らず印。統括の決定 2026-11-18 13:4x の (1))。担当の道具 make_boss_rows.py が、
 * 7 回目と 16 回目の読みの 2 組から作り、2 組で同じ物だけを書いた。2 つ目の組の文字は fixture `bossFootOracle.fixture.json`。製造元の名前・型番は書かない。
 */
import type { FootBaseRecord } from './framePartCatalog.js';

export const BOSS_FOOT_RECORDS: readonly FootBaseRecord[] = [
  { key: 'base-75x75x10-boss25-aluminum', size: 'ベースの板 75×75×10（ボス φ25・取付け穴は作っていない・アルミ）', slot: 0, material: 'aluminum', materialText: 'アルミダイカスト',
    page: 75, kind: 'ベースの板', width: 75, depth: 75, thickness: 10, holes: [], adjusterThreadDiameter: 12,
    bosses: [{ x: 43, y: 43, diameter: 25, bottom: -5, top: 15 }], massG: 120, simplified: ['取付け穴は作っていない', 'アジャスターのめねじ'] },
];
