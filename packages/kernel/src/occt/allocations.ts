/**
 * OCCT が確保した領域をまとめて解放するための入れ物(計画書 P3 §2.12、タスク2)。
 *
 * OCCT(WASM)が作ったものは JavaScript の回収の対象外なので、作った側が必ず
 * delete() を呼ぶ。P2 では同じ入れ物が makeSolidSweep.ts の中に閉じていたため、
 * P3 の加工(穴・ねじ・R 面取り・C 面取り)から使い回せるようここへ切り出した。
 * 中身と振る舞いは切り出す前と同じで、例外のときの決め(下の release の注釈)だけを足してある。
 */

/** OCCT が確保した領域を持ち、まとめて解放できるもの。 */
export interface OcctDeletable {
  delete(): void;
}

/**
 * 確保したものを控えておき、作った順の逆にまとめて解放する入れ物。
 *
 * maker.Shape() が返す形は maker の中の実体を指すので、形だけを先に解放できない
 * (docs/報告記録.md 2026-09-02 14:40 の実測)。控えへ「面 → ベクトル(軸)→ maker → 形」の
 * 順に積み、解放は必ずその逆順で行う。
 */
export interface Allocations {
  /** 控えへ積んで、そのまま返す。 */
  keep: <T extends OcctDeletable>(item: T) => T;
  /** 積んだ順の逆に delete() する。2 度呼んでも安全(控えを空にする)。 */
  release: () => void;
}

/**
 * 新しい控えを 1 つ作る。使い方は次のとおり。
 *
 * ```ts
 * const { keep, release } = createAllocations();
 * try {
 *   const maker = keep(new oc.BRepPrimAPI_MakePrism_1(...));
 *   const shape = keep(maker.Shape());
 *   return { shape, delete: release };   // 成功したら解放は呼び出し側に任せる
 * } catch (error) {
 *   release();                            // 途中で断ったらその場で全部返す
 *   throw error;
 * }
 * ```
 *
 * **例外のときの決め(計画書 タスク2 の検証表):** 途中の delete() が例外を投げても、
 * 残りは最後まで解放する。1 つの失敗で他を漏らすと WASM の領域が増え続けるため。
 * そのうえで**最初の例外は投げ直す**。解放の失敗は二重解放などの不具合の兆候であり、
 * 黙って捨てると原因を追えなくなるため(rules/02-禁止事項.md の「警告を封じない」)。
 * 限界: 呼び出し側が catch の中で release() を呼んでいる場合、投げ直した例外が
 * もとの理由(利用者へ見せる日本語)を置き換えうる。ただし段の失敗は recomputeSolids が
 * 受け止めて理由に変えるので、アプリが落ちることはない(NFR-RE-1)。
 */
export function createAllocations(): Allocations {
  const items: OcctDeletable[] = [];
  return {
    keep<T extends OcctDeletable>(item: T): T {
      items.push(item);
      return item;
    },
    release(): void {
      let failure: unknown = null;
      let failed = false;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        try {
          items[index].delete();
        } catch (error) {
          if (!failed) {
            failure = error;
            failed = true;
          }
        }
      }
      // 控えは必ず空にする。空にしないと、2 度目の release() で同じものをもう一度
      // delete() してしまう(embind は解放済みの実体への delete() を例外にする)。
      items.length = 0;
      if (failed) {
        throw failure;
      }
    },
  };
}
