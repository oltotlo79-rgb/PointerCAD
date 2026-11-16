/**
 * 族: オイルシール(寸法を指定して作る汎用の形)。M-30(設計 §2.3)。
 *
 * 規格の寸法の行は持たない。取れた資料は製造元の形式ごとの品ぞろえの表だけで、JIS B 2402-1 の寸法系列の行を
 * 出どころつきで決められないため(統括の判断 2026-11-16 06:0x: 製造元の品ぞろえの行を規格部品の行として入れない)。
 * 利用者が 内径(軸径)・外径・幅 を式で入れ、その輪を作る。初めの値は、どの製造元の値でもない丸めた例(30・50・10)。
 * 形はリップ・金属環・ばねを入れない輪の簡略形状(`profiles/bush.ts` と同じ作り)。範囲は形が成り立つ条件だけ
 * (どれも正、内径 < 外径。根拠の無い上限は置かない)。質量は全体をゴムとした概算。
 */
import { evaluateExpression } from '@pointercad/expression';

import { buildBushPart, bushVolume, type BushDimensions } from '../profiles/bush.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 資料の値を使わない族の出どころの欄(題に、規格の行ではない事を書く。資料の番号・SHA・頁は無い)。 */
const OIL_SEAL_EVIDENCE = {
  title: '寸法は利用者の指定(資料・規格の値を使わない汎用の形)',
  edition: null,
  url: '',
  locator: '初めの値は丸めた例(どの製造元の値でもない)',
  sha256: '',
  fetchedDate: '',
} as const;

const OIL_SEAL_ROWS: readonly CatalogItemRow[] = [{
  key: 'specified',
  size: '寸法指定',
  standardLabel: '寸法指定(規格の行ではない)',
  materialLabel: 'ゴム',
  densityMaterialId: 'rubber',
  dims: {},
  evidence: OIL_SEAL_EVIDENCE,
  verification: 'unverified',
  verified: false,
  note: '',
}];

function numberOf(values: Readonly<Record<string, string>>, key: string): number {
  const result = evaluateExpression(values[key] ?? '');
  return result.ok ? result.value.value : NaN;
}

function dimensionsOf(values: Readonly<Record<string, string>>): BushDimensions {
  return { innerDiameter: numberOf(values, 'innerDiameter'), outerDiameter: numberOf(values, 'outerDiameter'),
    length: numberOf(values, 'width') };
}

function sealName(values: Readonly<Record<string, string>>): string {
  const dims = dimensionsOf(values);
  return `オイルシール(寸法指定) 内径${dims.innerDiameter}×外径${dims.outerDiameter}×幅${dims.length}`;
}

export const OIL_SEAL_FAMILY: CatalogFamily = {
  id: 'oil-seal-specified',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.oilSeal',
  catalogRevision: 'oil-seal-specified-2026-11-r1',
  generatorRevision: 'bush-1',
  options: [
    { key: 'innerDiameter', kind: 'lengthExpression', labelKey: 'catalog.mechanical.ring.innerDiameter', defaultValue: '30' },
    { key: 'outerDiameter', kind: 'lengthExpression', labelKey: 'catalog.mechanical.ring.outerDiameter', defaultValue: '50' },
    { key: 'width', kind: 'lengthExpression', labelKey: 'catalog.mechanical.ring.width', defaultValue: '10' },
  ],
  stock: 'count',
  diagram: 'sealRing',
  rows: OIL_SEAL_ROWS,
  build: (_row, values) => buildBushPart(dimensionsOf(values), sealName(values)),
  nominalVolume: (_row, values) => bushVolume(dimensionsOf(values)),
  partName: (_row, values) => sealName(values),
};
