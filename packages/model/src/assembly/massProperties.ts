/** アセンブリ全体の体積・質量・重心(FR-1101、P7 タスク40・43)。 */
import {
  DEFAULT_DENSITY_MATERIAL_ID,
  findDensityMaterial,
} from '../appearance/densityMaterials.js';
import { massFromVolume } from '../measure/massProperties.js';
import type { PartDocument } from '../part/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { applyPlacementToPoint, type RigidPlacement } from './placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from './types.js';

/** 将来 PartDocument に材質が加わった場合も同じ読み出し口で扱うための構造型。 */
export type MaterialBearingPartDocument = PartDocument & { readonly materialId?: string };

/**
 * 材質の優先順位を決める唯一の純関数。部品文書 → インスタンス → 鋼の順。
 * 現在の PartDocument には欄が無いので、通常は後ろ 2 つのどちらかになる。
 */
export function materialOf(
  component: AssemblyComponent,
  partDocument?: MaterialBearingPartDocument,
): string {
  return partDocument?.materialId ?? component.materialId ?? DEFAULT_DENSITY_MATERIAL_ID;
}

/** 部品座標で測ったボディ 1 つの質量特性。 */
export interface AssemblyMassBody {
  readonly volume: number;
  readonly centroid: Vec3;
}

/** 質量集計が解決結果から読む最小の形。 */
export interface AssemblyMassResolvedData {
  readonly partKeys: ReadonlyMap<string, string>;
  readonly bodies: ReadonlyMap<string, readonly AssemblyMassBody[]>;
  readonly documents?: ReadonlyMap<string, MaterialBearingPartDocument>;
}

export const PARTIAL_ASSEMBLY_MASS_MESSAGE = '一部の部品の質量が出せません';

export interface AssemblyMassProperties {
  /** 測れた部品の体積(mm³)。 */
  readonly volume: number;
  /** 全部測れたときの合計質量(g)。欠けがあれば null。 */
  readonly mass: number | null;
  /** 欠けがあっても得られた部品だけを足した質量(g)。 */
  readonly knownMass: number;
  /** 得られた質量で重み付けした世界座標の重心。 */
  readonly centroid: Vec3 | null;
  readonly partial: boolean;
  readonly message: string | null;
}

function finiteCentroid(value: Vec3): boolean {
  return value.every((coordinate) => Number.isFinite(coordinate));
}

/**
 * 抑制されていない部品を配置で世界座標へ移し、体積と質量を足す。
 * 密度の掛け算は既存の `massFromVolume` だけに任せる。
 */
export function assemblyMassProperties(
  assembly: AssemblyDocument,
  resolved: AssemblyMassResolvedData,
  placements: ReadonlyMap<string, RigidPlacement>,
): AssemblyMassProperties {
  let volume = 0;
  let knownMass = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedZ = 0;
  let partial = false;

  for (const component of assembly.components) {
    if (component.suppressed) continue;
    const partKey = resolved.partKeys.get(component.id);
    const bodies = partKey === undefined ? undefined : resolved.bodies.get(partKey);
    const placement = placements.get(component.id);
    const materialId = materialOf(
      component,
      partKey === undefined ? undefined : resolved.documents?.get(partKey),
    );
    const material = findDensityMaterial(materialId);
    if (bodies === undefined || placement === undefined || material === undefined || bodies.length === 0) {
      partial = true;
      continue;
    }
    let componentValid = true;
    for (const body of bodies) {
      if (!Number.isFinite(body.volume) || body.volume < 0 || !finiteCentroid(body.centroid)) {
        componentValid = false;
        break;
      }
    }
    if (!componentValid) {
      partial = true;
      continue;
    }
    for (const body of bodies) {
      const mass = massFromVolume(body.volume, material.density);
      const center = applyPlacementToPoint(placement, body.centroid);
      volume += body.volume;
      knownMass += mass;
      weightedX += center[0] * mass;
      weightedY += center[1] * mass;
      weightedZ += center[2] * mass;
    }
  }

  const centroid: Vec3 | null = knownMass > 0
    ? [weightedX / knownMass, weightedY / knownMass, weightedZ / knownMass]
    : null;
  return {
    volume,
    mass: partial ? null : knownMass,
    knownMass,
    centroid,
    partial,
    message: partial ? PARTIAL_ASSEMBLY_MASS_MESSAGE : null,
  };
}
