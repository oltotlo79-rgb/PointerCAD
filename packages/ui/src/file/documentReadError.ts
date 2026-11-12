import type { ReadPcadFileErrorCode } from '@pointercad/io';
import type { MessageKey } from '../i18n/t.js';

/**
 * `.pcad` を読めなかった理由と、利用者へ見せる文言の対応(NFR-UX-5)。
 *
 * `packages/io` は理由ごとに日本語の文も持っているが、画面へ出す文言は ja.json に
 * まとめる決まりなので(NFR-MA-5)、ここで対応づけ直す。`Record` で全部の理由を
 * 書かせているので、`packages/io` が理由を増やしたら型検査で気づける。
 */
const OPEN_ERROR_KEYS: Readonly<Record<ReadPcadFileErrorCode, MessageKey>> = {
  // ZIP として開けない。中身を見る手前で壊れている。
  notZip: 'file.error.corrupted',
  // ZIP ではあるが、部品の中身が入っていない。
  missingDocument: 'file.error.missingDocument',
  // 中身が JSON として読めない。
  invalidJson: 'file.error.corrupted',
  // PointerCAD の封筒になっていない(他のアプリのファイル)。
  notPcad: 'file.error.wrongKind',
  // PointerCAD のファイルだが、部品ではない(アセンブリ・図面)。
  unsupportedKind: 'file.error.wrongKind',
  unsupportedOldVersion: 'file.error.tooOld',
  unsupportedNewVersion: 'file.error.tooNew',
  // 版の記録が食い違う・欄が足りない・型が違うのは、いずれも中身の壊れ。
  versionMismatch: 'file.error.corrupted',
  missingField: 'file.error.corrupted',
  invalidField: 'file.error.corrupted',
};

/**
 * 読めなかった理由を利用者へ見せる文言のキーへ直す。
 *
 * ひな形(`.pcadt`)も同じ封筒を読む(`file/templateFile.ts`)ので、上の表を**写さずに**
 * 使えるようにここへ 1 つだけ口を開けてある。表そのものは外へ出さない(理由と文言の
 * 対応を書き換える場所を 1 か所に閉じるため)。
 */
export function openErrorMessageKey(code: ReadPcadFileErrorCode): MessageKey {
  return OPEN_ERROR_KEYS[code];
}
