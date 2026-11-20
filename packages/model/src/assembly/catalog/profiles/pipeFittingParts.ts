/**
 * ねじ込み式管継手のキャップ・プラグ・六角ニップル・ブッシング(K-28 束 2)の簡略形状。軸は部品の Z。
 *
 * - キャップ: 外径 A1・高さ H の円柱から、開いた端(z = 0)からめねじ部の長さ l′ だけ、ねじの谷の径 d1 の穴を引く(頂部の丸み・帯は作らない)。
 * - プラグ: 四角の頭(二面幅 B・高さ b。z ∈ [−b, 0])と、おねじの円柱(外径 d・おねじ部の長さ l。z ∈ [0, l])の和(頭のぬすみは作らない)。
 * - 六角ニップル: 六角(呼び 2 以上は八角)の柱(二面幅 B。z ∈ [−(L − 2E), 0])と、両側のおねじの円柱(外径 d・長さ E)の和
 *   (中の穴は表に寸法が無いので作らない)。
 * - ブッシング: 六角(八角)の柱(二面幅 B。z ∈ [−(L − E), 0])と、外の呼びのおねじの円柱(外径 d・長さ E。z ∈ [0, E])の和から、
 *   中の呼びのねじの谷の径 d1 の穴を全長に引く。
 * ねじの山とテーパ・面取りは作らない(行の注と部品表の「簡略形状」)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { appendBoolean, appendCylinder, appendExtrude, origin, regularPolygonProfile, withName } from '../../standard/partPrimitives.js';

export type PipeFittingPartDimensions =
  | { readonly kind: 'cap'; readonly outerDiameter: number; readonly height: number; readonly boreDiameter: number; readonly boreDepth: number }
  | { readonly kind: 'plug'; readonly acrossFlats: number; readonly headHeight: number; readonly threadDiameter: number; readonly threadLength: number }
  | { readonly kind: 'nipple'; readonly acrossFlats: number; readonly sides: number; readonly overallLength: number; readonly threadLength: number;
    readonly threadDiameter: number }
  | { readonly kind: 'bushing'; readonly acrossFlats: number; readonly sides: number; readonly overallLength: number; readonly threadLength: number;
    readonly threadDiameter: number; readonly boreDiameter: number };

interface Built { readonly document: PartDocument; readonly id: string }

const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

/** 多角形の柱の長さ(ニップルは両側のおねじを除いた長さ、ブッシングはおねじを除いた長さ)。 */
function prismLength(dims: Extract<PipeFittingPartDimensions, { readonly sides: number }>): number {
  return dims.overallLength - (dims.kind === 'nipple' ? 2 : 1) * dims.threadLength;
}

function dimensionsValid(dims: PipeFittingPartDimensions): boolean {
  switch (dims.kind) {
    case 'cap':
      return positive(dims.outerDiameter, dims.height, dims.boreDiameter, dims.boreDepth)
        && dims.boreDiameter < dims.outerDiameter && dims.boreDepth < dims.height;
    case 'plug':
      return positive(dims.acrossFlats, dims.headHeight, dims.threadDiameter, dims.threadLength);
    case 'nipple':
      return positive(dims.acrossFlats, dims.threadLength, dims.threadDiameter, prismLength(dims)) && (dims.sides === 6 || dims.sides === 8);
    case 'bushing':
      return positive(dims.acrossFlats, dims.threadLength, dims.threadDiameter, dims.boreDiameter, prismLength(dims))
        && (dims.sides === 6 || dims.sides === 8) && dims.boreDiameter < dims.threadDiameter && dims.boreDiameter < dims.acrossFlats;
  }
}

function cylinder(document: PartDocument, diameter: number, height: number, z: number): Built {
  const added = appendCylinder(document, diameter / 2, expressionValueFromNumber(height), z);
  return { document: added.document, id: added.feature.id };
}

function squareHead(document: PartDocument, width: number, height: number): Built {
  const created = createPrimitiveFeature(document, 'box', origin(0, 0, -height / 2));
  const feature: PrimitiveFeature = { ...created, shape: { kind: 'box', sizeX: expressionValueFromNumber(width),
    sizeY: expressionValueFromNumber(width), sizeZ: expressionValueFromNumber(height) } };
  return { document: appendSolid(document, feature), id: feature.id };
}

/** 作図面の原点の多角形(内接円の半径 = 二面幅の半分)を z ∈ [−length, 0] へ押し出した柱。 */
function polygonPrism(document: PartDocument, sides: number, acrossFlats: number, length: number): Built {
  const profile = regularPolygonProfile(document, sides, acrossFlats / 2);
  const prism = appendExtrude(profile.document, profile.profile, expressionValueFromNumber(length), true);
  return { document: prism.document, id: prism.feature.id };
}

function combine(target: Built, tool: Built, operation: 'union' | 'subtract'): Built {
  const result = appendBoolean(tool.document, operation, target.id, tool.id);
  return { document: result.document, id: result.feature.id };
}

function buildBody(dims: PipeFittingPartDimensions): PartDocument {
  const empty = createEmptyPartDocument();
  switch (dims.kind) {
    case 'cap': {
      const body = cylinder(empty, dims.outerDiameter, dims.height, 0);
      return combine(body, cylinder(body.document, dims.boreDiameter, dims.boreDepth, 0), 'subtract').document;
    }
    case 'plug': {
      const head = squareHead(empty, dims.acrossFlats, dims.headHeight);
      return combine(head, cylinder(head.document, dims.threadDiameter, dims.threadLength, 0), 'union').document;
    }
    case 'nipple': {
      const length = prismLength(dims);
      const prism = polygonPrism(empty, dims.sides, dims.acrossFlats, length);
      const upper = combine(prism, cylinder(prism.document, dims.threadDiameter, dims.threadLength, 0), 'union');
      return combine(upper, cylinder(upper.document, dims.threadDiameter, dims.threadLength, -length - dims.threadLength), 'union').document;
    }
    case 'bushing': {
      const length = prismLength(dims);
      const prism = polygonPrism(empty, dims.sides, dims.acrossFlats, length);
      const body = combine(prism, cylinder(prism.document, dims.threadDiameter, dims.threadLength, 0), 'union');
      return combine(body, cylinder(body.document, dims.boreDiameter, dims.overallLength, -length), 'subtract').document;
    }
  }
}

/** 部品の形。寸法が作れない時は null。 */
export function buildPipeFittingPartBody(dims: PipeFittingPartDimensions, name: string): PartDocument | null {
  return dimensionsValid(dims) ? withName(buildBody(dims), name) : null;
}

const circle = (diameter: number): number => Math.PI * (diameter / 2) ** 2;
const polygon = (sides: number, acrossFlats: number): number => sides * (acrossFlats / 2) ** 2 * Math.tan(Math.PI / sides);

/**
 * 形の台本どおりの体積(mm³)。キャップは円柱 − 穴、プラグは頭の箱 + おねじの円柱、ニップルは柱 + おねじの円柱 2 本、
 * ブッシングは柱 + おねじの円柱 − 全長の穴(穴はおねじの外径と二面幅より細いので、柱とおねじの中に収まる)。
 */
export function pipeFittingPartVolume(dims: PipeFittingPartDimensions): number | null {
  if (!dimensionsValid(dims)) return null;
  switch (dims.kind) {
    case 'cap':
      return circle(dims.outerDiameter) * dims.height - circle(dims.boreDiameter) * dims.boreDepth;
    case 'plug':
      return dims.acrossFlats ** 2 * dims.headHeight + circle(dims.threadDiameter) * dims.threadLength;
    case 'nipple':
      return polygon(dims.sides, dims.acrossFlats) * prismLength(dims) + 2 * circle(dims.threadDiameter) * dims.threadLength;
    case 'bushing':
      return polygon(dims.sides, dims.acrossFlats) * prismLength(dims) + circle(dims.threadDiameter) * dims.threadLength
        - circle(dims.boreDiameter) * dims.overallLength;
  }
}
