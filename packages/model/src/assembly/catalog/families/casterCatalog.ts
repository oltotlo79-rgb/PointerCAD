/**
 * 族: キャスター(利用者の回答 2026-11-18 15:5x の (1)「車輪の形も作る」。設計は担当の wip/caster/design.md)。製造元の名前・型番・品名は書かない。
 * 行の表 `casterRows.ts` は担当の道具が、型番ごとの値の読み 2 本で不確かの印なしで一致した型番だけから生成する(揃わない型番は入れない)。
 *
 * - 形は profiles/casterShape.ts(取付けの板かねじ・簡略の箱のフォーク・車輪の円柱)。旋回の向き・止めの機構・車輪の溝やゴムの形は作らない(印)。
 * - 差込み(パイプの中へ差す軸)の行は、軸の外径の記入が無いので軸を作らない(取付けの種類 none、印)。全体の高さは取付けの座の上の面まで。
 *   部品表と高さの検討に使い、パイプへ差し込む合わせ(合致)には使えない(note に書く)。
 * - 車輪とフォークの材料が違う行がほとんどなので、密度を持たず、部品表の材質は資料の材質の文字、質量は資料の 1 個の値だけ
 *   (部位ごとに材料の違う行の決まり。統括の決定 2026-11-18 08:1x)。資料の質量が無い行は質量を出さない。
 * - 耐荷重などの資料の値は持たない。
 */
import { findMetricThread } from '../../../thread/metricThread.js';
import { withName } from '../../standard/partPrimitives.js';
import { buildCasterPart, casterVolume, type CasterDimensions, type CasterMount } from '../profiles/casterShape.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { CASTER_RECORDS } from './casterRows.js';

/** キャスターの行(数は資料の記入のまま)。 */
export interface CasterRecord {
  readonly key: string;
  readonly size: string;
  /** 資料の番号(1 か 2)。出どころの題に出す。 */
  readonly book: 1 | 2;
  readonly page: number;
  /** 自在(旋回する)か固定か。形は同じで、呼びと印にだけ出す。 */
  readonly swivel: boolean;
  /** 止め付きか(止めは作らず印)。 */
  readonly brake: boolean;
  readonly wheelDiameter: number;
  readonly wheelWidth: number;
  readonly offset: number;
  readonly height: number;
  readonly mount: CasterMount;
  /** 部品表の材質の文字(一般の材料の語。部位ごと)。 */
  readonly materialText: string;
  readonly massG: number | null;
  readonly simplified: readonly string[];
  /** カタログに記入が無く、製造元が公開している一覧(1 つの資料)の値を使った寸法(車輪の幅と双輪のすき間。見た目の寸法に限る)。 */
  readonly singleSource?: readonly ('wheelWidth' | 'twinGap')[];
  /** 差込みの軸の長さ(取付けの座の上の面〜軸の先端。取付けの種類 none の行で、2 本の読みで決まった時だけ。形には使わない)。 */
  readonly pinLength?: number;
  /** 双輪の 2 輪の内側の面の間(すき間)。双輪の wheelWidth は 1 輪の幅(一覧の全体の幅とすき間から道具が作った)。 */
  readonly twinGap?: number;
}

const INSERT_NOTE = '差込みの軸は作っていない(軸の外径の記入が無い)。部品表と高さの検討に使え、パイプへ差し込む合わせ(合致)には使えない。';

const SINGLE_SOURCE_NOTE = '車輪の幅: この寸法は 1 つの資料の値(製造元が公開している車輪の幅の一覧。一覧の車輪の径がカタログの径と同じ型番だけ)。';

const TWIN_NOTE = '車輪の幅とすき間: この寸法は 1 つの資料の値から作った(製造元が公開している車輪の幅の一覧の、全体の幅〔両輪の外側の面の間〕と'
  + '両輪の内側の面の間から、1 輪の幅 =(全体の幅 − 内側の間)÷ 2。1 輪の幅は外側の張り出しを含む。一覧の車輪の径がカタログの径と同じ型番だけ)。';

const TITLES: Readonly<Record<1 | 2, string>> = {
  1: '資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', 2: '資料 2 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)',
};

/** 取付けの種類の欄の数(板 1・ねじ 2・作らない 3)。 */
const MOUNT_CODES: Readonly<Record<CasterMount['kind'], number>> = { plate: 1, stem: 2, none: 3 };

function rowOf(record: CasterRecord): CatalogItemRow {
  const dims: Record<string, number> = { mount: MOUNT_CODES[record.mount.kind], swivel: record.swivel ? 1 : 0, brake: record.brake ? 1 : 0,
    wheelDiameter: record.wheelDiameter, wheelWidth: record.wheelWidth, offset: record.offset, height: record.height };
  if (record.mount.kind === 'plate') {
    Object.assign(dims, { plateWidth: record.mount.width, plateDepth: record.mount.depth, plateThickness: record.mount.thickness,
      holeCount: record.mount.holes.length });
    record.mount.holes.forEach(([x, y, size], index) => Object.assign(dims, { [`hole${index}X`]: x, [`hole${index}Y`]: y, [`hole${index}D`]: size }));
  } else if (record.mount.kind === 'stem') {
    Object.assign(dims, { stemDiameter: findMetricThread(record.mount.thread)?.diameter ?? NaN, stemLength: record.mount.length });
  } else if (record.pinLength !== undefined) {
    dims.pinLength = record.pinLength;
  }
  if (record.twinGap !== undefined) dims.wheelGap = record.twinGap;
  if (record.massG !== null) dims.massG = record.massG;
  const mass = record.massG === null ? '質量は資料に記入が無いので出さない' : '質量は資料の 1 個の値';
  const single = record.singleSource?.includes('wheelWidth') === true;
  const locator = `PDF ${record.page} 頁 キャスターの図(寸法)と質量の記入${single ? '／車輪の幅は製造元が公開している車輪の幅の一覧' : ''}`;
  const sourceNote = record.twinGap === undefined ? SINGLE_SOURCE_NOTE : TWIN_NOTE;
  return {
    key: record.key, size: record.size, standardLabel: '製造元の寸法に合わせた物', materialLabel: record.materialText, dims,
    evidence: { title: TITLES[record.book], edition: null, locator, reference: '' },
    verification: 'manufacturer-catalog', verified: true,
    note: `形は簡略(${record.simplified.join('・')})。${mass}${single ? `。${sourceNote}` : ''}`
      + (record.mount.kind === 'none' ? `${single ? '' : '。'}${INSERT_NOTE}` : ''),
    simplified: record.simplified,
  };
}

/** 行の欄からキャスターの寸法に戻す(欄が欠けた行は null)。 */
export function casterDimensionsOf(row: CatalogItemRow): CasterDimensions | null {
  const value = (key: string): number => row.dims[key] ?? NaN;
  const gap = row.dims.wheelGap;
  const base = { wheelDiameter: value('wheelDiameter'), wheelWidth: value('wheelWidth'), offset: value('offset'), height: value('height'),
    ...(gap === undefined ? {} : { twinGap: gap }) };
  if (value('mount') === 1) {
    const holes = Array.from({ length: value('holeCount') || 0 }, (_, index): readonly [number, number, number] =>
      [value(`hole${index}X`), value(`hole${index}Y`), value(`hole${index}D`)]);
    return { ...base, mount: { kind: 'plate', width: value('plateWidth'), depth: value('plateDepth'), thickness: value('plateThickness'), holes } };
  }
  if (value('mount') === 2) return { ...base, mount: { kind: 'stem', thread: `M${String(value('stemDiameter'))}`, length: value('stemLength') } };
  if (value('mount') === 3) return { ...base, mount: { kind: 'none' } };
  return null;
}

/** キャスターの族を作る(行の表を渡す。検査は汎用の行で同じ作り方を確かめる)。 */
export function createCasterFamily(records: readonly CasterRecord[]): CatalogFamily {
  return {
    id: 't-slot-caster', group: 'aluminumFrame', kindKey: 'catalog.frame.kind.caster', catalogRevision: 't-slot-caster-2026-11-r1',
    generatorRevision: 'caster-1', options: [], stock: 'count', diagram: 'caster', rows: records.map(rowOf),
    build: (row) => {
      const dims = casterDimensionsOf(row);
      const part = dims === null ? null : buildCasterPart(dims);
      return part === null ? null : withName(part, row.size);
    },
    nominalVolume: (row) => {
      const dims = casterDimensionsOf(row);
      return dims === null ? null : casterVolume(dims);
    },
    nominalMassG: (row) => row.dims.massG ?? null,
    partName: (row) => row.size,
  };
}

/** キャスターの族(行の表は読みの 2 段目の後に道具が書く)。 */
export const CASTER_FAMILY: CatalogFamily = createCasterFamily(CASTER_RECORDS);
