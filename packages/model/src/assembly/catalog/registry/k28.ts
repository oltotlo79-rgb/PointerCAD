import type { CatalogFamilyEntry } from '../types.js';

/**
 * 包み K-28 の族の登録の一覧: 配管(ガス管の継手。分類 'piping')。1 行の形は `k5.ts` と同じ。
 * 表は `load` の中の動的な読み込みで必要な時だけ読む(起動の時に読まない)。
 */
export const K28_CATALOG_FAMILIES: readonly CatalogFamilyEntry[] = [
  { id: 'pipe-fitting-elbow', group: 'piping', kindKey: 'catalog.piping.kind.elbow',
    load: async () => (await import('../families/pipeFittings.js')).PIPE_FITTING_FAMILIES.elbow },
  { id: 'pipe-fitting-tee', group: 'piping', kindKey: 'catalog.piping.kind.tee',
    load: async () => (await import('../families/pipeFittings.js')).PIPE_FITTING_FAMILIES.tee },
  { id: 'pipe-fitting-socket', group: 'piping', kindKey: 'catalog.piping.kind.socket',
    load: async () => (await import('../families/pipeFittings.js')).PIPE_FITTING_FAMILIES.socket },
];
