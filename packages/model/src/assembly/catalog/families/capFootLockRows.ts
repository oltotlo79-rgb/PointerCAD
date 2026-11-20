/**
 * 生成物(手で直さない): 資料 2 の足回りのロックの行(外形を包む形。キャップと足の部品の族に続ける。統括 2026-11-19 19:3x)。
 * 担当の道具 make_lock_rows.py が、39h の読み 2 本で一致した値から書いた。2 本目の文字は fixture `capFootLockOracle.fixture.json`。
 * 製造元の名前・型番・品名は書かない。
 */
import type { PanelPartRecord } from './panelPartCatalog.js';

export const CAP_FOOT_LOCK_RECORDS: readonly PanelPartRecord[] = [
  { key: 'caster-lock-105x118x97.5-fe', size: 'キャスターの止め 105×118×97.5（外形を包む形・鉄・足を上げた時の高さ 82.5）', page: 98, kind: 'キャスターの止め', material: 'steel',
    width: 105, depth: 118, height: 97.5, massG: 586, simplified: ['外形を包む形で、細部は作っていない'] },
];
