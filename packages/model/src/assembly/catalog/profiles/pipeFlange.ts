/**
 * 鋼製管フランジ(K-28 束 2)の簡略形状: 外径 D・厚さ t の円板(z ∈ [0, t])から、中心の穴(合う管の外径)と、中心円 C の上に等しい間隔で
 * 並ぶ n 個のボルト穴(径 h)を引く。ボルト穴は中心線をまたぐ向き(最初の穴は +X から 180° ÷ n 回した所)に置く。
 * 座(径 g・高さ f)・ハブ・面取りは作らない(行の注と部品表の「簡略形状」)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { appendBoolean, appendCylinder, origin, withName } from '../../standard/partPrimitives.js';

export interface PipeFlangeDimensions {
  /** 外径 D・厚さ t・中心の穴の径(mm)。 */
  readonly outerDiameter: number;
  readonly thickness: number;
  readonly boreDiameter: number;
  /** ボルト穴の中心円の径 C・穴の径 h(mm)と数 n。 */
  readonly boltCircleDiameter: number;
  readonly holeDiameter: number;
  readonly holeCount: number;
}

function dimensionsValid(dims: PipeFlangeDimensions): boolean {
  const values = [dims.outerDiameter, dims.thickness, dims.boreDiameter, dims.boltCircleDiameter, dims.holeDiameter];
  return values.every((value) => Number.isFinite(value) && value > 0) && Number.isInteger(dims.holeCount) && dims.holeCount >= 2
    && dims.boreDiameter + dims.holeDiameter < dims.boltCircleDiameter && dims.boltCircleDiameter + dims.holeDiameter < dims.outerDiameter
    && dims.boltCircleDiameter * Math.sin(Math.PI / dims.holeCount) > dims.holeDiameter;
}

/** 中心が (x, y) の、Z の向きの穴の円柱(z ∈ [0, height])。 */
function holeAt(document: PartDocument, x: number, y: number, diameter: number, height: number):
{ readonly document: PartDocument; readonly feature: PrimitiveFeature } {
  const created = createPrimitiveFeature(document, 'cylinder', origin(x, y, 0));
  const feature: PrimitiveFeature = { ...created,
    shape: { kind: 'cylinder', radius: expressionValueFromNumber(diameter / 2), height: expressionValueFromNumber(height) } };
  return { document: appendSolid(document, feature), feature };
}

/** フランジの形。寸法が作れない時は null。 */
export function buildPipeFlangePart(dims: PipeFlangeDimensions, name: string): PartDocument | null {
  if (!dimensionsValid(dims)) return null;
  const disk = appendCylinder(createEmptyPartDocument(), dims.outerDiameter / 2, expressionValueFromNumber(dims.thickness));
  const bore = appendCylinder(disk.document, dims.boreDiameter / 2, expressionValueFromNumber(dims.thickness));
  let cut = appendBoolean(bore.document, 'subtract', disk.feature.id, bore.feature.id);
  const radius = dims.boltCircleDiameter / 2;
  for (let index = 0; index < dims.holeCount; index += 1) {
    const angle = (2 * index + 1) * Math.PI / dims.holeCount;
    const hole = holeAt(cut.document, radius * Math.cos(angle), radius * Math.sin(angle), dims.holeDiameter, dims.thickness);
    cut = appendBoolean(hole.document, 'subtract', cut.feature.id, hole.feature.id);
  }
  return withName(cut.document, name);
}

/** 形の台本どおりの体積(mm³): 円板 − 中心の穴 − ボルト穴 n 個(穴どうし・穴と外周・中心の穴は重ならない)。 */
export function pipeFlangeVolume(dims: PipeFlangeDimensions): number | null {
  if (!dimensionsValid(dims)) return null;
  const area = (diameter: number): number => Math.PI * (diameter / 2) ** 2;
  return (area(dims.outerDiameter) - area(dims.boreDiameter) - dims.holeCount * area(dims.holeDiameter)) * dims.thickness;
}
