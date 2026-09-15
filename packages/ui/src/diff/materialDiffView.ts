import type { MaterialComparisonGeometry, MaterialDifferenceRegion } from '@pointercad/model';

export type MaterialRegionName = 'added' | 'removed' | 'common';
export type MaterialRegionSelection = MaterialRegionName | 'all';
export const MATERIAL_REGIONS: readonly MaterialRegionName[] = ['added', 'removed', 'common'];
export const MATERIAL_REGION_COLORS: Readonly<Record<MaterialRegionName, number>> = { added: 0x2fa778, removed: 0xe38b52, common: 0xa5adba };
export function selectedMaterialRegions(result: MaterialComparisonGeometry, selection: MaterialRegionSelection): readonly {
  readonly name: MaterialRegionName; readonly region: Extract<MaterialDifferenceRegion, { kind: 'material' }>;
}[] {
  const regions: { name: MaterialRegionName; region: Extract<MaterialDifferenceRegion, { kind: 'material' }> }[] = [];
  for (const name of MATERIAL_REGIONS) {
    const region = result[name];
    if ((selection === 'all' || name === selection) && region.kind === 'material') regions.push({ name, region });
  }
  return regions;
}
/** 比較で返された実三角形を囲む。座標の並べ替えや位置合わせ・間引きをしない。 */
export function materialDiffBounds(result: MaterialComparisonGeometry): { readonly center: readonly number[]; readonly span: number } | null {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const { region } of selectedMaterialRegions(result, 'all')) {
    const positions = region.mesh.positions;
    for (let index = 0; index < positions.length; index += 1) {
      const coordinate = positions[index], axis = index % 3;
      if (!Number.isFinite(coordinate)) return null;
      min[axis] = Math.min(min[axis], coordinate); max[axis] = Math.max(max[axis], coordinate); count += 1;
    }
  }
  if (count === 0) return null;
  const spans = max.map((value, axis) => value - min[axis]), span = Math.max(...spans);
  if (!(span > 0) || !Number.isFinite(span)) return null;
  return { span, center: min.map((value, axis) => value + spans[axis] / 2) };
}
