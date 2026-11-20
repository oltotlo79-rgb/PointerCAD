/**
 * 族: ねじ込み式可鍛鋳鉄製管継手(JIS B 2301)のキャップ・プラグ(四角頭)・六角ニップル・ブッシング(K-28 束 2。設計 wip/k28-design-v2.md)。
 *
 * 寸法(資料の番号・URL・発行元は担当の資料の記録だけに置く。製品には JIS の番号だけ):
 * - キャップの高さ H(呼び 1/4〜6)、プラグの頭の二面幅 B と高さ b(呼び 1/2〜6)、六角ニップルの二面幅 B・長さ L・おねじの長さ E(呼び 1/8〜6)、
 *   ブッシングの二面幅 B・長さ L・おねじの長さ E と外の呼び × 中の呼びの組(58 組): 互いに独立な 2 つの公開の資料の JIS B 2301 の品の表で
 *   一致した値(B・E・プラグの寸法は参考寸法、キャップの高さは最小の値)。どちらかの資料で JIS B 2301 に無い品の印が付いた組は入れない。
 *   プラグの 1/8〜3/8 は 2 つの資料で頭の高さが割れ、一方で JIS B 2301 に無い品(鋼製)なので入れない。キャップの 1/8 は 1 つの資料にしか無い。
 * - キャップの外径・穴の深さ、プラグのおねじの長さ: 継手の端部の表(`pipeFittingEnds.ts`)のめねじ側の外径 A1・めねじ部の長さ l′・おねじ部の長さ l。
 * - 穴の径・おねじの外径: 管用テーパねじ(JIS B 0203)の基準径の位置の谷の径 d1・外径 d(`thread/pipeThread.ts`)。
 * 照らす側の値は pipeFittingPartOracle.fixture.json。形は `profiles/pipeFittingParts.ts` の簡略形状。
 * 可鍛鋳鉄の密度は密度の表に無いので、密度の材質を持たない(質量は出さない。束 1 と同じ扱い)。
 */
import { findPipeThread } from '../../../thread/pipeThread.js';
import { buildPipeFittingPartBody, pipeFittingPartVolume, type PipeFittingPartDimensions } from '../profiles/pipeFittingParts.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { pipeFittingEnd } from './pipeFittingEnds.js';

type PartKind = 'cap' | 'plug' | 'nipple' | 'bushing';

/** キャップ: [ねじの呼び, 高さ H]。 */
const CAPS: readonly (readonly [string, number])[] = [
  ['1/4', 15], ['3/8', 17], ['1/2', 20], ['3/4', 24], ['1', 28], ['1 1/4', 30], ['1 1/2', 32], ['2', 36], ['2 1/2', 42], ['3', 45],
  ['4', 55], ['5', 58], ['6', 65],
];

/** プラグ: [ねじの呼び, 頭の二面幅 B, 頭の高さ b]。 */
const PLUGS: readonly (readonly [string, number, number])[] = [
  ['1/2', 14, 10], ['3/4', 17, 11], ['1', 19, 12], ['1 1/4', 23, 13], ['1 1/2', 26, 14], ['2', 32, 15], ['2 1/2', 41, 18], ['3', 46, 19],
  ['4', 58, 22], ['5', 67, 25], ['6', 77, 28],
];

/** 六角ニップル・ブッシングの体: [ねじの呼び, 二面幅 B, 角の数(呼び 2 以上は八角), 長さ L, おねじの長さ E]。 */
type HexBody = readonly [string, number, number, number, number];

const NIPPLES: readonly HexBody[] = [
  ['1/8', 14, 6, 32, 11], ['1/4', 17, 6, 34, 12], ['3/8', 21, 6, 36, 13], ['1/2', 26, 6, 42, 16], ['3/4', 32, 6, 47, 18],
  ['1', 38, 6, 52, 20], ['1 1/4', 46, 6, 56, 22], ['1 1/2', 54, 6, 60, 23], ['2', 63, 8, 66, 25], ['2 1/2', 80, 8, 73, 28],
  ['3', 95, 8, 81, 32], ['4', 120, 8, 92, 37], ['5', 145, 8, 104, 42], ['6', 170, 8, 116, 46],
];

/** ブッシングの体(外の呼びごと)と、組になる中の呼び。 */
const BUSHINGS: readonly (readonly [HexBody, readonly string[]])[] = [
  [['1/4', 17, 6, 17, 12], ['1/8']],
  [['3/8', 21, 6, 18, 13], ['1/8', '1/4']],
  [['1/2', 26, 6, 21, 16], ['1/8', '1/4', '3/8']],
  [['3/4', 32, 6, 24, 18], ['1/4', '3/8', '1/2']],
  [['1', 38, 6, 27, 20], ['1/4', '3/8', '1/2', '3/4']],
  [['1 1/4', 46, 6, 30, 22], ['3/8', '1/2', '3/4', '1']],
  [['1 1/2', 54, 6, 32, 23], ['3/8', '1/2', '3/4', '1', '1 1/4']],
  [['2', 63, 8, 36, 25], ['1/2', '3/4', '1', '1 1/4', '1 1/2']],
  [['2 1/2', 80, 8, 39, 28], ['1/2', '3/4', '1', '1 1/4', '1 1/2', '2']],
  [['3', 95, 8, 44, 32], ['1/2', '3/4', '1', '1 1/4', '1 1/2', '2', '2 1/2']],
  [['4', 120, 8, 51, 37], ['1/2', '3/4', '1', '1 1/4', '1 1/2', '2', '2 1/2', '3']],
  [['5', 145, 8, 57, 42], ['1 1/2', '2', '2 1/2', '3', '4']],
  [['6', 170, 8, 64, 46], ['2', '2 1/2', '3', '4', '5']],
];

const EVIDENCE = {
  title: 'ねじ込み式可鍛鋳鉄製管継手(JIS B 2301)のキャップ・プラグ・六角ニップル・ブッシングの寸法と、継手の端部の寸法',
  edition: null,
  locator: 'JIS B 2301 の品の表: キャップの高さ H、プラグの頭の二面幅 B・高さ b、ニップル・ブッシングの二面幅 B・長さ L・おねじの長さ E(参考)、'
    + '端部のめねじ側の外径 A1・めねじ部の長さ l′・おねじ部の長さ l(参考)',
  reference: 'JIS B 2301',
} as const;

const SIMPLIFIED: Readonly<Record<PartKind, readonly string[]>> = {
  cap: ['頂部の丸み・帯・ねじの山とテーパは作らない。穴は管用テーパねじの基準径の位置の谷の径で、深さはめねじ部の長さ'],
  plug: ['頭のぬすみ・ねじの山とテーパは作らない。おねじは管用テーパねじの外径の円柱で、長さはおねじ部の長さ'],
  nipple: ['中の穴は表に寸法が無いので作らない。ねじの山とテーパは作らない。おねじは管用テーパねじの外径の円柱'],
  bushing: ['ねじの山とテーパ・面取りは作らない。おねじは外の呼びの管用テーパねじの外径の円柱、穴は中の呼びの谷の径で全長'],
};
const KIND_TEXT: Readonly<Record<PartKind, string>> = { cap: 'キャップ', plug: 'プラグ', nipple: '六角ニップル', bushing: 'ブッシング' };

const major = (thread: string): number | undefined => findPipeThread('taper', thread)?.majorDiameter;
const minor = (thread: string): number | undefined => findPipeThread('taper', thread)?.minorDiameter;
const pipeOf = (thread: string): number | undefined => pipeFittingEnd(thread)?.pipeSize;

/** 行(表から引けない値が 1 つでもある行は作らない。表の全部の呼びは引ける)。 */
function row(kind: PartKind, key: string, size: string, values: Readonly<Record<string, number | undefined>>): CatalogItemRow[] {
  const dims: Record<string, number> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) return [];
    dims[name] = value;
  }
  return [{ key: `${kind}-${key}`, size, standardLabel: 'JIS B 2301', dims, evidence: EVIDENCE, verification: 'manufacturer-catalog',
    verified: true, note: '', simplified: SIMPLIFIED[kind] }];
}

function capRows(): readonly CatalogItemRow[] {
  return CAPS.flatMap(([thread, height]) => {
    const end = pipeFittingEnd(thread);
    return row('cap', `${String(end?.pipeSize)}A`, `${String(end?.pipeSize)}A (Rc${thread})`, { height, outerDiameter: end?.outerDiameter,
      boreDiameter: minor(thread), femaleThreadLength: end?.femaleThreadLength, pipeSize: end?.pipeSize });
  });
}

function plugRows(): readonly CatalogItemRow[] {
  return PLUGS.flatMap(([thread, acrossFlats, headHeight]) => {
    const end = pipeFittingEnd(thread);
    return row('plug', `${String(end?.pipeSize)}A`, `${String(end?.pipeSize)}A (R${thread})`, { acrossFlats, headHeight,
      threadDiameter: major(thread), threadLength: end?.maleThreadLength, pipeSize: end?.pipeSize });
  });
}

function nippleRows(): readonly CatalogItemRow[] {
  return NIPPLES.flatMap(([thread, acrossFlats, sides, overallLength, threadLength]) => {
    const pipe = pipeOf(thread);
    return row('nipple', `${String(pipe)}A`, `${String(pipe)}A (R${thread})`, { acrossFlats, sides, overallLength, threadLength,
      threadDiameter: major(thread), pipeSize: pipe });
  });
}

function bushingRows(): readonly CatalogItemRow[] {
  return BUSHINGS.flatMap(([[outer, acrossFlats, sides, overallLength, threadLength], inners]) => inners.flatMap((inner) => {
    const outerPipe = pipeOf(outer), innerPipe = pipeOf(inner);
    return row('bushing', `${String(outerPipe)}x${String(innerPipe)}A`, `${String(outerPipe)}A×${String(innerPipe)}A (R${outer}×Rc${inner})`,
      { acrossFlats, sides, overallLength, threadLength, threadDiameter: major(outer), boreDiameter: minor(inner), pipeSize: outerPipe,
        innerPipeSize: innerPipe });
  }));
}

function dimensionsOf(kind: PartKind, dims: Readonly<Record<string, number>>): PipeFittingPartDimensions {
  const value = (key: string): number => dims[key] ?? NaN;
  switch (kind) {
    case 'cap':
      return { kind, outerDiameter: value('outerDiameter'), height: value('height'), boreDiameter: value('boreDiameter'),
        boreDepth: value('femaleThreadLength') };
    case 'plug':
      return { kind, acrossFlats: value('acrossFlats'), headHeight: value('headHeight'), threadDiameter: value('threadDiameter'),
        threadLength: value('threadLength') };
    case 'nipple':
      return { kind, acrossFlats: value('acrossFlats'), sides: value('sides'), overallLength: value('overallLength'),
        threadLength: value('threadLength'), threadDiameter: value('threadDiameter') };
    case 'bushing':
      return { kind, acrossFlats: value('acrossFlats'), sides: value('sides'), overallLength: value('overallLength'),
        threadLength: value('threadLength'), threadDiameter: value('threadDiameter'), boreDiameter: value('boreDiameter') };
  }
}

const ROWS: Readonly<Record<PartKind, () => readonly CatalogItemRow[]>> = { cap: capRows, plug: plugRows, nipple: nippleRows, bushing: bushingRows };
const DIAGRAMS = { cap: 'pipeCap', plug: 'pipePlug', nipple: 'pipeNipple', bushing: 'pipeBushing' } as const;

function partFamily(kind: PartKind): CatalogFamily {
  const name = (item: CatalogItemRow): string => `${KIND_TEXT[kind]} ${item.size}`;
  return {
    id: `pipe-fitting-${kind}`,
    group: 'piping',
    kindKey: `catalog.piping.kind.${kind}`,
    catalogRevision: `pipe-fitting-${kind}-2026-11-r1`,
    generatorRevision: 'pipe-fitting-part-1',
    options: [],
    stock: 'count',
    diagram: DIAGRAMS[kind],
    rows: ROWS[kind](),
    build: (item) => buildPipeFittingPartBody(dimensionsOf(kind, item.dims), name(item)),
    nominalVolume: (item) => pipeFittingPartVolume(dimensionsOf(kind, item.dims)),
    partName: name,
  };
}

export const PIPE_FITTING_PART_FAMILIES: Readonly<Record<PartKind, CatalogFamily>> = {
  cap: partFamily('cap'), plug: partFamily('plug'), nipple: partFamily('nipple'), bushing: partFamily('bushing'),
};
