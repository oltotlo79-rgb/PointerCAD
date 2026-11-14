import type { CatalogFamilyEntry } from '../types.js';

/**
 * 包み K4a の族の登録の一覧: 機械要素の第 1 弾(カムフォロア・巻きブシュなど)。
 * この包みの族だけをここへ足す(登録口 `registry.ts` と他の包みの一覧は触らない)。1 行の形:
 * `{ id: '<族の id>', group: 'mechanical', kindKey: '<種類の i18n の鍵>',
 *   load: async () => (await import('../families/<族>.js')).<族の定数> }`。
 * 表は `load` の中の動的な読み込みで必要な時だけ読む(起動の時に読まない)。
 */
export const K4A_CATALOG_FAMILIES: readonly CatalogFamilyEntry[] = [];
