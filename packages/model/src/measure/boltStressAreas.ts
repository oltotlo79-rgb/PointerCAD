/** Transcription of the visually inspected supplier excerpt.
 * Source: https://www.milcon.co.jp/data/pdf/product_2669.pdf, PDF page 2.
 * Label in source: JIS B1082-2009. Units: diameter/pitch mm, area mm².
 * This is the published nominal area, not an unrounded approximation.
 */
export interface BoltStressArea {
  readonly diameterMm: number;
  readonly pitchMm: number;
  readonly areaMm2: number;
  readonly series: 'coarse' | 'fine';
  readonly sourceId: 'milcon-jis-2009' | 'hardlock-table';
}

const coarse: readonly (readonly [number, number, number])[] = [
  [8, 1.25, 36.6], [10, 1.5, 58], [12, 1.75, 84.3], [14, 2, 115],
  [16, 2, 157], [18, 2.5, 192], [20, 2.5, 245], [22, 2.5, 303],
  [24, 3, 353], [27, 3, 459], [30, 3.5, 561], [33, 3.5, 694],
  [36, 4, 817], [39, 4, 976], [42, 4.5, 1120], [45, 4.5, 1310],
  [48, 5, 1470], [52, 5, 1760], [56, 5.5, 2030], [60, 5.5, 2360], [64, 6, 2680],
];
const fine: readonly (readonly [number, number, number])[] = [
  [8, 1, 39.2], [10, 1.25, 61.2], [12, 1.25, 92.1], [14, 1.5, 125],
  [16, 1.5, 167], [18, 1.5, 216], [20, 1.5, 272], [22, 1.5, 333],
  [24, 2, 384], [27, 2, 496], [30, 2, 621], [33, 2, 761],
  [36, 3, 865], [39, 3, 1030],
];
const smallCoarse: readonly (readonly [number, number, number])[] = [
  [2, 0.4, 2.07], [2.5, 0.45, 3.39], [3, 0.5, 5.03], [3.5, 0.6, 6.78], [4, 0.7, 8.78], [5, 0.8, 14.2], [6, 1, 20.1],
];
const largeFine: readonly (readonly [number, number, number])[] = [
  [42, 3, 1210], [45, 3, 1410], [48, 3, 1600], [56, 4, 2140], [60, 4, 2480], [64, 4, 2850],
];
// Hardlock's M36/M39 fine-pitch labels disagree with the source-backed Milcon rows.
// Keep the independently verified M36x3/M39x3 rows above; do not import those conflicting labels.
export const BOLT_TENSILE_AREAS: readonly BoltStressArea[] = [
  ...coarse.map(([diameterMm, pitchMm, areaMm2]): BoltStressArea => ({ diameterMm, pitchMm, areaMm2, series: 'coarse', sourceId: 'milcon-jis-2009' })),
  ...fine.map(([diameterMm, pitchMm, areaMm2]): BoltStressArea => ({ diameterMm, pitchMm, areaMm2, series: 'fine', sourceId: 'milcon-jis-2009' })),
  ...smallCoarse.map(([diameterMm, pitchMm, areaMm2]): BoltStressArea => ({ diameterMm, pitchMm, areaMm2, series: 'coarse', sourceId: 'hardlock-table' })),
  ...largeFine.map(([diameterMm, pitchMm, areaMm2]): BoltStressArea => ({ diameterMm, pitchMm, areaMm2, series: 'fine', sourceId: 'hardlock-table' })),
];

/** Undefined explicitly means this source does not verify that diameter/pitch. */
export function findBoltStressArea(diameterMm: number, pitchMm: number): BoltStressArea | undefined {
  return BOLT_TENSILE_AREAS.find((entry) => entry.diameterMm === diameterMm && entry.pitchMm === pitchMm);
}
