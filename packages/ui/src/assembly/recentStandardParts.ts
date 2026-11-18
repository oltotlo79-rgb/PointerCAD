/**
 * 規格部品の選ぶ窓の「最近使った物」(K-07b)。置けた物を新しい順に 8 件まで覚え、窓の検索の欄の下に出す。
 * アプリを閉じるまでだけ持つ(統括の決定 2026-11-18 17:2x の D1。設定にも文書にも書かない)。
 */
import { useSyncExternalStore } from 'react';

import { recentPartOf, type PickerJumpTarget, type RecentPart } from './catalogSearch.js';

const LIMIT = 8;
let recent: readonly RecentPart[] = [];
const listeners = new Set<() => void>();

/** 置けた物を頭に入れる(同じ行の前の物は消し、長さなどの指定の値は新しい方にする)。検索の並びに無い物は覚えない。 */
export function rememberPlacedPart(target: PickerJumpTarget): void {
  const part = recentPartOf(target);
  if (part === null) return;
  recent = [part, ...recent.filter((entry) => entry.key !== part.key)].slice(0, LIMIT);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot(): readonly RecentPart[] {
  return recent;
}

/** 最近使った物(新しい順。覚えた物が変わると描き直す)。 */
export function useRecentParts(): readonly RecentPart[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
