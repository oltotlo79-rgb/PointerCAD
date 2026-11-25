/**
 * 再計算が持ち回る覚え書き(オフセット・投影・部分形状の選び直し・板金への変換の認識)を、
 * 文書の差し替えに応じて空にする見張り(新規・開く・復元、および Undo / Redo。ストアの `documentVersion` で拾う)。
 *
 * 覚え書きは頁を開いている間ずっと生き続けるので、これをしないと**前の文書の参照が次の文書に残る**。
 * フィーチャーの id は文書ごとに `solid-1` から振り直される(`createPartDocument.ts` の `nextSolidId`)ため、
 * 前の文書の面・辺・頂点の参照が新しい文書の**別物の同じ id のボディ**へ照合し直され、`refresh` が毎回「変わった」と
 * 言い続けて `recomputePart` が毎回 2 巡目に入り、覚えている参照も増え続ける(NFR-PF-3。`subShapeCache.ts` の `clear` の注釈)。
 *
 * **`attachPartRecompute` より先に見張りを始める**(購読の通知は登録順に届く)。後にすると、差し替え直後の 1 回だけ
 * 古い覚え書きで解決してしまう。
 *
 * 判定に文書の id を使わないのは、`createEmptyPartDocument()` の id が常に `part-1` で「新規」の前後で変わらないため。
 * 板金の認識は別の文書を開くか、Undo / Redo で形が変わった時に空にする。外観だけの履歴移動では再計算が走らず、
 * この答えがなければ同じ板金を加工窓や測定で解けなくなるため、その場合は答えを残す。
 */
import { affectsShape } from '@pointercad/model';

import { useAppStore } from '../store/useAppStore.js';

interface ClearableCache { clear(): void }

/** 見張りを始める。返す関数で見張りを止める。 */
export function clearCachesOnDocumentChange(caches: readonly ClearableCache[], sheetRecognition: ClearableCache): () => void {
  return useAppStore.subscribe((next, previous) => {
    const editChanged = next.partEdit?.id !== previous.partEdit?.id;
    if (!editChanged && next.documentVersion === previous.documentVersion) return;
    for (const cache of caches) cache.clear();
    if (editChanged || next.activeDocumentId !== previous.activeDocumentId || affectsShape(previous.document, next.document)) sheetRecognition.clear();
  });
}
