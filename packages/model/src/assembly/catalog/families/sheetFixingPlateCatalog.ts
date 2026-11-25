import { withName } from '../../standard/partPrimitives.js';
import { buildJoinPlatePart, joinPlateVolume, type JoinPlateDimensions } from '../profiles/frameParts.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

const MATERIALS = { pvc: '制電塩ビ（透明）', pet: 'PET（透明）' } as const;
type Material = keyof typeof MATERIALS;

const PLATES = [
  { length: 75, holeCount: 2, holePitch: 35, massG: { pvc: 10, pet: 9 } },
  { length: 190, holeCount: 2, holePitch: 150, massG: { pvc: 26, pet: 24 } },
  { length: 340, holeCount: 3, holePitch: 150, massG: { pvc: 47, pet: 43 } },
] as const;

function plateRow(plate: typeof PLATES[number], material: Material): CatalogItemRow {
  const { length, holeCount, holePitch } = plate;
  const materialLabel = MATERIALS[material];
  return {
    key: `sheet-plate-${length}-${material}`,
    size: `シート押さえ板 ${length} mm・${materialLabel}`,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel,
    dims: { length, width: 20, thickness: 5, holeDiameter: 7, holeCount, holePitch, massG: plate.massG[material] },
    evidence: { title: '製造元の寸法図と個別製品仕様', edition: null, locator: '外形・通し穴・材質・質量', reference: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    note: '長手方向の両端から最寄りの穴の中心まで 20 mm。質量は一枚の公称値。',
  };
}

function dimensionsOf({ dims }: CatalogItemRow): JoinPlateDimensions {
  return {
    length: dims.length ?? NaN,
    width: dims.width ?? NaN,
    thickness: dims.thickness ?? NaN,
    holeDiameter: dims.holeDiameter ?? NaN,
    holeCount: dims.holeCount ?? NaN,
    holePitch: dims.holePitch ?? NaN,
  };
}

export const SHEET_FIXING_PLATE_FAMILY: CatalogFamily = {
  id: 'sheet-fixing-plate',
  group: 'aluminumFrame',
  kindKey: 'catalog.board.kind.sheetFixingPlate',
  catalogRevision: 'sheet-fixing-plate-2026-11-r1',
  generatorRevision: 'sheet-fixing-plate-1',
  options: [],
  stock: 'count',
  diagram: 'joinPlate',
  rows: PLATES.flatMap((plate) => [plateRow(plate, 'pvc'), plateRow(plate, 'pet')]),
  build: (row) => {
    const document = buildJoinPlatePart(dimensionsOf(row));
    return document === null ? null : withName(document, row.size);
  },
  nominalVolume: (row) => joinPlateVolume(dimensionsOf(row)),
  nominalMassG: (row) => row.dims.massG ?? null,
  partName: (row) => row.size,
};
