/** W6d independent literal transcription, no application imports.
 * JISF G 3192 draft 2024-07-24 tables 8/12; PDF SHA-256:
 * ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa.
 * Transcript SHA-256: 0a44913287b067333e137fe3f8d0b5d8478e80cd2145fefc08691793b0df17ac.
 * Printed significant digits are strings. No final-edition or stock claim is made.
 */
export const ANGLE_ADDITION_PRINTED = [
  [120, 8, 12, 5, '18.76', '14.7'],
  [130, 9, 12, 6, '22.74', '17.9'],
  [130, 12, 12, 8.5, '29.76', '23.4'],
  [130, 15, 12, 8.5, '36.75', '28.8'],
  [150, 12, 14, 7, '34.77', '27.3'],
  [150, 15, 14, 10, '42.74', '33.6'],
  [150, 19, 14, 10, '53.38', '41.9'],
  [175, 12, 15, 11, '40.52', '31.8'],
  [175, 15, 15, 11, '50.21', '39.4'],
  [200, 15, 17, 12, '57.75', '45.3'],
  [200, 20, 17, 12, '76.00', '59.7'],
  [200, 25, 17, 12, '93.75', '73.6'],
  [250, 25, 24, 12, '119.4', '93.7'],
  [250, 35, 24, 18, '162.6', '128'],
] as const;
export const CHANNEL_ADDITION_2024_PRINTED = [
  [250, 90, 9, 13, 14, 7, '44.07', '34.6'],
  [250, 90, 11, 14.5, 17, 8.5, '51.17', '40.2'],
  [300, 90, 9, 13, 14, 7, '48.57', '38.1'],
  [300, 90, 10, 15.5, 19, 9.5, '55.74', '43.8'],
  [300, 90, 12, 16, 19, 9.5, '61.90', '48.6'],
  [380, 100, 10.5, 16, 18, 9, '69.39', '54.5'],
  [380, 100, 13, 16.5, 18, 9, '78.96', '62.0'],
  [380, 100, 13, 20, 24, 12, '85.71', '67.3'],
] as const;

export const SECTION_ADDITION_TRANSCRIPT = 'scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json';
const draftUrl = 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0400JISG3192_20240724.pdf';
function section(catalog: 'equalAngle' | 'channel', size: string, h: number, b: number,
  tw: number, tf: number, root: number, tip: number, area: string, mass: string) {
  const table = catalog === 'equalAngle' ? 8 : 12;
  const citation = { url: draftUrl,
    locator: `JISF G 3192 原案 表${table}, 2024-07-24 PDF p${table === 8 ? 14 : 18}; ${SECTION_ADDITION_TRANSCRIPT}` };
  const source = <T>(value: T) => ({ kind: 'source' as const, value, citation });
  const computed = (value: number, formula: string) => ({ kind: 'computed' as const, value, formula, citation });
  const dimensions: Readonly<Record<string, ReturnType<typeof dimension>>> = catalog === 'equalAngle'
    ? { a: dimension(h), b: dimension(b), thickness: dimension(tw) }
    : { height: dimension(h), width: dimension(b), webThickness: dimension(tw), flangeThickness: dimension(tf) };
  function dimension(value: number) { return source(value); }
  const polygon = catalog === 'equalAngle' ? tw * (h + b - tw) : h * tw + 2 * tf * (b - tw);
  const radii = root ** 2 - (catalog === 'equalAngle' ? 2 : 1) * tip ** 2;
  const turn = 85 * Math.PI / 180;
  const factor = catalog === 'equalAngle' ? 1 - Math.PI / 4 : 2 * Math.tan(turn / 2) - turn;
  return { key: `SS400:${catalog}:${size}`, grade: 'SS400' as const, catalog, size, dimensions,
    rootRadiusMm: source(root), tipRadiusMm: source(tip),
    printedAreaCm2: source(area), printedMassKgPerM: source(mass),
    areaMm2: source(Number(area) * 100), massKgPerM: source(Number(mass)),
    jisAreaMm2: computed(polygon + (catalog === 'equalAngle' ? 0.215 : 0.349) * radii,
      catalog === 'equalAngle' ? 't(2A−t) + 0.215(r1²−2r2²), table 6'
        : 'H t1 + 2 t2(B−t1) + 0.349(r1²−r2²), table 6'),
    exactAreaMm2: computed(polygon + factor * radii,
      catalog === 'equalAngle' ? 't(2A−t) + (1−π/4)(r1²−2r2²)'
        : 'H t1 + 2 t2(B−t1) + (2tan(85°/2)−85π/180)(r1²−r2²)'),
    legacyPolygonAreaMm2: computed(polygon, catalog === 'equalAngle' ? 't(2A−t)' : 'H t1 + 2 t2(B−t1)'),
    standardLengthsMm: { kind: 'unverified' as const, value: null, reason: 'No stock lengths in the draft transcript.' },
  };
}

export const ANGLE_ADDITION_ORACLE = ANGLE_ADDITION_PRINTED.map(([a, t, root, tip, area, mass]) =>
  section('equalAngle', `L ${a}×${a}×${t}`, a, a, t, t, root, tip, area, mass));
export const CHANNEL_ADDITION_CATALOG_ORACLE = CHANNEL_ADDITION_2024_PRINTED.map(([h, b, tw, tf, root, tip, area, mass]) =>
  section('channel', `[ ${h}×${b}×${tw}×${tf}`, h, b, tw, tf, root, tip, area, mass));
export const STEEL_SECTION_ADDITION_ORACLE = [...ANGLE_ADDITION_ORACLE, ...CHANNEL_ADDITION_CATALOG_ORACLE];

/** Six persisted strings, in the same append-only order as the product matrix. */
export const SECTION_ADDITION_SAVED_OPTIONS = [
  ['SS400:equalAngle:L 120×120×8', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 130×130×9', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 130×130×12', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 130×130×15', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 150×150×12', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 150×150×15', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 150×150×19', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 175×175×12', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 175×175×15', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 200×200×15', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 200×200×20', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 200×200×25', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 250×250×25', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:equalAngle:L 250×250×35', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssAngleDraft'],
  ['SS400:channel:[ 250×90×9×13', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssChannelDraft'],
  ['SS400:channel:[ 250×90×11×14.5', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssChannelDraft'],
  ['SS400:channel:[ 300×90×9×13', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssChannelDraft'],
  ['SS400:channel:[ 300×90×10×15.5', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssChannelDraft'],
  ['SS400:channel:[ 300×90×12×16', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssChannelDraft'],
  ['SS400:channel:[ 380×100×10.5×16', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssChannelDraft'],
  ['SS400:channel:[ 380×100×13×16.5', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssChannelDraft'],
  ['SS400:channel:[ 380×100×13×20', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'ssChannelDraft'],
] as const;
export const SECTION_ADDITION_EDITION_ORACLE = SECTION_ADDITION_SAVED_OPTIONS.map(([key]) =>
  [key, 'JIS G 3192', 'JIS G 3192', '2024'] as const);
