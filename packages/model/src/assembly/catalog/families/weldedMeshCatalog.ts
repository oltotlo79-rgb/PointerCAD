import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument } from '../../../part/types.js';
import { origin, withName } from '../../standard/partPrimitives.js';
import { fitsPanelMax } from '../profiles/panelBoard.js';
import type { CatalogFamily, CatalogItemRow, CatalogOptionSpec } from '../types.js';

const DIMENSIONS = { wireDiameter: 3.2, minSize: 245, minEdge: 13.6, cutTolerance: 3 } as const;
const OPTIONS: readonly CatalogOptionSpec[] = [
  { key: 'width', kind: 'lengthExpression', labelKey: 'catalog.board.option.width', defaultValue: '600', min: DIMENSIONS.minSize },
  { key: 'height', kind: 'lengthExpression', labelKey: 'catalog.board.option.height', defaultValue: '400', min: DIMENSIONS.minSize },
];
const RECORDS = [
  { key: 'steel-30', material: '鋼（黒色塗装）', pitch: 30, massKgPerM2: 4.2, maximum: [963, 935] },
  { key: 'steel-50', material: '鋼（黒色塗装）', pitch: 50, massKgPerM2: 2.5, maximum: [963, 935] },
  { key: 'stainless-30', material: 'ステンレス', pitch: 30, massKgPerM2: 4.3, maximum: [2000, 1000] },
  { key: 'stainless-50', material: 'ステンレス', pitch: 50, massKgPerM2: 2.6, maximum: [2000, 1000] },
] as const;

/** One wire at each end of the interval count; the free tails have equal length. */
function edgeLayout(size: number, pitch: number): { readonly count: number; readonly edge: number } {
  const possible = Math.floor(size / pitch);
  const intervals = size < possible * pitch + 2 * DIMENSIONS.minEdge ? possible - 1 : possible;
  return { count: intervals + 1, edge: (size - intervals * pitch) / 2 };
}

function meshSize(row: CatalogItemRow, values: Readonly<Record<string, string>>): readonly [number, number] | null {
  const width = evaluateExpression(values.width ?? '');
  const height = evaluateExpression(values.height ?? '');
  const { maxWidth, maxHeight } = row.dims;
  if (!width.ok || !height.ok || maxWidth === undefined || maxHeight === undefined) return null;
  const result = [width.value.value, height.value.value] as const;
  return result.every((size) => Number.isFinite(size) && size >= DIMENSIONS.minSize)
    && fitsPanelMax(result[0], result[1], [maxWidth, maxHeight]) ? result : null;
}

function meshRow(record: typeof RECORDS[number]): CatalogItemRow {
  const [maxWidth, maxHeight] = record.maximum;
  return {
    key: record.key,
    size: `溶接金網 ${record.material}・線径 ${DIMENSIONS.wireDiameter} mm・ピッチ ${record.pitch} mm`,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel: record.material,
    dims: { maxWidth, maxHeight, thickness: 2 * DIMENSIONS.wireDiameter, wireDiameter: DIMENSIONS.wireDiameter, wirePitch: record.pitch, massKgPerM2: record.massKgPerM2 },
    evidence: { title: '製造元の寸法図と現行の訂正', edition: null, locator: '外形・線径・目の間隔・切断範囲・面積あたりの質量', reference: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    note: `切断公差は +0/−${DIMENSIONS.cutTolerance} mm。形は指定の寸法、質量は面積あたりの目安で計算。`,
    simplified: ['線は交差する二層の円柱（溶接によるつぶれ・盛り上がりと塗装層は省略）'],
  };
}

function appendWires(document: PartDocument, axis: 'x' | 'y', length: number, crossSize: number, pitch: number): PartDocument {
  const { count, edge } = edgeLayout(crossSize, pitch);
  const radius = DIMENSIONS.wireDiameter / 2;
  const shape = { kind: 'cylinder' as const, radius: expressionValueFromNumber(radius), height: expressionValueFromNumber(length) };
  let result = document;
  for (let index = 0; index < count; index++) {
    const across = -crossSize / 2 + edge + index * pitch;
    const start = axis === 'x' ? origin(-length / 2, across, radius) : origin(across, -length / 2, radius * 3);
    const wire = createPrimitiveFeature(result, 'cylinder', start, { kind: 'world', axis });
    result = appendSolid(result, { ...wire, shape });
  }
  return result;
}

function buildMesh(row: CatalogItemRow, values: Readonly<Record<string, string>>): PartDocument | null {
  const size = meshSize(row, values);
  const pitch = row.dims.wirePitch;
  if (size === null || (pitch !== 30 && pitch !== 50)) return null;
  const [width, height] = size;
  // Keep the two wire layers as simple bodies. This avoids a Boolean at every weld.
  const horizontal = appendWires(createEmptyPartDocument(), 'x', width, height, pitch);
  return withName(appendWires(horizontal, 'y', height, width, pitch), `${row.size} ${values.width}×${values.height}`);
}

export const WELDED_MESH_FAMILY: CatalogFamily = {
  id: 'welded-wire-mesh',
  group: 'aluminumFrame',
  kindKey: 'catalog.board.kind.weldedMesh',
  catalogRevision: 'welded-wire-mesh-2026-11-r1',
  generatorRevision: 'welded-wire-mesh-1',
  options: OPTIONS,
  stock: 'count',
  diagram: 'panelBoardOrder',
  rows: RECORDS.map(meshRow),
  build: buildMesh,
  nominalVolume: (row, values) => {
    const size = meshSize(row, values);
    const pitch = row.dims.wirePitch;
    if (size === null || (pitch !== 30 && pitch !== 50)) return null;
    const [width, height] = size;
    const totalLength = width * edgeLayout(height, pitch).count + height * edgeLayout(width, pitch).count;
    return Math.PI * (DIMENSIONS.wireDiameter / 2) ** 2 * totalLength;
  },
  nominalMassG: (row, values) => {
    const size = meshSize(row, values);
    const perArea = row.dims.massKgPerM2;
    return size === null || perArea === undefined ? null : size[0] * size[1] * perArea / 1000;
  },
  partName: (row, values) => `${row.size} ${values.width ?? ''}×${values.height ?? ''}`,
};
