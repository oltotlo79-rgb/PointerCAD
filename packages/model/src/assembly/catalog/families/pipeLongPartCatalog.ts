/**
 * 族: 資料 2(2 冊目の総合カタログ)のパイプ形のフレームの系列の長物(取付けレール・棚の梁・羽や脚のある形材など、断面の外形の幅と高さ・
 * 単位質量・切り売りの範囲だけが資料にある物。統括の決定 2026-11-20 21:2x の (2))。製造元の名前・型番・品名は書かない。
 * 行の表 `pipeLongPartRows.ts` は、担当の道具 make_b2_long_rows.py が 40 回目の読み 2 本で一致した値から生成する。
 *
 * 形は資料 1 の長物と同じ、断面の外形を包む長方形を長さだけ押し出した形(`rectangleLongPartFamily`)。断面の形(輪・羽・溝・中空)は作らず、
 * 行の簡略の印に出す。断面の性質は持たない(梁の解析の部材にならない)。質量は資料の単位質量 × 長さ。既定の長さ 1000。
 */
import { rectangleLongPartFamily } from '../longPartFamily.js';
import type { CatalogFamily } from '../types.js';
import { PIPE_LONG_PART_RECORDS } from './pipeLongPartRows.js';

const EVIDENCE_TITLE = '資料 2 パイプ形のフレームの総合カタログ(製造元の寸法に合わせた物)';

/** パイプ形のフレームの系列の長物(断面の外形を包む長方形 × 長さ)。 */
export const PIPE_LONG_PART_FAMILY: CatalogFamily = rectangleLongPartFamily({ id: 'pipe-long-part', kindKey: 'catalog.frame.kind.pipeLongPart',
  diagram: 'pipeLongPart', evidenceTitle: EVIDENCE_TITLE, defaultLength: 1000 }, PIPE_LONG_PART_RECORDS);
