/*
 * 設定の窓の下書き(適用していない変更)の扱い(UI/UX の点検の指摘 7)。
 *
 * 下書きは各 form の部品の中にだけある(視点の操作・キーの割り当て・自動保存・道具の初期値)。窓が下書きの中身を
 * 写し持たないよう、form は「下書きがある」ことだけを印 `data-settings-draft="true"` で示し、窓はその印を見て
 * 閉じてよいかを決める。適用は各 form の送信(その form の検査と適用の道)に任せる。
 */

/** 下書きを持つ form。 */
const DRAFT_FORMS = 'form[data-settings-draft="true"]';

/** 窓を閉じる求めへの答え。下書きがある間は閉じずに、窓の中で確かめる。 */
export function settingsCloseRequest(panel: { querySelector(selectors: string): unknown } | null): 'close' | 'confirm' {
  return panel !== null && panel.querySelector(DRAFT_FORMS) !== null ? 'confirm' : 'close';
}

/** 「適用して閉じる」: 下書きのある form をそれぞれの送信で適用する。送った数を返す。 */
export function submitSettingsDrafts(panel: { querySelectorAll(selectors: string): Iterable<{ requestSubmit(): void }> }): number {
  let submitted = 0;
  for (const form of panel.querySelectorAll(DRAFT_FORMS)) {
    form.requestSubmit();
    submitted++;
  }
  return submitted;
}
