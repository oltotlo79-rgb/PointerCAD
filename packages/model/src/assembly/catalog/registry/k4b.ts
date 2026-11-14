import type { CatalogFamilyEntry } from '../types.js';

/**
 * 包み K4b の族の登録の一覧: 機械要素の第 2 弾(平行ピン・ナットの拡張・圧縮コイルばねなど)。
 * この包みの族だけをここへ足す(登録口 `registry.ts` と他の包みの一覧は触らない)。1 行の形は `k4a.ts` と同じ。
 * 表は `load` の中の動的な読み込みで必要な時だけ読む(起動の時に読まない)。
 */
export const K4B_CATALOG_FAMILIES: readonly CatalogFamilyEntry[] = [];
