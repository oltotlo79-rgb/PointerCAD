import type { CatalogFamilyEntry } from '../types.js';

/**
 * 包み K4b の族の登録の一覧: 機械要素の第 2 弾(平行ピン・ナットの拡張・圧縮コイルばねなど)。
 * この包みの族だけをここへ足す(登録口 `registry.ts` と他の包みの一覧は触らない)。1 行の形は `k4a.ts` と同じ。
 * 表は `load` の中の動的な読み込みで必要な時だけ読む(起動の時に読まない)。
 */
export const K4B_CATALOG_FAMILIES: readonly CatalogFamilyEntry[] = [
  { id: 'parallel-pin', group: 'mechanical', kindKey: 'catalog.mechanical.kind.parallelPin',
    load: async () => (await import('../families/parallelPin.js')).PARALLEL_PIN_FAMILY },
  { id: 'hex-nut-style1-extended', group: 'mechanical', kindKey: 'catalog.mechanical.kind.hexNutStyle1',
    load: async () => (await import('../families/hexNutExtended.js')).HEX_NUT_STYLE1_FAMILY },
  { id: 'hex-nut-style2', group: 'mechanical', kindKey: 'catalog.mechanical.kind.hexNutStyle2',
    load: async () => (await import('../families/hexNutExtended.js')).HEX_NUT_STYLE2_FAMILY },
  { id: 'hex-nut-thin', group: 'mechanical', kindKey: 'catalog.mechanical.kind.hexNutThin',
    load: async () => (await import('../families/hexNutExtended.js')).HEX_NUT_THIN_FAMILY },
  { id: 'compression-spring', group: 'mechanical', kindKey: 'catalog.mechanical.kind.compressionSpring',
    hint: { key: 'catalog.mechanical.spring.hint', rowLabel: 'specified' },
    load: async () => (await import('../families/compressionSpring.js')).COMPRESSION_SPRING_FAMILY },
];
