import { serializeDocument } from '@pointercad/io';
import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';

/**
 * 中身が同じかを比べるときに使う保存時刻。
 *
 * `serializeDocument` は保存時刻も一緒に書き出すので、同じ値を渡して**時刻の違いを
 * 消してから**比べる。そうしないと「開いた直後なのに保存していない変更がある」に見える。
 */
const COMPARISON_SAVED_AT = '1970-01-01T00:00:00.000Z';

/**
 * 直前の判定を 1 つだけ覚えておく。
 *
 * 判定は文書を丸ごと文字列にして比べるので、式を 1 文字打つたびに全部を書き出すと
 * もったいない(NFR-PF-1)。文書は作り直しでしか変わらない(不変)ので、
 * 同じ 2 つを渡されたら前と同じ答えでよい。
 */
let cachedDocument: PartDocument | null = null;
let cachedSaved: PartDocument | null = null;
let cachedResult = false;

/** 中身を比べるための文字列。保存時刻の違いは消してある。 */
function contentOf(document: PartDocument): string {
  // Issuance is retained across Undo and persisted by the real save path. It is
  // allocator metadata, not an authored edit; compare every other saved field.
  const { patternSlotHighWater: issuance, ...content } = document;
  void issuance;
  return serializeDocument(content, { savedAt: COMPARISON_SAVED_AT });
}

/** 何もかいていない、起動直後のままの部品か。 */
function isUntouched(document: PartDocument): boolean {
  return contentOf(document) === contentOf({ ...createEmptyPartDocument(), id: document.id });
}

/**
 * 保存していない変更があるか。
 *
 * 参照が同じかではなく**中身**で比べる。文書は書き換えるたびに作り直されるので、
 * 参照で比べると「1 文字打って消した」だけで変更ありになってしまう。
 * 一度も保存していないとき(`savedDocument` が null)は、起動直後のままの空の部品を
 * 「変更なし」として扱う。まだ何もしていない状態で確認を出さないため(NFR-UX-3)。
 */
export function hasUnsavedChanges(
  document: PartDocument,
  savedDocument: PartDocument | null,
): boolean {
  if (document === cachedDocument && savedDocument === cachedSaved) {
    return cachedResult;
  }
  const result =
    savedDocument === null
      ? !isUntouched(document)
      : document !== savedDocument && contentOf(document) !== contentOf(savedDocument);
  cachedDocument = document;
  cachedSaved = savedDocument;
  cachedResult = result;
  return result;
}
