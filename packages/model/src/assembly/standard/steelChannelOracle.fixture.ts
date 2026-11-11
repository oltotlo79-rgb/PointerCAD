/** Independent W6c transcription; no application imports. Printed precision is retained as strings.
 * JISF G 3192 amendment draft table 12, via docs/standards/jis/channel-jis-g-3192.json.
 * The transcript is authorized as the source here; no final JIS edition or stock availability is asserted.
 */
export const CHANNEL_ADDITION_PRINTED = [
  [250, 90, 9, 13, 14, 7, '44.07', '34.6'],
  [250, 90, 11, 14.5, 17, 8.5, '51.17', '40.2'],
  [300, 90, 9, 13, 14, 7, '48.57', '38.1'],
  [300, 90, 10, 15.5, 19, 9.5, '55.74', '43.8'],
  [300, 90, 12, 16, 19, 9.5, '61.9', '48.6'],
  [380, 100, 10.5, 16, 18, 9, '69.39', '54.5'],
  [380, 100, 13, 16.5, 18, 9, '78.96', '62.0'],
  [380, 100, 13, 20, 24, 12, '85.71', '67.3'],
] as const;

const citation = {
  url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai004_jis02G3192_20201202.pdf',
  locator: 'JISF G 3192 原案 表12; docs/standards/jis/channel-jis-g-3192.json',
};
const source = <T>(value: T) => ({ kind: 'source' as const, value, citation });
const computed = (value: number, formula: string) => ({ kind: 'computed' as const, value, formula, citation });

export const CHANNEL_ADDITION_ORACLE = CHANNEL_ADDITION_PRINTED.map(([h, b, tw, tf, root, tip, area, mass]) => {
  const size = `[ ${h}×${b}×${tw}×${tf}`;
  const polygon = h * tw + 2 * tf * (b - tw);
  const turn = 85 * Math.PI / 180;
  return { key: `SS400:channel:${size}`, catalog: 'channel' as const, size,
    dimensions: { height: source(h), width: source(b), webThickness: source(tw), flangeThickness: source(tf) },
    rootRadiusMm: source(root), tipRadiusMm: source(tip),
    printedAreaCm2: source(area), printedMassKgPerM: source(mass),
    jisAreaMm2: computed(polygon + 0.349 * (root ** 2 - tip ** 2),
      'H t1 + 2 t2(B - t1) + 0.349(r1² - r2²), JISF G 3192 原案 表6'),
    exactAreaMm2: computed(polygon + (2 * Math.tan(turn / 2) - turn) * (root ** 2 - tip ** 2),
      'H t1 + 2 t2(B - t1) + (2 tan(85°/2) - 85π/180)(r1² - r2²)'),
    standardLengthsMm: { kind: 'unverified' as const, value: null, reason: 'The transcript does not state stock lengths.' },
  };
});
