/**
 * .pcad の `document.json` の封筒と書式の版(要件§8、計画書 docs/plans/P2-ソリッド基礎.md §2.8、§0.a-0.3)。
 *
 * 封筒は「どの版の、どのアプリが、いつ書いたか」だけを持ち、中身は部品文書そのものを入れる。
 * 版の正本は部品文書の `schemaVersion`(統括の決定④、docs/報告記録.md 2026-09-03 07:35)で、
 * 封筒の `schema` には同じ値を書く。読み手は封筒の `schema` を先に検査してから中身を読む
 * (中身の形は版によって変わり得るため、版の判定を中身の解釈より先に済ませる)。
 */

import type { PartDocument } from '@pointercad/model';

/**
 * .pcad の書式の版(§0.a-0.3)。P2 で 2 になる。
 * 版 1 で保存されたファイルはこの世に 1 つも無い(P0 には保存機能が無かった)ので、
 * 版 1 は「対応していない古い版」として断る。
 * この値は部品文書の `PART_SCHEMA_VERSION` と必ず同じにする(documentJson.test.ts が検査する)。
 */
export const PCAD_SCHEMA_VERSION = 2;

/** 封筒に書くアプリ名。他のアプリの JSON を取り違えて読まないための目印。 */
export const PCAD_APP_NAME = 'PointerCAD';

/**
 * 封筒に書く種別(要件§8 の「種別(part / assembly / drawing)」、統括の決定
 * docs/報告記録.md 2026-09-03 07:58 の⑤)。
 *
 * このアプリが書き出すのは部品(part)だけなので、書き出しでは常にこの値を書く。
 * 読み手は `part` 以外を理由つきで断る。将来アセンブリや図面を足すときは、
 * この定数ではなく読み手の受け入れる一覧を広げる(書き出す側は種類ごとに決まった値を書く)。
 */
export const PCAD_DOCUMENT_KIND = 'part';

/** `document.json` の中身(封筒)。ここに書いたものだけを保存し、それ以外は保存しない。 */
export interface PcadEnvelope {
  /** 書式の版。部品文書の `schemaVersion` と同じ値。 */
  readonly schema: number;
  /** 中身の種別。部品ファイルは常に `PCAD_DOCUMENT_KIND`。 */
  readonly kind: typeof PCAD_DOCUMENT_KIND;
  /** 常に `PCAD_APP_NAME`。 */
  readonly app: string;
  /** 保存した時刻(ISO 8601、UTC)。 */
  readonly savedAt: string;
  /** 部品文書そのもの。導出できるもの(解決済みの座標・メッシュ・鍵)は入れない。 */
  readonly document: PartDocument;
}

/**
 * 版を1つ上げる変換。封筒ごと受け取り、封筒ごと返す
 * (将来は封筒の欄が増減し得るので、中身だけを渡す形にしない)。
 */
export type SchemaMigration = (raw: unknown) => unknown;

/**
 * 版を上げたときの変換表。鍵は「変換元の版」で、`SCHEMA_MIGRATIONS[2]` は版 2 を版 3 へ直す。
 * 読み手は古い版のファイルをこの表で今の版まで順に持ち上げてから読む(要件§8 の前方互換)。
 * P2 では版 2 が最新なので空。版 3 を作るときに `SCHEMA_MIGRATIONS[2]` を足せば、
 * 版 2 のファイルは読み手を書き換えずに開けるようになる。
 */
export const SCHEMA_MIGRATIONS: Readonly<Record<number, SchemaMigration | undefined>> = {};
