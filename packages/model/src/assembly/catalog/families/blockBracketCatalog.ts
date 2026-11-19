/**
 * 族: ブロック形のブラケット(t-slot-block-bracket)。資料 1 の、直方体に座ぐり穴を開けたブロック形の本体のうち、2 本の独立の読みで
 * 外形・穴・座ぐり・合う溝幅・質量が揃った行(blockBracketRows.ts。道具が生成し、検査が 2 本目の読みと照らす)。
 * 形は台本 profiles/blockBracket.ts(面と面の上の位置で穴を持つ一般の形)。質量は資料の 1 個の値。製造元の名前・型番は書かない。
 * 締結の自動判別の表には足さない(ブロックの向きと 2 つの面の決まりを決めてから)。
 */
import { withName } from '../../standard/partPrimitives.js';
import { blockBracketVolume, buildBlockBracketPart, type BlockDimensions, type BlockHole } from '../profiles/blockBracket.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { BLOCK_BRACKET_RECORDS } from './blockBracketRows.js';

/** 行の表の 1 行(道具が生成する)。holes は台本の穴の持ち方のまま。 */
export interface BlockBracketRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: number;
  readonly material: 'aluminum' | 'steel' | 'stainless';
  readonly page: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly holes: readonly BlockHole[];
  readonly massG: number;
  readonly simplified: readonly string[];
}

const MATERIAL_LABEL: Readonly<Record<BlockBracketRecord['material'], string>> = { aluminum: 'アルミ', steel: '鋼', stainless: 'ステンレス' };

function rowOf(record: BlockBracketRecord): CatalogItemRow {
  return {
    key: record.key,
    size: record.size,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel: MATERIAL_LABEL[record.material],
    densityMaterialId: record.material,
    dims: { slot: record.slot, width: record.width, depth: record.depth, height: record.height, holeCount: record.holes.length, massG: record.massG },
    evidence: { title: '資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', edition: null,
      locator: `PDF ${record.page} 頁 部品の図(寸法)と質量の記入`, reference: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    note: record.simplified.length > 0 ? `形は簡略(${record.simplified.join('・')})。質量は資料の 1 個の値` : '質量は資料の 1 個の値',
    simplified: record.simplified,
  };
}

const byKey = new Map(BLOCK_BRACKET_RECORDS.map((record) => [record.key, record]));

/** 行の鍵から台本の入力を引く(族の行と同じ鍵の行だけ)。 */
function blockBracketDimensions(row: CatalogItemRow): BlockDimensions | null {
  const record = byKey.get(row.key);
  return record === undefined ? null : { width: record.width, depth: record.depth, height: record.height, holes: record.holes };
}

export const BLOCK_BRACKET_FAMILY: CatalogFamily = {
  id: 't-slot-block-bracket',
  group: 'aluminumFrame',
  kindKey: 'catalog.frame.kind.blockBracket',
  catalogRevision: 't-slot-block-bracket-2026-11-r1',
  generatorRevision: 'block-bracket-1',
  diagram: 'blockBracket',
  options: [],
  stock: 'count',
  rows: BLOCK_BRACKET_RECORDS.map(rowOf),
  build: (row) => {
    const dims = blockBracketDimensions(row);
    const part = dims === null ? null : buildBlockBracketPart(dims);
    return part === null ? null : withName(part, row.size);
  },
  nominalVolume: (row) => {
    const dims = blockBracketDimensions(row);
    return dims === null ? null : blockBracketVolume(dims);
  },
  nominalMassG: (row) => {
    const mass = row.dims.massG ?? NaN;
    return mass > 0 ? mass : null;
  },
  partName: (row) => row.size,
};
