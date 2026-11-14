import type { CatalogFamilyEntry } from '../types.js';

/**
 * 包み K6 の族の登録の一覧: アルミフレームとブラケット・ナットなど(寸法の出どころの判断の後に足す)。
 * この包みの族だけをここへ足す(登録口 `registry.ts` と他の包みの一覧は触らない)。1 行の形は `k4a.ts` と同じで、
 * 分類は `group: 'aluminumFrame'`。表は `load` の中の動的な読み込みで必要な時だけ読む(起動の時に読まない)。
 */
export const K6_CATALOG_FAMILIES: readonly CatalogFamilyEntry[] = [];
