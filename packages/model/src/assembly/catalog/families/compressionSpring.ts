/**
 * 族: 圧縮コイルばね(寸法を指定して作る)。M-16(設計 §2.3・§5.7「ばねは表を持たず」)。
 *
 * 表(呼びの一覧)は持たず、利用者が 線径・コイル平均径・自由長・総巻数 を式で入れる。入力の項目の名前は
 * JIS B 2704-2:2018(コイルばねの仕様の表し方)の目次の項目に合わせた(下の `COMPRESSION_SPRING_EVIDENCE`。
 * 規格の本文・表は写していない。寸法の値は資料から取らない)。座巻きの形は、今のばねのフィーチャーが座巻きを作らないので
 * 入れない(形は簡略形状。`profiles/spring.ts`)。
 * 範囲(統括の指示 2026-11-16 02:2x の考え方: 根拠の無い上限は置かない): 資料に寸法の範囲は無いので上限は置かず、
 * 形が成り立つ条件だけで決める。線径・平均径・自由長は正、総巻数は 1 以上(1 巻き未満はコイルにならない)、
 * 加えて 線径 < 平均径(内径が正)、ピッチ > 線径(隣の巻きが重ならない)。成り立たない組は組まない(置く前に断る)。
 */
import { evaluateExpression } from '@pointercad/expression';

import {
  buildCompressionSpringPart, compressionSpringVolume, type CompressionSpringDimensions,
} from '../profiles/spring.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const COMPRESSION_SPRING_EVIDENCE = {
  title: '資料 K4-6 コイルばねの仕様の表し方(JIS B 2704-2:2018 のプレビュー。入力の項目の名前の根拠だけ)',
  edition: '2018',
  url: '',
  locator: '目次 5 圧縮コイルばね(本文の表と値は使わない)',
  sha256: '9ae56b3b13f6f8cbeea222ce3607244b42c5b57a469d48759cbb7cb448278ef1',
  fetchedDate: '2026-11-14',
} as const;

/** 表を持たない族の 1 行(寸法は全て指定の値から作る)。 */
const COMPRESSION_SPRING_ROWS: readonly CatalogItemRow[] = [{
  key: 'specified',
  size: '寸法指定',
  standardLabel: 'JIS B 2704-2:2018(仕様の表し方)',
  materialLabel: 'ばね鋼',
  densityMaterialId: 'steel',
  dims: {},
  evidence: COMPRESSION_SPRING_EVIDENCE,
  verification: 'final-standard',
  verified: true,
  note: '',
}];

function numberOf(values: Readonly<Record<string, string>>, key: string): number {
  const result = evaluateExpression(values[key] ?? '');
  return result.ok ? result.value.value : NaN;
}

function dimensionsOf(values: Readonly<Record<string, string>>): CompressionSpringDimensions {
  return { wireDiameter: numberOf(values, 'wireDiameter'), meanDiameter: numberOf(values, 'meanDiameter'),
    freeLength: numberOf(values, 'freeLength'), totalCoils: numberOf(values, 'totalCoils') };
}

function springName(values: Readonly<Record<string, string>>): string {
  const dims = dimensionsOf(values);
  return `圧縮コイルばね 線径${dims.wireDiameter}×平均径${dims.meanDiameter}×自由長${dims.freeLength}×${dims.totalCoils}巻`;
}

export const COMPRESSION_SPRING_FAMILY: CatalogFamily = {
  id: 'compression-spring',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.compressionSpring',
  catalogRevision: 'compression-spring-2026-11-r1',
  generatorRevision: 'spring-1',
  options: [
    { key: 'wireDiameter', kind: 'lengthExpression', labelKey: 'catalog.mechanical.spring.wireDiameter', defaultValue: '2' },
    { key: 'meanDiameter', kind: 'lengthExpression', labelKey: 'catalog.mechanical.spring.meanDiameter', defaultValue: '16' },
    { key: 'freeLength', kind: 'lengthExpression', labelKey: 'catalog.mechanical.spring.freeLength', defaultValue: '50' },
    { key: 'totalCoils', kind: 'numberExpression', labelKey: 'catalog.mechanical.spring.totalCoils', min: 1, defaultValue: '8' },
  ],
  stock: 'count',
  diagram: 'compressionSpring',
  rows: COMPRESSION_SPRING_ROWS,
  build: (_row, values) => buildCompressionSpringPart(dimensionsOf(values), springName(values)),
  nominalVolume: (_row, values) => compressionSpringVolume(dimensionsOf(values)),
  partName: (_row, values) => springName(values),
};
