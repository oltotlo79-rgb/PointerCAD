import {
  evaluateExpression, expressionValueFromNumber, type ExpressionValue,
} from '@pointercad/expression';

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import {
  appendSolid, createEmptyPartDocument, createPrimitiveFeature, nextSolidId, nextSolidName,
  replaceSketch,
} from '../../part/createPartDocument.js';
import type {
  BooleanFeature, ExtrudeFeature, HoleFeature, PartDocument, PrimitiveFeature, SketchFaceRef,
  SolidOrigin, ThreadHoleFeature, ThreadShaftFeature,
} from '../../part/types.js';
import {
  absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR, nextFeatureId,
  nextFeatureName,
} from '../../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../../sketch/planeMath.js';
import type {
  SketchDocument, SketchFaceFeature, SketchPointFeature, SketchPolygonFeature,
} from '../../sketch/types.js';
import {
  findMetricThread, metricThreadPitch, threadMinorDiameter, type ThreadSeries,
} from '../../thread/metricThread.js';
import type { StandardCatalogId } from '../types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import {
  findDeepGrooveBallBearing,
} from './bearings.js';
import {
  findHexBolt, findHexNut, findPanHeadScrew, findPlainWasher, findSocketHeadCapScrew,
  findSpringWasher,
} from './fasteners.js';
import { findChannel, findEqualAngle, findHBeam } from './sections.js';
import {
  type FastenerDimensionSeries, STANDARD_CATALOG_REVISION, STANDARD_PART_GENERATOR_REVISION,
} from './types.js';

export const DEFAULT_STANDARD_FASTENER_LENGTH = '30';
export const DEFAULT_STANDARD_SECTION_LENGTH = '1000';
export const STANDARD_PART_UNAVAILABLE_MESSAGE = 'この呼び寸法は用意されていません。';

type Point2 = readonly [number, number];

function activeSketch(document: PartDocument): SketchDocument {
  const sketch = document.sketches.find((candidate) => candidate.id === document.activeSketchId);
  if (sketch === undefined) throw new Error('規格部品の作図面が見つかりません。');
  return sketch;
}

function positiveExpression(source: string): ExpressionValue | null {
  const result = evaluateExpression(source);
  return result.ok && result.value.value > 0 ? result.value : null;
}

function dimensionSeriesFrom(
  options: Readonly<Record<string, string>>,
): FastenerDimensionSeries | null {
  const value = options.dimensionSeries ?? 'annexJA';
  return value === 'annexJA' || value === 'main' ? value : null;
}

function threadFrom(
  size: string,
  options: Readonly<Record<string, string>>,
): { readonly series: ThreadSeries; readonly pitch: number } | null {
  const series = options.threadSeries ?? 'coarse';
  if (series !== 'coarse' && series !== 'fine') return null;
  const row = findMetricThread(size);
  return row === undefined ? null : { series, pitch: metricThreadPitch(row, series) };
}

function origin(x: number, y: number, z: number): SolidOrigin {
  return { kind: 'coordinate', value: absoluteCoordinate(x, y, z) };
}

function withName(document: PartDocument, name: string): PartDocument {
  return { ...document, name };
}

function regularPolygonProfile(
  document: PartDocument,
  sides: number,
  inscribedRadius: number,
): { readonly document: PartDocument; readonly profile: SketchFaceRef; readonly area: number } {
  let sketch = activeSketch(document);
  const polygon: SketchPolygonFeature = {
    id: nextFeatureId(sketch, 'polygon'),
    name: nextFeatureName(sketch, 'polygon'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'polygon',
    center: absoluteCoordinate(0, 0, 0),
    sides: expressionValueFromNumber(sides),
    radius: expressionValueFromNumber(inscribedRadius),
    radiusMode: 'inscribed',
    construction: false,
  };
  sketch = appendFeature(sketch, polygon);
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: [{ featureId: polygon.id }],
    color: DEFAULT_FACE_COLOR,
  };
  sketch = appendFeature(sketch, face);
  return {
    document: replaceSketch(document, sketch),
    profile: { sketchId: sketch.id, faceFeatureId: face.id },
    area: sides * inscribedRadius * inscribedRadius * Math.tan(Math.PI / sides),
  };
}

function polygonProfile(
  document: PartDocument,
  points: readonly Point2[],
): { readonly document: PartDocument; readonly profile: SketchFaceRef } {
  let sketch = activeSketch(document);
  const pointIds: string[] = [];
  for (const [x, y] of points) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, 0));
    sketch = appendFeature(sketch, point);
    pointIds.push(point.id);
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: pointIds.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  sketch = appendFeature(sketch, face);
  return { document: replaceSketch(document, sketch), profile: { sketchId: sketch.id, faceFeatureId: face.id } };
}

function centerPoint(document: PartDocument): {
  readonly document: PartDocument;
  readonly point: SketchPointFeature;
} {
  let sketch = activeSketch(document);
  const point = createPointFeature(sketch, absoluteCoordinate(0, 0, 0));
  sketch = appendFeature(sketch, point);
  return { document: replaceSketch(document, sketch), point };
}

function appendExtrude(
  document: PartDocument,
  profile: SketchFaceRef,
  distance: ExpressionValue,
  reversed = false,
): { readonly document: PartDocument; readonly feature: ExtrudeFeature } {
  const feature: ExtrudeFeature = {
    id: nextSolidId(document, 'extrude'),
    name: nextSolidName(document, 'extrude'),
    suppressed: false,
    kind: 'extrude',
    profile,
    distance,
    reversed,
    symmetric: false,
  };
  return { document: appendSolid(document, feature), feature };
}

function appendCylinder(
  document: PartDocument,
  radius: number,
  height: ExpressionValue,
  z = 0,
): { readonly document: PartDocument; readonly feature: PrimitiveFeature } {
  const created = createPrimitiveFeature(document, 'cylinder', origin(0, 0, z));
  const feature: PrimitiveFeature = {
    ...created,
    shape: { kind: 'cylinder', radius: expressionValueFromNumber(radius), height },
  };
  return { document: appendSolid(document, feature), feature };
}

function appendBox(
  document: PartDocument,
  center: readonly [number, number, number],
  sizes: readonly [number, number, number],
): { readonly document: PartDocument; readonly feature: PrimitiveFeature } {
  const created = createPrimitiveFeature(document, 'box', origin(...center));
  const feature: PrimitiveFeature = {
    ...created,
    shape: {
      kind: 'box',
      sizeX: expressionValueFromNumber(sizes[0]),
      sizeY: expressionValueFromNumber(sizes[1]),
      sizeZ: expressionValueFromNumber(sizes[2]),
    },
  };
  return { document: appendSolid(document, feature), feature };
}

function appendBoolean(
  document: PartDocument,
  operation: BooleanFeature['operation'],
  targetFeatureId: string,
  toolFeatureId: string,
): { readonly document: PartDocument; readonly feature: BooleanFeature } {
  const feature: BooleanFeature = {
    id: nextSolidId(document, operation),
    name: nextSolidName(document, operation),
    suppressed: false,
    kind: 'boolean',
    operation,
    targetFeatureId,
    toolFeatureId,
  };
  return { document: appendSolid(document, feature), feature };
}

function planeFace(
  bodyFeatureId: string,
  area: number,
  z: number,
): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'face', surfaceKind: 'plane', area, position: [0, 0, z], axis: [0, 0, 1], radius: null,
    },
  };
}

function cylinderFace(
  bodyFeatureId: string,
  radius: number,
  height: number,
): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'face', surfaceKind: 'cylinder', area: 2 * Math.PI * radius * height,
      position: [0, 0, height / 2], axis: [0, 0, 1], radius,
    },
  };
}

function appendExternalThread(
  document: PartDocument,
  shaft: PrimitiveFeature,
  nominal: string,
  pitch: number,
  series: ThreadSeries,
  shaftLength: ExpressionValue,
  threadLength: number,
): { readonly document: PartDocument; readonly feature: ThreadShaftFeature } {
  if (shaft.shape.kind !== 'cylinder') throw new Error('外ねじの対象が円柱ではありません。');
  const radius = shaft.shape.radius.value;
  const feature: ThreadShaftFeature = {
    id: nextSolidId(document, 'threadShaft'),
    name: nextSolidName(document, 'threadShaft'),
    suppressed: false,
    kind: 'threadShaft',
    targetFeatureId: shaft.id,
    face: cylinderFace(shaft.id, radius, shaftLength.value),
    nominal,
    series,
    pitch: expressionValueFromNumber(pitch),
    length: expressionValueFromNumber(threadLength),
    fromEnd: 'last',
    modeled: false,
  };
  return { document: appendSolid(document, feature), feature };
}

function appendThroughHole(
  document: PartDocument,
  target: PrimitiveFeature,
  center: SketchPointFeature,
  diameter: number,
  topZ: number,
): { readonly document: PartDocument; readonly feature: HoleFeature } {
  if (target.shape.kind !== 'cylinder') throw new Error('穴の対象が円柱ではありません。');
  const feature: HoleFeature = {
    id: nextSolidId(document, 'hole'),
    name: nextSolidName(document, 'hole'),
    suppressed: false,
    kind: 'hole',
    targetFeatureId: target.id,
    face: planeFace(target.id, Math.PI * target.shape.radius.value ** 2, topZ),
    centers: [{ sketchId: document.activeSketchId, pointFeatureId: center.id }],
    diameter: expressionValueFromNumber(diameter),
    depth: { kind: 'through' },
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
  return { document: appendSolid(document, feature), feature };
}

function buildHexBolt(size: string, options: Readonly<Record<string, string>>): PartDocument | null {
  const dimensionSeries = dimensionSeriesFrom(options);
  const row = dimensionSeries === null ? undefined : findHexBolt(size, dimensionSeries);
  const thread = threadFrom(size, options);
  const length = positiveExpression(options.length ?? DEFAULT_STANDARD_FASTENER_LENGTH);
  if (row === undefined || thread === null || length === null) return null;
  let document = createEmptyPartDocument();
  const headProfile = regularPolygonProfile(document, 6, row.s / 2);
  document = headProfile.document;
  const head = appendExtrude(document, headProfile.profile, expressionValueFromNumber(row.k), true);
  document = head.document;
  const shaft = appendCylinder(document, row.d / 2, length);
  document = shaft.document;
  const threaded = appendExternalThread(
    document, shaft.feature, row.size, thread.pitch, thread.series, length,
    Math.min(row.b1, length.value),
  );
  document = threaded.document;
  document = appendBoolean(document, 'union', head.feature.id, threaded.feature.id).document;
  return withName(document, `六角ボルト ${row.size}×${length.source}`);
}

function buildHexNut(size: string, options: Readonly<Record<string, string>>): PartDocument | null {
  const dimensionSeries = dimensionSeriesFrom(options);
  const row = dimensionSeries === null ? undefined : findHexNut(size, dimensionSeries);
  const thread = threadFrom(size, options);
  if (row === undefined || thread === null) return null;
  let document = createEmptyPartDocument();
  const profile = regularPolygonProfile(document, 6, row.s / 2);
  document = profile.document;
  const head = appendExtrude(document, profile.profile, expressionValueFromNumber(row.mMax));
  document = head.document;
  const center = centerPoint(document);
  document = center.document;
  const feature: ThreadHoleFeature = {
    id: nextSolidId(document, 'threadHole'),
    name: nextSolidName(document, 'threadHole'),
    suppressed: false,
    kind: 'threadHole',
    targetFeatureId: head.feature.id,
    face: planeFace(head.feature.id, profile.area, row.mMax),
    centers: [{ sketchId: document.activeSketchId, pointFeatureId: center.point.id }],
    designation: row.size,
    series: thread.series,
    pitch: expressionValueFromNumber(thread.pitch),
    drillDiameter: expressionValueFromNumber(threadMinorDiameter(row.d, thread.pitch)),
    depth: { kind: 'through' },
    threadLength: expressionValueFromNumber(row.mMax),
    representation: 'simplified',
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
  return withName(appendSolid(document, feature), `六角ナット ${row.size}`);
}

function buildPlainWasher(size: string): PartDocument | null {
  const row = findPlainWasher(size);
  if (row === undefined) return null;
  let document = createEmptyPartDocument();
  const center = centerPoint(document);
  document = center.document;
  const outer = appendCylinder(
    document, row.d2 / 2, expressionValueFromNumber(row.thickness),
  );
  document = outer.document;
  document = appendThroughHole(
    document, outer.feature, center.point, row.d1, row.thickness,
  ).document;
  return withName(document, `平座金 ${row.size}`);
}

function appendRing(
  document: PartDocument,
  innerRadius: number,
  outerRadius: number,
  height: number,
): { readonly document: PartDocument; readonly featureId: string } {
  const outer = appendCylinder(document, outerRadius, expressionValueFromNumber(height));
  const inner = appendCylinder(outer.document, innerRadius, expressionValueFromNumber(height));
  const ring = appendBoolean(inner.document, 'subtract', outer.feature.id, inner.feature.id);
  return { document: ring.document, featureId: ring.feature.id };
}

function buildSpringWasher(size: string): PartDocument | null {
  const row = findSpringWasher(size);
  if (row === undefined) return null;
  const ring = appendRing(
    createEmptyPartDocument(), row.insideDiameter / 2, row.outsideDiameter / 2, row.thickness,
  );
  const middleRadius = (row.insideDiameter + row.outsideDiameter) / 4;
  const notch = appendBox(
    ring.document,
    [middleRadius, 0, row.thickness / 2],
    [row.width * 1.4, row.width * 0.65, row.thickness * 2],
  );
  const cut = appendBoolean(notch.document, 'subtract', ring.featureId, notch.feature.id);
  return withName(cut.document, `ばね座金 ${row.size}`);
}

function buildSocketHeadCapScrew(
  size: string,
  options: Readonly<Record<string, string>>,
): PartDocument | null {
  const row = findSocketHeadCapScrew(size);
  const thread = threadFrom(size, options);
  const length = positiveExpression(options.length ?? DEFAULT_STANDARD_FASTENER_LENGTH);
  if (row === undefined || row.socketDepth === null || thread === null || length === null) return null;
  let document = createEmptyPartDocument();
  const head = appendCylinder(
    document, row.headDiameter / 2, expressionValueFromNumber(row.headHeight), -row.headHeight,
  );
  document = head.document;
  const shaft = appendCylinder(document, row.d / 2, length);
  document = shaft.document;
  const threaded = appendExternalThread(
    document, shaft.feature, row.size, thread.pitch, thread.series, length,
    Math.min(length.value, row.d * 2 + 12),
  );
  document = threaded.document;
  const united = appendBoolean(document, 'union', head.feature.id, threaded.feature.id);
  document = united.document;
  const socket = regularPolygonProfile(document, 6, row.socketWidth / 2);
  document = socket.document;
  const socketTool = appendExtrude(
    document, socket.profile, expressionValueFromNumber(row.socketDepth), true,
  );
  document = socketTool.document;
  document = appendBoolean(document, 'subtract', united.feature.id, socketTool.feature.id).document;
  return withName(document, `六角穴付きボルト ${row.size}×${length.source}`);
}

function panRecessDimensions(row: {
  readonly headDiameter: number; readonly headHeight: number; readonly recessNumber: number;
}): { readonly length: number; readonly width: number; readonly depth: number } {
  // The public table exposes the recess number but not its full profile dimensions. Keep the
  // cross visibly identifiable with a deterministic simplified cut instead of inventing JIS values.
  const widthRatio = row.recessNumber >= 3 ? 0.16 : 0.14;
  return {
    length: row.headDiameter * 0.65,
    width: row.headDiameter * widthRatio,
    depth: row.headHeight * 0.35,
  };
}

function buildPanHeadScrew(
  size: string,
  options: Readonly<Record<string, string>>,
): PartDocument | null {
  const row = findPanHeadScrew(size);
  const thread = threadFrom(size, options);
  const length = positiveExpression(options.length ?? DEFAULT_STANDARD_FASTENER_LENGTH);
  if (row === undefined || thread === null || length === null) return null;
  let document = createEmptyPartDocument();
  // JIS B 1111 public dimensions provide dk and k, so the domed head is represented by its
  // enclosing cylinder. The cross cut below distinguishes it from an ordinary cylinder head.
  const head = appendCylinder(
    document, row.headDiameter / 2, expressionValueFromNumber(row.headHeight), -row.headHeight,
  );
  document = head.document;
  const shaft = appendCylinder(document, row.d / 2, length);
  document = shaft.document;
  const threaded = appendExternalThread(
    document, shaft.feature, row.size, thread.pitch, thread.series, length, length.value,
  );
  document = threaded.document;
  const united = appendBoolean(document, 'union', head.feature.id, threaded.feature.id);
  document = united.document;
  const recess = panRecessDimensions(row);
  const horizontal = appendBox(
    document, [0, 0, -recess.depth / 2], [recess.length, recess.width, recess.depth],
  );
  document = horizontal.document;
  const firstCut = appendBoolean(document, 'subtract', united.feature.id, horizontal.feature.id);
  document = firstCut.document;
  const vertical = appendBox(
    document, [0, 0, -recess.depth / 2], [recess.width, recess.length, recess.depth],
  );
  document = vertical.document;
  document = appendBoolean(document, 'subtract', firstCut.feature.id, vertical.feature.id).document;
  return withName(document, `十字穴付きなべ小ねじ ${row.size}×${length.source}`);
}

function buildBearing(size: string): PartDocument | null {
  const row = findDeepGrooveBallBearing(size);
  if (row === undefined) return null;
  const inner = row.boreDiameter / 2;
  const outer = row.outsideDiameter / 2;
  const radial = outer - inner;
  let document = createEmptyPartDocument();
  const innerRing = appendRing(document, inner, inner + radial * 0.22, row.width);
  document = innerRing.document;
  const middleRing = appendRing(document, inner + radial * 0.38, outer - radial * 0.38, row.width);
  document = middleRing.document;
  const outerRing = appendRing(document, outer - radial * 0.22, outer, row.width);
  document = outerRing.document;
  return withName(document, `深溝玉軸受 ${row.size}`);
}

function sectionLength(options: Readonly<Record<string, string>>): ExpressionValue | null {
  return positiveExpression(options.length ?? DEFAULT_STANDARD_SECTION_LENGTH);
}

function buildSection(
  name: string,
  points: readonly Point2[],
  length: ExpressionValue,
): PartDocument {
  const profile = polygonProfile(createEmptyPartDocument(), points);
  const extruded = appendExtrude(profile.document, profile.profile, length);
  return withName(extruded.document, `${name} 長さ${length.source}`);
}

function buildEqualAngle(
  size: string,
  options: Readonly<Record<string, string>>,
): PartDocument | null {
  const row = findEqualAngle(size);
  const length = sectionLength(options);
  if (row === undefined || length === null) return null;
  const t = row.thickness;
  return buildSection(row.size, [[0, 0], [row.a, 0], [row.a, t], [t, t], [t, row.b], [0, row.b]], length);
}

function buildChannel(
  size: string,
  options: Readonly<Record<string, string>>,
): PartDocument | null {
  const row = findChannel(size);
  const length = sectionLength(options);
  if (row === undefined || length === null) return null;
  const h = row.height;
  const w = row.width;
  const tw = row.webThickness;
  const tf = row.flangeThickness;
  return buildSection(row.size, [
    [0, 0], [w, 0], [w, tf], [tw, tf], [tw, h - tf], [w, h - tf], [w, h], [0, h],
  ], length);
}

function buildHBeam(
  size: string,
  options: Readonly<Record<string, string>>,
): PartDocument | null {
  const row = findHBeam(size);
  const length = sectionLength(options);
  if (row === undefined || length === null) return null;
  const h = row.height;
  const w = row.width;
  const tw = row.webThickness;
  const tf = row.flangeThickness;
  const left = (w - tw) / 2;
  const right = (w + tw) / 2;
  return buildSection(row.size, [
    [0, 0], [w, 0], [w, tf], [right, tf], [right, h - tf], [w, h - tf],
    [w, h], [0, h], [0, h - tf], [left, h - tf], [left, tf], [0, tf],
  ], length);
}

/** 寸法表から、既存フィーチャーだけを持つ普通の部品文書を決定的に組み立てる。 */
export function buildStandardPart(
  catalog: StandardCatalogId,
  size: string,
  options: Readonly<Record<string, string>> = {},
): PartDocument | null {
  switch (catalog) {
    case 'hexBolt': return buildHexBolt(size, options);
    case 'hexNut': return buildHexNut(size, options);
    case 'plainWasher': return buildPlainWasher(size);
    case 'springWasher': return buildSpringWasher(size);
    case 'socketHeadCapScrew': return buildSocketHeadCapScrew(size, options);
    case 'panHeadScrew': return buildPanHeadScrew(size, options);
    case 'deepGrooveBallBearing': return buildBearing(size);
    case 'equalAngle': return buildEqualAngle(size, options);
    case 'channel': return buildChannel(size, options);
    case 'hBeam': return buildHBeam(size, options);
  }
}

/** 保存された版を必ず確かめてから組む。未知の旧版を現在表で代用しない。 */
export function buildStandardPartFromSource(source: StandardPartSource): PartDocument | null {
  if (source.catalogRevision !== STANDARD_CATALOG_REVISION
    || source.generatorRevision !== STANDARD_PART_GENERATOR_REVISION) return null;
  return buildStandardPart(source.catalog, source.size, source.options);
}

/** 新規配置で版の書き忘れを起こさない唯一の生成口。 */
export function createStandardPartSource(
  catalog: StandardCatalogId,
  size: string,
  options: Readonly<Record<string, string>> = {},
): StandardPartSource {
  const normalizedOptions: Readonly<Record<string, string>> = (() => {
    switch (catalog) {
      case 'hexBolt': return {
        length: options.length ?? DEFAULT_STANDARD_FASTENER_LENGTH,
        dimensionSeries: options.dimensionSeries ?? 'annexJA',
        threadSeries: options.threadSeries ?? 'coarse',
      };
      case 'hexNut': return {
        dimensionSeries: options.dimensionSeries ?? 'annexJA',
        threadSeries: options.threadSeries ?? 'coarse',
      };
      case 'socketHeadCapScrew':
      case 'panHeadScrew': return {
        length: options.length ?? DEFAULT_STANDARD_FASTENER_LENGTH,
        threadSeries: options.threadSeries ?? 'coarse',
      };
      default: return options;
    }
  })();
  return {
    kind: 'standardPart', catalog, size, options: normalizedOptions,
    catalogRevision: STANDARD_CATALOG_REVISION,
    generatorRevision: STANDARD_PART_GENERATOR_REVISION,
  };
}

/** 台本どおりの簡略形状の体積。実カーネルの体積検査の独立した期待値に使う。 */
export function standardPartNominalVolume(
  catalog: StandardCatalogId,
  size: string,
  options: Readonly<Record<string, string>> = {},
): number | null {
  const length = positiveExpression(options.length ?? DEFAULT_STANDARD_FASTENER_LENGTH)?.value ?? null;
  switch (catalog) {
    case 'hexBolt': {
      const series = dimensionSeriesFrom(options);
      const row = series === null ? undefined : findHexBolt(size, series);
      return row === undefined || length === null ? null
        : Math.sqrt(3) / 2 * row.s ** 2 * row.k + Math.PI * (row.d / 2) ** 2 * length;
    }
    case 'hexNut': {
      const series = dimensionSeriesFrom(options);
      const row = series === null ? undefined : findHexNut(size, series);
      const thread = threadFrom(size, options);
      if (row === undefined || thread === null) return null;
      const hole = threadMinorDiameter(row.d, thread.pitch);
      return (Math.sqrt(3) / 2 * row.s ** 2 - Math.PI * (hole / 2) ** 2) * row.mMax;
    }
    case 'plainWasher': {
      const row = findPlainWasher(size);
      return row === undefined ? null
        : Math.PI * ((row.d2 / 2) ** 2 - (row.d1 / 2) ** 2) * row.thickness;
    }
    case 'springWasher': {
      const row = findSpringWasher(size);
      return row === undefined ? null
        : Math.PI * ((row.outsideDiameter / 2) ** 2 - (row.insideDiameter / 2) ** 2) * row.thickness;
    }
    case 'socketHeadCapScrew': {
      const row = findSocketHeadCapScrew(size);
      if (row === undefined || row.socketDepth === null || length === null) return null;
      const socketArea = Math.sqrt(3) / 2 * row.socketWidth ** 2;
      return Math.PI * (row.headDiameter / 2) ** 2 * row.headHeight
        - socketArea * row.socketDepth + Math.PI * (row.d / 2) ** 2 * length;
    }
    case 'panHeadScrew': {
      const row = findPanHeadScrew(size);
      if (row === undefined || length === null) return null;
      const recess = panRecessDimensions(row);
      const crossVolume = (2 * recess.length * recess.width - recess.width ** 2) * recess.depth;
      return Math.PI * (row.headDiameter / 2) ** 2 * row.headHeight - crossVolume
        + Math.PI * (row.d / 2) ** 2 * length;
    }
    case 'deepGrooveBallBearing': {
      const row = findDeepGrooveBallBearing(size);
      if (row === undefined) return null;
      const inner = row.boreDiameter / 2;
      const outer = row.outsideDiameter / 2;
      const radial = outer - inner;
      const annulus = (a: number, b: number): number => Math.PI * (b ** 2 - a ** 2) * row.width;
      return annulus(inner, inner + radial * 0.22)
        + annulus(inner + radial * 0.38, outer - radial * 0.38)
        + annulus(outer - radial * 0.22, outer);
    }
    case 'equalAngle': {
      const row = findEqualAngle(size);
      const section = positiveExpression(options.length ?? DEFAULT_STANDARD_SECTION_LENGTH)?.value ?? null;
      return row === undefined || section === null ? null
        : (row.a + row.b - row.thickness) * row.thickness * section;
    }
    case 'channel': {
      const row = findChannel(size);
      const section = positiveExpression(options.length ?? DEFAULT_STANDARD_SECTION_LENGTH)?.value ?? null;
      return row === undefined || section === null ? null
        : (row.height * row.webThickness
          + 2 * (row.width - row.webThickness) * row.flangeThickness) * section;
    }
    case 'hBeam': {
      const row = findHBeam(size);
      const section = positiveExpression(options.length ?? DEFAULT_STANDARD_SECTION_LENGTH)?.value ?? null;
      return row === undefined || section === null ? null
        : (row.height * row.webThickness
          + 2 * (row.width - row.webThickness) * row.flangeThickness) * section;
    }
  }
}
