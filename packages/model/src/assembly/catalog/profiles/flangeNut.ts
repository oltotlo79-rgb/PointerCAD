/**
 * フランジ付き六角ナットの簡略形状。二面幅 s・高さ m の六角柱と、外径 dc・厚さ c のフランジの円柱を z = 0 から重ねて和を取り、
 * 上面(z = m)からねじの下穴径の通しのねじ穴(簡略の表し方)を開ける。座面の丸み・フランジの面取り・セレーションは入れない。
 */
import { exactExpressionValueFromNumber, expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, nextSolidId, nextSolidName } from '../../../part/createPartDocument.js';
import type { PartDocument, ThreadHoleFeature } from '../../../part/types.js';
import { threadMinorDiameter } from '../../../thread/metricThread.js';
import {
  appendBoolean, appendCylinder, appendExtrude, centerPoint, planeFace, regularPolygonProfile, withName,
} from '../../standard/partPrimitives.js';

export interface FlangeNutDimensions {
  readonly designation: string;
  readonly nominalDiameter: number;
  readonly pitch: number;
  /** 二面幅 s。 */
  readonly acrossFlats: number;
  /** 高さ m。 */
  readonly height: number;
  /** フランジの外径 dc。 */
  readonly flangeDiameter: number;
  /** フランジの厚さ c。 */
  readonly flangeThickness: number;
}

function dimensionsValid(dims: FlangeNutDimensions): boolean {
  const values = [dims.nominalDiameter, dims.pitch, dims.acrossFlats, dims.height, dims.flangeDiameter, dims.flangeThickness];
  return values.every((value) => Number.isFinite(value) && value > 0) && dims.nominalDiameter < dims.acrossFlats
    && dims.acrossFlats / Math.sqrt(3) < dims.flangeDiameter / 2 && dims.flangeThickness < dims.height;
}

export function buildFlangeNutPart(dims: FlangeNutDimensions, name: string): PartDocument | null {
  if (!dimensionsValid(dims)) return null;
  const profile = regularPolygonProfile(createEmptyPartDocument(), 6, dims.acrossFlats / 2);
  const body = appendExtrude(profile.document, profile.profile, expressionValueFromNumber(dims.height));
  const flange = appendCylinder(body.document, dims.flangeDiameter / 2, expressionValueFromNumber(dims.flangeThickness));
  const united = appendBoolean(flange.document, 'union', body.feature.id, flange.feature.id);
  const center = centerPoint(united.document);
  const document = center.document;
  const hole: ThreadHoleFeature = {
    id: nextSolidId(document, 'threadHole'),
    name: nextSolidName(document, 'threadHole'),
    suppressed: false,
    kind: 'threadHole',
    targetFeatureId: united.feature.id,
    face: planeFace(united.feature.id, profile.area, dims.height),
    centers: [{ sketchId: document.activeSketchId, pointFeatureId: center.point.id }],
    designation: dims.designation,
    series: 'coarse',
    pitch: expressionValueFromNumber(dims.pitch),
    drillDiameter: exactExpressionValueFromNumber(threadMinorDiameter(dims.nominalDiameter, dims.pitch)),
    depth: { kind: 'through' },
    threadLength: expressionValueFromNumber(dims.height),
    representation: 'simplified',
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
  return withName(appendSolid(document, hole), name);
}

/** 形の台本どおりの体積(六角柱 + フランジの六角柱の外の部分 − ねじの下穴、mm³)。 */
export function flangeNutVolume(dims: FlangeNutDimensions): number | null {
  if (!dimensionsValid(dims)) return null;
  const hexagon = Math.sqrt(3) / 2 * dims.acrossFlats ** 2;
  const hole = Math.PI * (threadMinorDiameter(dims.nominalDiameter, dims.pitch) / 2) ** 2;
  return hexagon * dims.height + (Math.PI * (dims.flangeDiameter / 2) ** 2 - hexagon) * dims.flangeThickness - hole * dims.height;
}
