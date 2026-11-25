/**
 * 族: 資料 1 のパネルボード・ベースプレート(板の族。統括の決定 2026-11-18 13:2x の (3))。製造元の名前・型番は書かない
 * (呼びは板の種類の一般の語・材質・板厚)。行の表 `panelBoardRows.ts` は担当の道具が 14 回目の読み(2 本が一致した欄)から生成する。
 *
 * - 定尺の族: 行が幅 × 高さを持つ。欄は無い。
 * - 注文の寸法の族: 幅と高さを欄で入れる(式)。行のサイズの上限(資料のサイズ MAX)に収まらない寸法は形を作らない(向きを入れ替えて収まればよい)。
 * - 形は箱(幅 × 高さ × 板厚)。網目・パンチングの穴・中空の脚・気泡・表面材は作らず、行の簡略の印に出す。
 * - 質量: 面積あたりの質量(kg/m²)を持つ行は 面積 × 面積あたりの質量、比重だけを持つ行は 体積 × 比重、どちらも無い行は
 *   部品表が形の体積 × 行の材質の密度で出す(null を返す)。
 */
import { evaluateExpression } from '@pointercad/expression';

import { withName } from '../../standard/partPrimitives.js';
import { fitsPanelMax } from '../profiles/panelBoard.js';
import { canMachinePanelBoard, makeMachinedPanelBoard, panelBoardHole, PANEL_HOLE_OPTIONS } from '../profiles/panelBoardMachining.js';
import type { CatalogFamily, CatalogItemRow, CatalogOptionSpec } from '../types.js';
import { PANEL_BOARD_RECORDS } from './panelBoardRows.js';

/** 板の行(数は資料の記入のまま。単位の換算〔g/m² → kg/m²〕だけは道具がする)。 */
export interface PanelBoardRecord {
  readonly key: string;
  readonly size: string;
  /** 元の表の紙面。個別製品仕様に紙面が無い場合は null。 */
  readonly page: number | null;
  /** 部品表の材質の欄の文字(一般の材料の語)。 */
  readonly materialLabel: string;
  /** 密度の表の材質(アルミ・鋼など)。密度の表に無い材料(樹脂・木など)は持たない。 */
  readonly densityMaterialId?: string;
  /** 材質の指定が無い場合に既定の鋼の密度を使わない。 */
  readonly omitDefaultDensity?: true;
  readonly thickness: number;
  /** 面積あたりの質量(kg/m²)。記入の無い行は null。 */
  readonly massKgPerM2: number | null;
  /** 比重。記入の無い行は null。 */
  readonly specificGravity: number | null;
  /** 定尺の行の幅 × 高さ(注文の寸法の行は null)。 */
  readonly fixedSize: readonly [number, number] | null;
  /** 注文の寸法の行の上限(資料のサイズ MAX。定尺の行・記入の無い行は null)。 */
  readonly maxSize: readonly [number, number] | null;
  readonly simplified: readonly string[];
  /**
   * サイズの決め方の備考(行の note の末に添える)。資料のサイズの列の値を定尺として入れた行だけ「サイズは資料のサイズ列の値。定尺か上限かの語は資料に無い」
   * (統括の決定 2026-11-18 14:4x)。ほかの行は持たない。
   */
  readonly sizeNote?: string;
}

const EVIDENCE_TITLE = '資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)';
const GENERATOR_REVISION = 'panel-board-1';
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 400;

/**
 * 注文の寸法の行の既定の値。行の上限(資料のサイズ MAX)に既定の 600 × 400 が収まらない行は、幅を上限の長い辺まで、高さを上限の短い辺まで
 * 縮めた値にする(収まる行と上限の無い行は 600 × 400 のまま)。選んだまま置いて断られないため。
 */
function defaultWithin(row: CatalogItemRow, base: number, side: 'long' | 'short'): string {
  const { maxWidth, maxHeight } = row.dims;
  if (maxWidth === undefined || maxHeight === undefined) return String(base);
  return String(Math.min(base, side === 'long' ? Math.max(maxWidth, maxHeight) : Math.min(maxWidth, maxHeight)));
}

const WIDTH_SPEC: CatalogOptionSpec = { key: 'width', kind: 'lengthExpression', labelKey: 'catalog.board.option.width', defaultValue: String(DEFAULT_WIDTH),
  rowDefault: (row) => defaultWithin(row, DEFAULT_WIDTH, 'long') };
const HEIGHT_SPEC: CatalogOptionSpec = { key: 'height', kind: 'lengthExpression', labelKey: 'catalog.board.option.height',
  defaultValue: String(DEFAULT_HEIGHT), rowDefault: (row) => defaultWithin(row, DEFAULT_HEIGHT, 'short') };

/** 欄の値の長さ(mm。式として読めない・正でない時は NaN)。 */
function lengthOfKey(values: Readonly<Record<string, string>>, key: string): number {
  const result = evaluateExpression(values[key] ?? '');
  return result.ok && result.value.value > 0 ? result.value.value : NaN;
}

function noteOf(record: PanelBoardRecord): string {
  const mass = record.massKgPerM2 !== null ? '質量は面積 × 資料の面積あたりの質量' : record.specificGravity !== null ? '質量は体積 × 資料の比重'
    : record.omitDefaultDensity === true ? '質量には密度の材質指定が必要' : '質量は形の体積 × 材質の密度';
  const text = record.simplified.length > 0 ? `形は簡略(${record.simplified.join('・')})。${mass}` : mass;
  return record.sizeNote === undefined ? text : `${text}。${record.sizeNote}`;
}

function rowOf(record: PanelBoardRecord): CatalogItemRow {
  const dims: Record<string, number> = { thickness: record.thickness };
  if (record.massKgPerM2 !== null) dims.massKgPerM2 = record.massKgPerM2;
  if (record.specificGravity !== null) dims.specificGravity = record.specificGravity;
  if (record.fixedSize !== null) Object.assign(dims, { width: record.fixedSize[0], height: record.fixedSize[1] });
  if (record.maxSize !== null) Object.assign(dims, { maxWidth: record.maxSize[0], maxHeight: record.maxSize[1] });
  return {
    key: record.key,
    size: record.size,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel: record.materialLabel,
    ...(record.densityMaterialId === undefined ? {} : { densityMaterialId: record.densityMaterialId }),
    ...(record.omitDefaultDensity === true ? { omitDefaultDensity: record.omitDefaultDensity } : {}),
    dims,
    evidence: record.page === null
      ? { title: '製造元の個別製品仕様', edition: null, locator: '板厚・サイズ上限・質量欄', reference: '' }
      : { title: EVIDENCE_TITLE, edition: null, locator: `PDF ${record.page} 頁 取扱品目の表(板厚・質量・サイズの記入)`, reference: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    note: noteOf(record),
    simplified: record.simplified,
  };
}

/** 板の 1 枚の質量(g)。面積あたりの質量か比重が無い行は null。 */
function boardMass(row: CatalogItemRow, area: number): number | null {
  const thickness = row.dims.thickness ?? NaN;
  if (!(Number.isFinite(area) && area > 0 && thickness > 0)) return null;
  const perArea = row.dims.massKgPerM2;
  if (perArea !== undefined) return area / 1e6 * perArea * 1000;
  const gravity = row.dims.specificGravity;
  return gravity === undefined ? null : area * thickness / 1000 * gravity;
}

function boardName(row: CatalogItemRow, values: Readonly<Record<string, string>>, fixed: boolean): string {
  if (fixed) return row.size;
  const name = `${row.size} ${values.width ?? ''}×${values.height ?? ''}`;
  const diameter = evaluateExpression(values.holeDiameter ?? '0');
  return diameter.ok && diameter.value.value > 0
    ? `${name} ⌀${values.holeDiameter} (${values.holeX}, ${values.holeY})` : name;
}

function boardArea(row: CatalogItemRow, size: readonly [number, number] | null, values: Readonly<Record<string, string>>): number | null {
  if (size === null || !size.every((length) => Number.isFinite(length) && length > 0)) return null;
  const hole = panelBoardHole(row, size, values);
  if (hole === false) return null;
  const removed = hole === null ? 0 : Math.PI * (hole.diameter / 2) ** 2;
  return size[0] * size[1] - removed;
}

/** 板の族を作る(行の表を渡す。検査は汎用の行で同じ作り方を確かめる)。 */
export function createPanelBoardFamilies(records: readonly PanelBoardRecord[]): { readonly fixed: CatalogFamily; readonly order: CatalogFamily } {
  const fixedRows = records.filter((record) => record.fixedSize !== null).map(rowOf);
  const orderRows = records.filter((record) => record.fixedSize === null).map(rowOf);
  const orderOptions = orderRows.some(canMachinePanelBoard) ? [WIDTH_SPEC, HEIGHT_SPEC, ...PANEL_HOLE_OPTIONS] : [WIDTH_SPEC, HEIGHT_SPEC];
  const base: Pick<CatalogFamily, 'group' | 'generatorRevision' | 'stock'> = { group: 'aluminumFrame', generatorRevision: GENERATOR_REVISION, stock: 'count' };
  const sizeOf = (row: CatalogItemRow, values: Readonly<Record<string, string>>, fixed: boolean): readonly [number, number] | null => {
    if (fixed) return [row.dims.width ?? NaN, row.dims.height ?? NaN];
    const [width, height] = [lengthOfKey(values, 'width'), lengthOfKey(values, 'height')];
    const { maxWidth, maxHeight } = row.dims;
    const max: readonly [number, number] | null = maxWidth === undefined || maxHeight === undefined ? null : [maxWidth, maxHeight];
    return !Number.isFinite(width * height) || !fitsPanelMax(width, height, max) ? null : [width, height];
  };
  const family = (id: string, kindKey: string, rows: readonly CatalogItemRow[], fixed: boolean): CatalogFamily => ({
    ...base, id, kindKey, catalogRevision: `${id}-2026-11-r1`, diagram: fixed ? 'panelBoardFixed' : 'panelBoardOrder',
    options: fixed ? [] : orderOptions, rows,
    partName: (row, values) => boardName(row, values, fixed),
    build: (row, values) => {
      const size = sizeOf(row, values, fixed);
      if (size === null) return null;
      const hole = fixed ? null : panelBoardHole(row, size, values);
      if (hole === false) return null;
      const part = makeMachinedPanelBoard({ width: size[0], height: size[1], thickness: row.dims.thickness ?? NaN }, hole);
      return part === null ? null : withName(part, boardName(row, values, fixed));
    },
    nominalVolume: (row, values) => {
      const area = boardArea(row, sizeOf(row, values, fixed), fixed ? {} : values);
      const thickness = row.dims.thickness ?? NaN;
      return area === null || !Number.isFinite(thickness) || thickness <= 0 ? null : area * thickness;
    },
    nominalMassG: (row, values) => {
      const area = boardArea(row, sizeOf(row, values, fixed), fixed ? {} : values);
      return area === null ? null : boardMass(row, area);
    },
  });
  return { fixed: family('panel-board-fixed', 'catalog.board.kind.fixed', fixedRows, true),
    order: family('panel-board-order', 'catalog.board.kind.order', orderRows, false) };
}

const FAMILIES = createPanelBoardFamilies(PANEL_BOARD_RECORDS);

/** 定尺の板の族(行が幅 × 高さを持つ)。 */
export const PANEL_BOARD_FIXED_FAMILY = FAMILIES.fixed;

/** 注文の寸法の板の族(幅と高さの欄。上限は行のサイズ MAX)。 */
export const PANEL_BOARD_ORDER_FAMILY = FAMILIES.order;
