/**
 * 族: 資料 1 の小さい部品(外形を包む形)と、溝やパネルに付ける長物(断面の外形を包む長方形 × 長さ)。統括の決定 2026-11-19 15:5x の 1・3。
 * 製造元の名前・型番・品名は書かない(呼びは部品の種類の一般の語と外形の寸法)。行の表 `smallPartBoxRows.ts`・`slotLongPartRows.ts` は、
 * 担当の道具 make_book1_box_rows.py が 39 回目の読み 2 本で一致した値(全体の 3 寸法〔長物は断面の 2 寸法と長さの上限〕・材質・質量)から生成する
 * (ブラケットのそのほかは 60 回目からの読み 2 本)。
 *
 * - 小さい部品: 資料 2 の部品と同じ外形を包む箱の作り(`boxFamily`)を資料 1 の名前で使う。簡略の印は「外形を包む形で、細部は作っていない」。
 *   スライダなど動く物は「動く仕組みは作っていない」を続ける。電動の物・電気の部品・組み上がった品は入れない。質量は資料の 1 個の値。
 *   キット・セットは本体の行として入れ、資料の質量は付属を含む組の値なので質量を出さない(行の massOmission。利用者の回答 2026-11-21 16:2x)。
 * - 長物: 断面の外形を包む長方形を長さだけ押し出した形(`rectangleLongPartFamily`)。切断の一覧に出る。質量は資料の単位質量 × 長さ。
 *   溝つきのフレームの部材にはならない(断面の外形・溝を持たない)。
 * 行の無い族は書かない・登録しない(配線の部品・系列をまたぐつなぎは、行が入った時に、この形で足して registry/k6.ts へ登録する)。
 * 資料に質量の無い部品は、密度を持たせず質量を出さない(資料 2 の部品と同じ。`boxFamily` の行の作り)。
 */
import { rectangleLongPartFamily } from '../longPartFamily.js';
import type { CatalogFamily } from '../types.js';
import { boxFamily } from './panelPartCatalog.js';
import {
  BRACKET_PART_BOX_RECORDS, CAP_ACCESSORY_BOX_RECORDS, DOOR_PART_BOX_RECORDS, DRAWER_PART_BOX_RECORDS, FOOT_PART_BOX_RECORDS, SLIDER_BOX_RECORDS,
} from './smallPartBoxRows.js';
import { SLOT_LONG_PART_RECORDS } from './slotLongPartRows.js';

const EVIDENCE_TITLE = '資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)';

/** 溝を滑る部品(スライダ・溝のローラ)。 */
export const SLIDER_BOX_FAMILY: CatalogFamily = boxFamily('slider-box', 'catalog.frame.kind.sliderBox', 'sliderBox', SLIDER_BOX_RECORDS,
  EVIDENCE_TITLE);

/** キャップの付属(ブラケットのキャップ・スペーサ・トラスのキャップ・レンチ穴のキャップ)。 */
export const CAP_ACCESSORY_BOX_FAMILY: CatalogFamily = boxFamily('cap-accessory-box', 'catalog.frame.kind.capAccessoryBox', 'capAccessoryBox',
  CAP_ACCESSORY_BOX_RECORDS, EVIDENCE_TITLE);

/** 足回りの部品(アジャスターを付けるブラケット・床留めのブラケットとブロック・キャスターの止め)。 */
export const FOOT_PART_BOX_FAMILY: CatalogFamily = boxFamily('foot-part-box', 'catalog.frame.kind.footPartBox', 'footPartBox',
  FOOT_PART_BOX_RECORDS, EVIDENCE_TITLE);

/**
 * 扉の部品(取手・内に付ける取手・磁石のキャッチ・樹脂のキャッチ・ボールのキャッチのブラケット。統括の決定 2026-11-20 02:2x の判断 3)と、
 * 用途が資料の品名から読める板とブラケット(磁石のキャッチの板・樹脂のキャッチの板・磁気の近接センサのブラケットと板。統括の決定 2026-11-20 07:1x)。
 */
export const DOOR_PART_BOX_FAMILY: CatalogFamily = boxFamily('door-part-box', 'catalog.frame.kind.doorPartBox', 'doorPartBox',
  DOOR_PART_BOX_RECORDS, EVIDENCE_TITLE);

/** 引出の部品(決まった長さのスライドレール。箱の奥行は縮めた時の長さで、伸び縮みは作らない。統括の決定 2026-11-20 07:1x)。 */
export const DRAWER_PART_BOX_FAMILY: CatalogFamily = boxFamily('drawer-part-box', 'catalog.frame.kind.drawerPartBox', 'drawerPartBox',
  DRAWER_PART_BOX_RECORDS, EVIDENCE_TITLE);

/**
 * ブラケットのそのほか(隠れる形のブラケット・向きを変えられるブラケット・締めレバー付きの向きを変えられるブラケット・L 形のブラケット・
 * 角の補強のブラケットと板・トラスのつなぎ。種類の語は統括が承認した一般の呼び)。60 回目からの読み 2 本で一致した全体の 3 寸法・材質・質量の箱
 * (板の奥行は資料の板厚の注記の数)。
 * 向きを変えられる 2 種は「動く仕組みは作っていない」を続ける。キットの本体の行は質量を出さない(行の massOmission)。
 */
export const BRACKET_PART_BOX_FAMILY: CatalogFamily = boxFamily('bracket-part-box', 'catalog.frame.kind.bracketPartBox', 'bracketPartBox',
  BRACKET_PART_BOX_RECORDS, EVIDENCE_TITLE);

/** 溝やパネルに付ける長物(溝のふた・溝のシール・パネルの押さえ・ダクトのカバーなど)。既定の長さ 1000(行の長さの上限が短ければ上限)。 */
export const SLOT_LONG_PART_FAMILY: CatalogFamily = rectangleLongPartFamily({ id: 'slot-long-part', kindKey: 'catalog.frame.kind.slotLongPart',
  diagram: 'slotLongPart', evidenceTitle: EVIDENCE_TITLE, defaultLength: 1000 }, SLOT_LONG_PART_RECORDS);
