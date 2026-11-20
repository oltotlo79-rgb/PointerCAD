import type { CatalogFamilyEntry } from '../types.js';

/**
 * 包み K-28 の族の登録の一覧: 配管(ガス管の継手・フランジ。分類 'piping')。1 行の形は `k5.ts` と同じ。
 * 表は `load` の中の動的な読み込みで必要な時だけ読む(起動の時に読まない)。
 */
export const K28_CATALOG_FAMILIES: readonly CatalogFamilyEntry[] = [
  { id: 'pipe-fitting-elbow', group: 'piping', kindKey: 'catalog.piping.kind.elbow',
    load: async () => (await import('../families/pipeFittings.js')).PIPE_FITTING_FAMILIES.elbow },
  { id: 'pipe-fitting-tee', group: 'piping', kindKey: 'catalog.piping.kind.tee',
    load: async () => (await import('../families/pipeFittings.js')).PIPE_FITTING_FAMILIES.tee },
  { id: 'pipe-fitting-socket', group: 'piping', kindKey: 'catalog.piping.kind.socket',
    load: async () => (await import('../families/pipeFittings.js')).PIPE_FITTING_FAMILIES.socket },
  { id: 'pipe-fitting-cap', group: 'piping', kindKey: 'catalog.piping.kind.cap',
    load: async () => (await import('../families/pipeFittingParts.js')).PIPE_FITTING_PART_FAMILIES.cap },
  { id: 'pipe-fitting-plug', group: 'piping', kindKey: 'catalog.piping.kind.plug',
    load: async () => (await import('../families/pipeFittingParts.js')).PIPE_FITTING_PART_FAMILIES.plug },
  { id: 'pipe-fitting-nipple', group: 'piping', kindKey: 'catalog.piping.kind.nipple',
    load: async () => (await import('../families/pipeFittingParts.js')).PIPE_FITTING_PART_FAMILIES.nipple },
  { id: 'pipe-fitting-bushing', group: 'piping', kindKey: 'catalog.piping.kind.bushing',
    load: async () => (await import('../families/pipeFittingParts.js')).PIPE_FITTING_PART_FAMILIES.bushing },
  { id: 'pipe-flange-5k', group: 'piping', kindKey: 'catalog.piping.kind.flange5K',
    load: async () => (await import('../families/pipeFlanges.js')).PIPE_FLANGE_FAMILIES['5k'] },
  { id: 'pipe-flange-10k', group: 'piping', kindKey: 'catalog.piping.kind.flange10K',
    load: async () => (await import('../families/pipeFlanges.js')).PIPE_FLANGE_FAMILIES['10k'] },
];
