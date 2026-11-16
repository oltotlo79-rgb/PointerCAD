/**
 * 族: 六角穴付き止めねじ JIS B 1177-2007(M2〜M24)。M-04(設計 §2.3)。先の形(くぼみ先・平先・棒先・とがり先)ごとに 1 つの族にする。
 *
 * 寸法は資料 K5-4(規格の抜粋の資料、PDF の SHA-256 と頁を下の出どころの欄に記録)の規格寸法の表の
 * ピッチ P・s(呼び)・t(最小)の 1 欄と 2 欄・dz(最大)・dp(最大)・z(最大)・dt(最大)と、在庫表の
 * 太線枠(JIS で推奨する長さの範囲)・網かけ(t の 1 欄、棒先の短い z、とがり先の 120° を当てる長さ)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(規格寸法の表は語の位置、網かけは頁の画素、太線枠は線から)は catalogOracles.fixture.ts の setScrew で、検査が照らす。
 * M1.6 はねじの表に無いので除く。JIS に無い M2.6・M14 と括弧の長さは入れない。
 * **長さは利用者が式で入れ、JIS で推奨する範囲(太線枠の最も短い長さ〜最も長い長さ)の中だけで作る**(資料の注で、範囲の外の長さには
 * 網かけの決まりを当てないため)。長さが網かけの最も長い長さ以下なら、六角穴の深さは 1 欄・棒先は短い z・とがり先は 120°、
 * それより長ければ 2 欄・長い z・90°(資料の注の決まり。網かけの長さの間の長さも短い形にする)。
 * 形は `profiles/setScrew.ts` の簡略形状(先のくぼみ・面取り・丸みは入れない)。
 */
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildSetScrewPart, setScrewVolume, type SetScrewDimensions, type SetScrewPoint } from '../profiles/setScrew.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const SET_SCREW_EVIDENCE = {
  title: '資料 K5-4 六角穴付き止めねじの規格の抜粋(JIS B 1177-2007)',
  edition: '2007',
  url: '',
  locator: 'PDF 28 頁(冊子 87 頁)規格寸法の表: d・P・s(呼び)・t(最小)1 欄と 2 欄・dz(最大)・dp(最大)・z(最大)・dt(最大)、'
    + 'PDF 29〜30 頁(冊子 88〜89 頁)在庫表: 太線枠(JIS で推奨する長さの範囲)と網かけ(t の 1 欄・短い棒先・とがり先 120° を当てる長さ)',
  sha256: '908dc5efd20f7d017641ad4d2e0e6c53082687067dcd152d42f3986168312d71',
  fetchedDate: '2026-11-16',
} as const;

type SetScrewPointKind = 'cup' | 'flat' | 'dog' | 'cone';

/** [ねじの呼び, d, P, s, t 1 欄, t 2 欄, くぼみ先 dz, 平先 dp, 棒先 dp, 短い棒先 z, 長い棒先 z, とがり先 dt](mm)。 */
const DIMENSIONS: readonly (readonly [string, number, number, number, number, number, number, number, number, number, number, number])[] = [
  ['M2', 2, 0.4, 0.9, 0.8, 1.7, 1, 1, 1, 0.75, 1.25, 0.5],
  ['M2.5', 2.5, 0.45, 1.3, 1.2, 2, 1.2, 1.5, 1.5, 0.88, 1.5, 0.65],
  ['M3', 3, 0.5, 1.5, 1.2, 2, 1.4, 2, 2, 1, 1.75, 0.75],
  ['M4', 4, 0.7, 2, 1.5, 2.5, 2, 2.5, 2.5, 1.25, 2.25, 1],
  ['M5', 5, 0.8, 2.5, 2, 3, 2.5, 3.5, 3.5, 1.5, 2.75, 1.25],
  ['M6', 6, 1, 3, 2, 3.5, 3, 4, 4, 1.75, 3.25, 1.5],
  ['M8', 8, 1.25, 4, 3, 5, 5, 5.5, 5.5, 2.25, 4.3, 2],
  ['M10', 10, 1.5, 5, 4, 6, 6, 7, 7, 2.75, 5.3, 2.5],
  ['M12', 12, 1.75, 6, 4.8, 8, 8, 8.5, 8.5, 3.25, 6.3, 3],
  ['M16', 16, 2, 8, 6.4, 10, 10, 12, 12, 4.3, 8.36, 4],
  ['M20', 20, 2.5, 10, 8, 12, 14, 15, 15, 5.3, 10.36, 5],
  ['M24', 24, 3, 12, 10, 15, 16, 18, 18, 6.3, 12.43, 6],
];

/** 先の形ごとの [太線枠の最も短い長さ, 最も長い長さ, 網かけの最も長い長さ](呼びの順は DIMENSIONS と同じ、mm)。 */
const LENGTHS: Readonly<Record<SetScrewPointKind, readonly (readonly [number, number, number])[]>> = {
  cup: [[2, 10, 2.5], [2.5, 12, 3], [3, 16, 4], [4, 20, 5], [5, 25, 5], [6, 30, 6], [8, 40, 8], [10, 50, 10], [12, 60, 12],
    [16, 60, 16], [20, 60, 20], [25, 60, 25]],
  flat: [[2, 10, 3], [2.5, 12, 3], [3, 16, 3], [4, 20, 4], [5, 25, 5], [6, 30, 6], [8, 40, 8], [10, 50, 10], [12, 60, 12],
    [16, 60, 16], [20, 60, 20], [25, 60, 25]],
  dog: [[2.5, 10, 3], [3, 12, 4], [4, 16, 5], [5, 20, 6], [6, 25, 6], [8, 30, 8], [8, 40, 10], [10, 50, 12], [12, 60, 16],
    [16, 60, 20], [20, 60, 25], [25, 60, 30]],
  cone: [[2, 10, 3], [2.5, 12, 3], [3, 16, 4], [4, 20, 5], [5, 25, 6], [6, 30, 6], [8, 40, 8], [10, 50, 10], [12, 60, 12],
    [16, 60, 16], [20, 60, 20], [25, 60, 25]],
};

/** とがり先の円すいの角度(網かけの長さは 120°、それより長いものは 90°。資料の注 b))。 */
const CONE_ANGLE = { short: 120, long: 90 } as const;

function pointDims(kind: SetScrewPointKind, dims: readonly number[]): Readonly<Record<string, number>> {
  const [dz, flatDp, dogDp, zShort, zLong, dt] = dims;
  if (kind === 'cup') return { cupDiameter: dz ?? NaN };
  if (kind === 'flat') return { pointDiameter: flatDp ?? NaN };
  if (kind === 'dog') return { pointDiameter: dogDp ?? NaN, dogLengthShort: zShort ?? NaN, dogLengthLong: zLong ?? NaN };
  return { tipDiameter: dt ?? NaN };
}

function rowsOf(kind: SetScrewPointKind): readonly CatalogItemRow[] {
  return DIMENSIONS.map(([size, d, pitch, s, t1, t2, ...points], index): CatalogItemRow => {
    const [lengthMin, lengthMax, shortLengthMax] = LENGTHS[kind][index] ?? [NaN, NaN, NaN];
    return {
      key: size,
      size,
      standardLabel: 'JIS B 1177:2007',
      densityMaterialId: 'steel',
      dims: { nominalDiameter: d, pitch, socketWidth: s, socketDepthShort: t1, socketDepthLong: t2, lengthMin, lengthMax, shortLengthMax,
        ...pointDims(kind, points) },
      evidence: SET_SCREW_EVIDENCE,
      verification: 'manufacturer-catalog',
      verified: true,
      note: '',
    };
  });
}

function pointOf(kind: SetScrewPointKind, row: CatalogItemRow, short: boolean): SetScrewPoint {
  const dims = row.dims;
  if (kind === 'dog') {
    return { kind: 'dog', diameter: dims.pointDiameter ?? NaN, length: (short ? dims.dogLengthShort : dims.dogLengthLong) ?? NaN };
  }
  if (kind === 'cone') {
    return { kind: 'cone', tipDiameter: dims.tipDiameter ?? NaN, angleDegrees: short ? CONE_ANGLE.short : CONE_ANGLE.long };
  }
  return { kind: 'plain' };
}

/** 長さに合わせた形の寸法。JIS で推奨する範囲の外の長さは null。 */
function dimensionsOf(kind: SetScrewPointKind, row: CatalogItemRow, length: number): SetScrewDimensions | null {
  const dims = row.dims;
  if (!(length >= (dims.lengthMin ?? NaN) && length <= (dims.lengthMax ?? NaN))) return null;
  const short = length <= (dims.shortLengthMax ?? NaN);
  return { designation: row.size, nominalDiameter: dims.nominalDiameter ?? NaN, pitch: dims.pitch ?? NaN,
    socketWidth: dims.socketWidth ?? NaN, socketDepth: (short ? dims.socketDepthShort : dims.socketDepthLong) ?? NaN,
    point: pointOf(kind, row, short) };
}

const POINT_NAMES: Readonly<Record<SetScrewPointKind, { readonly label: string; readonly id: string; readonly kindKey: string }>> = {
  cup: { label: 'くぼみ先', id: 'set-screw-cup-point', kindKey: 'catalog.mechanical.kind.setScrewCup' },
  flat: { label: '平先', id: 'set-screw-flat-point', kindKey: 'catalog.mechanical.kind.setScrewFlat' },
  dog: { label: '棒先', id: 'set-screw-dog-point', kindKey: 'catalog.mechanical.kind.setScrewDog' },
  cone: { label: 'とがり先', id: 'set-screw-cone-point', kindKey: 'catalog.mechanical.kind.setScrewCone' },
};

function familyOf(kind: SetScrewPointKind): CatalogFamily {
  const names = POINT_NAMES[kind];
  const partName = (row: CatalogItemRow, values: Readonly<Record<string, string>>): string =>
    `六角穴付き止めねじ ${names.label} ${row.size}×${lengthText(values)}`;
  return {
    id: names.id,
    group: 'mechanical',
    kindKey: names.kindKey,
    catalogRevision: 'set-screw-2026-11-r1',
    generatorRevision: 'set-screw-1',
    // 既定の長さは呼びごとの範囲の最も短い長さ(範囲が呼びで大きく違い、全ての呼びで作れる 1 つの長さが無いため)。
    options: [lengthOptionSpec('10', (row) => String(row.dims.lengthMin))],
    stock: 'count',
    diagram: 'bolt',
    rows: rowsOf(kind),
    build: (row, values) => {
      const length = lengthOf(values);
      const dims = length === null ? null : dimensionsOf(kind, row, length.value);
      return length === null || dims === null ? null : buildSetScrewPart(dims, length, partName(row, values));
    },
    nominalVolume: (row, values) => {
      const length = lengthOf(values)?.value ?? NaN;
      const dims = dimensionsOf(kind, row, length);
      return dims === null ? null : setScrewVolume(dims, length);
    },
    partName,
  };
}

export const SET_SCREW_FAMILIES: Readonly<Record<SetScrewPointKind, CatalogFamily>> = {
  cup: familyOf('cup'),
  flat: familyOf('flat'),
  dog: familyOf('dog'),
  cone: familyOf('cone'),
};
