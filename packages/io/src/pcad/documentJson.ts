/**
 * 部品文書と `.pcad` の `document.json` の相互変換(計画書 docs/plans/P2-ソリッド基礎.md タスク14、要件§8)。
 *
 * 書き出しは欄を決まった順で組み立てるので、同じ文書からは必ず同じ文字列ができる(決定的)。
 * 保存するのはフィーチャー履歴と式だけで、解決済みの座標・メッシュ(TypedArray)・キャッシュの鍵は
 * 書き出さない(rules/04-設計の規律.md「導出できるものは保存しない」)。
 *
 * 読み込みは `as` による強制変換を使わず、欄を1つずつ検査して型を確かめる(guards.ts)。
 * 決めごとが2つある:
 *  - **知らない欄は捨てる。** 型検査を通ったものだけを取り込む。持ち回ると、保存し直したときに
 *    壊れた組み合わせを書き出してしまうため。
 *  - **読めない欄が1つでもあればファイル全体を断る。** その要素だけを捨てて残りを開くと、
 *    利用者が気づかずに保存し直したときに元のデータを失うため。
 *
 * 版の扱いは統括の決定④(docs/報告記録.md 2026-09-03 07:35)に従う。文書の `schemaVersion` が正で、
 * 封筒の `schema` には同じ値を書く。読み手は封筒の `schema` を先に検査してから中身を読む。
 */

import {
  WORK_PLANE_IDS,
  type BooleanOperation,
  type ChamferSize,
  type CoordinateInput,
  type EdgeCurveKind,
  type FaceSurfaceKind,
  type HoleDepth,
  type PartDocument,
  type PatternDirection,
  type PatternPlacement,
  type PointArrayLayout,
  type PointReference,
  type RevolveAxis,
  type SketchDocument,
  type SketchElementRef,
  type SketchFaceRef,
  type SketchFeature,
  type SketchLineRef,
  type SketchPointRef,
  type SolidFeature,
  type SolidFeatureKind,
  type SpringDerived,
  type SpringHandedness,
  type SubShapeFingerprint,
  type SubShapeKind,
  type SubShapeRef,
  type ThreadRepresentation,
  type ThreadSeries,
  type Vec3,
  type WorkPlaneId,
} from '@pointercad/model';

import {
  checkRecord,
  fieldProblem,
  indexPath,
  isRecord,
  joinPath,
  readArray,
  readBoolean,
  readExpression,
  readLiteral,
  readNumber,
  readOptionalNumber,
  readOptionalVec3,
  readRecord,
  readString,
  readValue,
  readVec3,
  type Checked,
  type ExpressionValueJson,
  type FieldProblem,
} from './guards.js';
import {
  PCAD_APP_NAME,
  PCAD_DOCUMENT_KIND,
  PCAD_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  type PcadEnvelope,
} from './schema.js';

/** 判別に使う文字列の一覧。`as` を使わずに型から取り出す。 */
const COORDINATE_MODES: readonly CoordinateInput['mode'][] = ['absolute', 'relative', 'polar'];
const POINT_REFERENCE_KINDS: readonly PointReference['kind'][] = [
  'origin',
  'previous',
  'point',
  'vertex',
];
type VertexReference = Extract<PointReference, { readonly kind: 'vertex' }>;
const VERTEX_NAMES: readonly VertexReference['vertex'][] = ['start', 'end', 'center'];
const SKETCH_FEATURE_KINDS: readonly SketchFeature['kind'][] = [
  'point',
  'line',
  'arc',
  'pointArray',
  'face',
  'rectangle',
  'polygon',
  'slot',
  'ellipse',
  'spline',
];
/** 正多角形(FR-315)の半径の意味。`model` の `SketchPolygonFeature.radiusMode` と同じ2値。 */
const POLYGON_RADIUS_MODES: readonly ('circumscribed' | 'inscribed')[] = [
  'circumscribed',
  'inscribed',
];
/** スプライン(FR-317)の点の意味。`model` の `SketchSplineFeature.mode` と同じ2値。 */
const SPLINE_MODES: readonly ('interpolate' | 'control')[] = ['interpolate', 'control'];
/** 点列の並べ方(FR-327、タスク6)。`model` の `PointArrayLayout['kind']` と同じ3値。 */
const POINT_ARRAY_LAYOUT_KINDS: readonly PointArrayLayout['kind'][] = [
  'linear',
  'circular',
  'grid',
];
/**
 * `.pcad` から読める立体の種類。P2 の4種類(押し出し・回転・縫合・ブーリアン)に、
 * P3 の加工フィーチャー5種(穴・ねじ穴・R 面取り・C 面取り・パターン)とばねを足した10種類
 * (P3 計画書 §2.10、タスク19)。知らない種類の `kind` は `readLiteral` が
 * 「その欄の型が違う」として断る(新しい欄の解釈を推測しないため)。
 */
const SOLID_FEATURE_KINDS: readonly SolidFeatureKind[] = [
  'extrude',
  'revolve',
  'sew',
  'boolean',
  'hole',
  'threadHole',
  'fillet',
  'chamfer',
  'pattern',
  'spring',
];
const REVOLVE_AXIS_KINDS: readonly RevolveAxis['kind'][] = ['world', 'line'];
type WorldRevolveAxis = Extract<RevolveAxis, { readonly kind: 'world' }>;
const WORLD_AXES: readonly WorldRevolveAxis['axis'][] = ['x', 'y', 'z'];
const BOOLEAN_OPERATIONS: readonly BooleanOperation[] = ['union', 'subtract', 'intersect'];

// P3(§2.10、タスク19)が足す判別の一覧。
const SUB_SHAPE_KINDS: readonly SubShapeKind[] = ['face', 'edge', 'vertex'];
const FACE_SURFACE_KINDS: readonly FaceSurfaceKind[] = [
  'plane',
  'cylinder',
  'cone',
  'sphere',
  'torus',
  'other',
];
const EDGE_CURVE_KINDS: readonly EdgeCurveKind[] = ['line', 'circle', 'ellipse', 'other'];
const HOLE_DEPTH_KINDS: readonly HoleDepth['kind'][] = ['through', 'blind'];
const THREAD_SERIES: readonly ThreadSeries[] = ['coarse', 'fine'];
const THREAD_REPRESENTATIONS: readonly ThreadRepresentation[] = ['simplified', 'modeled'];
const CHAMFER_SIZE_KINDS: readonly ChamferSize['kind'][] = [
  'equal',
  'twoDistances',
  'distanceAngle',
];
const PATTERN_DIRECTION_KINDS: readonly PatternDirection['kind'][] = ['world', 'line'];
const PATTERN_PLACEMENT_KINDS: readonly PatternPlacement['kind'][] = ['linear', 'circular'];
const SPRING_DERIVED_VALUES: readonly SpringDerived[] = ['length', 'pitch', 'turns'];
const SPRING_HANDEDNESS_VALUES: readonly SpringHandedness[] = ['right', 'left'];

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

/**
 * 式は必ず式文字列と一緒に保存する(FR-202)。評価値と表示も保存するのは、変数表が
 * 未定義でもツリーに数値を出せるようにするため。評価値が NaN のときは JSON に NaN を
 * 書けないので `null` になり、読み戻すとまた NaN になる。
 */
function serializeExpression(value: ExpressionValueJson): ExpressionValueJson {
  return { source: value.source, value: value.value, display: value.display };
}

function serializePointReference(reference: PointReference): PointReference {
  switch (reference.kind) {
    case 'origin':
      return { kind: 'origin' };
    case 'previous':
      return { kind: 'previous' };
    case 'point':
      return { kind: 'point', pointId: reference.pointId };
    case 'vertex':
      return { kind: 'vertex', featureId: reference.featureId, vertex: reference.vertex };
  }
}

function serializeCoordinate(input: CoordinateInput): CoordinateInput {
  switch (input.mode) {
    case 'absolute':
      return {
        mode: 'absolute',
        x: serializeExpression(input.x),
        y: serializeExpression(input.y),
        z: serializeExpression(input.z),
      };
    case 'relative':
      return {
        mode: 'relative',
        base: serializePointReference(input.base),
        dx: serializeExpression(input.dx),
        dy: serializeExpression(input.dy),
        dz: serializeExpression(input.dz),
      };
    case 'polar':
      return {
        mode: 'polar',
        base: serializePointReference(input.base),
        distance: serializeExpression(input.distance),
        azimuth: serializeExpression(input.azimuth),
        elevation: serializeExpression(input.elevation),
      };
  }
}

/** 点列の並べ方(FR-327、タスク6)。種類ごとに欄が違うので `kind` で分岐する。 */
function serializePointArrayLayout(layout: PointArrayLayout): PointArrayLayout {
  switch (layout.kind) {
    case 'linear':
      return {
        kind: 'linear',
        base: serializeCoordinate(layout.base),
        azimuth: serializeExpression(layout.azimuth),
        spacing: serializeExpression(layout.spacing),
        count: serializeExpression(layout.count),
      };
    case 'circular':
      return {
        kind: 'circular',
        center: serializeCoordinate(layout.center),
        radius: serializeExpression(layout.radius),
        count: serializeExpression(layout.count),
      };
    case 'grid':
      return {
        kind: 'grid',
        base: serializeCoordinate(layout.base),
        rowAzimuth: serializeExpression(layout.rowAzimuth),
        rowSpacing: serializeExpression(layout.rowSpacing),
        rowCount: serializeExpression(layout.rowCount),
        colAzimuth: serializeExpression(layout.colAzimuth),
        colSpacing: serializeExpression(layout.colSpacing),
        colCount: serializeExpression(layout.colCount),
      };
  }
}

/** 点列の中の 1 点を指すときだけ index を書く(無い欄は書かない)。 */
function serializeElementRef(reference: SketchElementRef): SketchElementRef {
  return reference.index === undefined
    ? { featureId: reference.featureId }
    : { featureId: reference.featureId, index: reference.index };
}

function serializeSketchFeature(feature: SketchFeature): SketchFeature {
  switch (feature.kind) {
    case 'point':
      return {
        id: feature.id,
        kind: 'point',
        name: feature.name,
        planeId: feature.planeId,
        at: serializeCoordinate(feature.at),
      };
    case 'line':
      return {
        id: feature.id,
        kind: 'line',
        name: feature.name,
        planeId: feature.planeId,
        from: serializeCoordinate(feature.from),
        to: serializeCoordinate(feature.to),
        construction: feature.construction,
      };
    case 'arc':
      return {
        id: feature.id,
        kind: 'arc',
        name: feature.name,
        planeId: feature.planeId,
        center: serializeCoordinate(feature.center),
        radius: serializeExpression(feature.radius),
        startAngle: serializeExpression(feature.startAngle),
        endAngle: serializeExpression(feature.endAngle),
        construction: feature.construction,
      };
    case 'pointArray':
      return {
        id: feature.id,
        kind: 'pointArray',
        name: feature.name,
        planeId: feature.planeId,
        layout: serializePointArrayLayout(feature.layout),
      };
    case 'face':
      return {
        id: feature.id,
        kind: 'face',
        name: feature.name,
        planeId: feature.planeId,
        boundary: feature.boundary.map(serializeElementRef),
        color: feature.color,
      };
    case 'rectangle':
      return {
        id: feature.id,
        kind: 'rectangle',
        name: feature.name,
        planeId: feature.planeId,
        corner1: serializeCoordinate(feature.corner1),
        corner2: serializeCoordinate(feature.corner2),
        construction: feature.construction,
      };
    case 'polygon':
      return {
        id: feature.id,
        kind: 'polygon',
        name: feature.name,
        planeId: feature.planeId,
        center: serializeCoordinate(feature.center),
        sides: serializeExpression(feature.sides),
        radius: serializeExpression(feature.radius),
        radiusMode: feature.radiusMode,
        construction: feature.construction,
      };
    case 'slot':
      return {
        id: feature.id,
        kind: 'slot',
        name: feature.name,
        planeId: feature.planeId,
        center1: serializeCoordinate(feature.center1),
        center2: serializeCoordinate(feature.center2),
        width: serializeExpression(feature.width),
        construction: feature.construction,
      };
    case 'ellipse':
      return {
        id: feature.id,
        kind: 'ellipse',
        name: feature.name,
        planeId: feature.planeId,
        center: serializeCoordinate(feature.center),
        majorRadius: serializeExpression(feature.majorRadius),
        minorRadius: serializeExpression(feature.minorRadius),
        rotation: serializeExpression(feature.rotation),
        startAngle: serializeExpression(feature.startAngle),
        endAngle: serializeExpression(feature.endAngle),
        construction: feature.construction,
      };
    case 'spline':
      return {
        id: feature.id,
        kind: 'spline',
        name: feature.name,
        planeId: feature.planeId,
        mode: feature.mode,
        points: feature.points.map(serializeCoordinate),
        closed: feature.closed,
        construction: feature.construction,
      };
  }
}

function serializeSketch(sketch: SketchDocument): SketchDocument {
  return {
    id: sketch.id,
    name: sketch.name,
    features: sketch.features.map(serializeSketchFeature),
  };
}

function serializeFaceRef(reference: SketchFaceRef): SketchFaceRef {
  return { sketchId: reference.sketchId, faceFeatureId: reference.faceFeatureId };
}

function serializeLineRef(reference: SketchLineRef): SketchLineRef {
  return { sketchId: reference.sketchId, lineFeatureId: reference.lineFeatureId };
}

function serializeRevolveAxis(axis: RevolveAxis): RevolveAxis {
  switch (axis.kind) {
    case 'world':
      return { kind: 'world', axis: axis.axis };
    case 'line':
      return { kind: 'line', line: serializeLineRef(axis.line) };
  }
}

// ---------------------------------------------------------------------------
// P3(§2.2、§2.6、§2.7、§2.7b、タスク19)が足す部分形状の参照と加工の欄
// ---------------------------------------------------------------------------

function serializeVec3(vector: Vec3): Vec3 {
  return [vector[0], vector[1], vector[2]];
}

/** 無い(null)ことがあるベクトルを書き出す。`undefined` にはせず、常に欄を持つ。 */
function serializeOptionalVec3(vector: Vec3 | null): Vec3 | null {
  return vector === null ? null : serializeVec3(vector);
}

function serializePointRef(reference: SketchPointRef): SketchPointRef {
  return { sketchId: reference.sketchId, pointFeatureId: reference.pointFeatureId };
}

function serializeSubShapeFingerprint(fingerprint: SubShapeFingerprint): SubShapeFingerprint {
  switch (fingerprint.kind) {
    case 'face':
      return {
        kind: 'face',
        surfaceKind: fingerprint.surfaceKind,
        area: fingerprint.area,
        position: serializeVec3(fingerprint.position),
        axis: serializeOptionalVec3(fingerprint.axis),
        radius: fingerprint.radius,
      };
    case 'edge':
      return {
        kind: 'edge',
        curveKind: fingerprint.curveKind,
        length: fingerprint.length,
        position: serializeVec3(fingerprint.position),
        axis: serializeOptionalVec3(fingerprint.axis),
        radius: fingerprint.radius,
      };
    case 'vertex':
      return { kind: 'vertex', position: serializeVec3(fingerprint.position) };
  }
}

function serializeSubShapeRef(reference: SubShapeRef): SubShapeRef {
  return {
    bodyFeatureId: reference.bodyFeatureId,
    index: reference.index,
    fingerprint: serializeSubShapeFingerprint(reference.fingerprint),
  };
}

function serializeHoleDepth(depth: HoleDepth): HoleDepth {
  switch (depth.kind) {
    case 'through':
      return { kind: 'through' };
    case 'blind':
      return { kind: 'blind', depth: serializeExpression(depth.depth) };
  }
}

function serializeChamferSize(size: ChamferSize): ChamferSize {
  switch (size.kind) {
    case 'equal':
      return { kind: 'equal', distance: serializeExpression(size.distance) };
    case 'twoDistances':
      return {
        kind: 'twoDistances',
        distance1: serializeExpression(size.distance1),
        distance2: serializeExpression(size.distance2),
      };
    case 'distanceAngle':
      return {
        kind: 'distanceAngle',
        distance: serializeExpression(size.distance),
        angle: serializeExpression(size.angle),
      };
  }
}

function serializePatternDirection(direction: PatternDirection): PatternDirection {
  switch (direction.kind) {
    case 'world':
      return { kind: 'world', axis: direction.axis };
    case 'line':
      return { kind: 'line', line: serializeLineRef(direction.line) };
  }
}

function serializePatternPlacement(placement: PatternPlacement): PatternPlacement {
  switch (placement.kind) {
    case 'linear':
      return {
        kind: 'linear',
        direction: serializePatternDirection(placement.direction),
        spacing: serializeExpression(placement.spacing),
        count: serializeExpression(placement.count),
        symmetric: placement.symmetric,
      };
    case 'circular':
      return {
        kind: 'circular',
        axis: serializePatternDirection(placement.axis),
        angle: serializeExpression(placement.angle),
        count: serializeExpression(placement.count),
        fullCircle: placement.fullCircle,
      };
  }
}

function serializeSolidFeature(feature: SolidFeature): SolidFeature {
  switch (feature.kind) {
    case 'extrude':
      return {
        id: feature.id,
        kind: 'extrude',
        name: feature.name,
        suppressed: feature.suppressed,
        profile: serializeFaceRef(feature.profile),
        distance: serializeExpression(feature.distance),
        reversed: feature.reversed,
        symmetric: feature.symmetric,
      };
    case 'revolve':
      return {
        id: feature.id,
        kind: 'revolve',
        name: feature.name,
        suppressed: feature.suppressed,
        profile: serializeFaceRef(feature.profile),
        axis: serializeRevolveAxis(feature.axis),
        angle: serializeExpression(feature.angle),
        reversed: feature.reversed,
      };
    case 'sew':
      return {
        id: feature.id,
        kind: 'sew',
        name: feature.name,
        suppressed: feature.suppressed,
        faces: feature.faces.map(serializeFaceRef),
        tolerance: serializeExpression(feature.tolerance),
      };
    case 'boolean':
      return {
        id: feature.id,
        kind: 'boolean',
        name: feature.name,
        suppressed: feature.suppressed,
        operation: feature.operation,
        targetFeatureId: feature.targetFeatureId,
        toolFeatureId: feature.toolFeatureId,
      };
    case 'hole':
      return {
        id: feature.id,
        kind: 'hole',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        face: serializeSubShapeRef(feature.face),
        centers: feature.centers.map(serializePointRef),
        diameter: serializeExpression(feature.diameter),
        depth: serializeHoleDepth(feature.depth),
        tiltAngle: serializeExpression(feature.tiltAngle),
        tiltAzimuth: serializeExpression(feature.tiltAzimuth),
      };
    case 'threadHole':
      return {
        id: feature.id,
        kind: 'threadHole',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        face: serializeSubShapeRef(feature.face),
        centers: feature.centers.map(serializePointRef),
        designation: feature.designation,
        series: feature.series,
        pitch: serializeExpression(feature.pitch),
        drillDiameter: serializeExpression(feature.drillDiameter),
        depth: serializeHoleDepth(feature.depth),
        threadLength: serializeExpression(feature.threadLength),
        representation: feature.representation,
        tiltAngle: serializeExpression(feature.tiltAngle),
        tiltAzimuth: serializeExpression(feature.tiltAzimuth),
      };
    case 'fillet':
      return {
        id: feature.id,
        kind: 'fillet',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        targets: feature.targets.map(serializeSubShapeRef),
        radius: serializeExpression(feature.radius),
      };
    case 'chamfer':
      return {
        id: feature.id,
        kind: 'chamfer',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        targets: feature.targets.map(serializeSubShapeRef),
        size: serializeChamferSize(feature.size),
        swapReferenceFace: feature.swapReferenceFace,
      };
    case 'pattern':
      return {
        id: feature.id,
        kind: 'pattern',
        name: feature.name,
        suppressed: feature.suppressed,
        sourceFeatureId: feature.sourceFeatureId,
        placement: serializePatternPlacement(feature.placement),
      };
    case 'spring':
      return {
        id: feature.id,
        kind: 'spring',
        name: feature.name,
        suppressed: feature.suppressed,
        origin: serializePointRef(feature.origin),
        axis: serializeRevolveAxis(feature.axis),
        tiltAngle: serializeExpression(feature.tiltAngle),
        tiltAzimuth: serializeExpression(feature.tiltAzimuth),
        length: serializeExpression(feature.length),
        pitch: serializeExpression(feature.pitch),
        turns: serializeExpression(feature.turns),
        derived: feature.derived,
        coilDiameter: serializeExpression(feature.coilDiameter),
        wireDiameter: serializeExpression(feature.wireDiameter),
        handedness: feature.handedness,
      };
  }
}

function serializePartDocument(document: PartDocument): PartDocument {
  return {
    id: document.id,
    name: document.name,
    schemaVersion: document.schemaVersion,
    sketches: document.sketches.map(serializeSketch),
    activeSketchId: document.activeSketchId,
    solids: document.solids.map(serializeSolidFeature),
  };
}

export interface SerializeOptions {
  /** 保存時刻(ISO 8601)。検査で時刻を固定するための口。既定は今の時刻。 */
  readonly savedAt?: string;
}

/**
 * 部品文書を `.pcad` の `document.json` の中身へ書き出す(UTF-8、インデント 2、末尾に改行 1 つ)。
 * 同じ文書からは必ず同じ文字列ができる(欄を決まった順で組み立てるため)。
 */
export function serializeDocument(document: PartDocument, options: SerializeOptions = {}): string {
  const envelope: PcadEnvelope = {
    // 封筒の版は文書の版と同じ値を書く(統括の決定④)。
    schema: document.schemaVersion,
    // このアプリが書き出すのは部品だけなので、種別は常に part(要件§8)。
    kind: PCAD_DOCUMENT_KIND,
    app: PCAD_APP_NAME,
    savedAt: options.savedAt ?? new Date().toISOString(),
    document: serializePartDocument(document),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

/** 配列の要素を1つずつ読む。1つでも読めなければ、その場所を添えて全体を断る。 */
function readList<T>(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
  readItem: (value: unknown, path: string) => Checked<T>,
): Checked<readonly T[]> {
  const array = readArray(source, key, parentPath);
  if (!array.ok) {
    return array;
  }
  const path = joinPath(parentPath, key);
  const items: T[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const item = readItem(array.value[index], indexPath(path, index));
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }
  return { ok: true, value: items };
}

function readPointReference(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PointReference> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, POINT_REFERENCE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'origin':
      return { ok: true, value: { kind: 'origin' } };
    case 'previous':
      return { ok: true, value: { kind: 'previous' } };
    case 'point': {
      const pointId = readString(record.value, 'pointId', path);
      if (!pointId.ok) {
        return pointId;
      }
      return { ok: true, value: { kind: 'point', pointId: pointId.value } };
    }
    case 'vertex': {
      const featureId = readString(record.value, 'featureId', path);
      if (!featureId.ok) {
        return featureId;
      }
      const vertex = readLiteral(record.value, 'vertex', path, VERTEX_NAMES);
      if (!vertex.ok) {
        return vertex;
      }
      return {
        ok: true,
        value: { kind: 'vertex', featureId: featureId.value, vertex: vertex.value },
      };
    }
  }
}

function readCoordinateRecord(
  record: Record<string, unknown>,
  path: string,
): Checked<CoordinateInput> {
  const mode = readLiteral(record, 'mode', path, COORDINATE_MODES);
  if (!mode.ok) {
    return mode;
  }
  switch (mode.value) {
    case 'absolute':
      return readAbsoluteCoordinate(record, path);
    case 'relative':
      return readRelativeCoordinate(record, path);
    case 'polar':
      return readPolarCoordinate(record, path);
  }
}

function readCoordinate(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<CoordinateInput> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  return readCoordinateRecord(record.value, joinPath(parentPath, key));
}

/** 配列の中の 1 点(スプラインの点の並び、FR-317)。`readList` へ渡す形。 */
function readCoordinateItem(value: unknown, path: string): Checked<CoordinateInput> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  return readCoordinateRecord(record.value, path);
}

function readAbsoluteCoordinate(
  record: Record<string, unknown>,
  path: string,
): Checked<CoordinateInput> {
  const x = readExpression(record, 'x', path);
  if (!x.ok) {
    return x;
  }
  const y = readExpression(record, 'y', path);
  if (!y.ok) {
    return y;
  }
  const z = readExpression(record, 'z', path);
  if (!z.ok) {
    return z;
  }
  return { ok: true, value: { mode: 'absolute', x: x.value, y: y.value, z: z.value } };
}

function readRelativeCoordinate(
  record: Record<string, unknown>,
  path: string,
): Checked<CoordinateInput> {
  const base = readPointReference(record, 'base', path);
  if (!base.ok) {
    return base;
  }
  const dx = readExpression(record, 'dx', path);
  if (!dx.ok) {
    return dx;
  }
  const dy = readExpression(record, 'dy', path);
  if (!dy.ok) {
    return dy;
  }
  const dz = readExpression(record, 'dz', path);
  if (!dz.ok) {
    return dz;
  }
  return {
    ok: true,
    value: { mode: 'relative', base: base.value, dx: dx.value, dy: dy.value, dz: dz.value },
  };
}

function readPolarCoordinate(
  record: Record<string, unknown>,
  path: string,
): Checked<CoordinateInput> {
  const base = readPointReference(record, 'base', path);
  if (!base.ok) {
    return base;
  }
  const distance = readExpression(record, 'distance', path);
  if (!distance.ok) {
    return distance;
  }
  const azimuth = readExpression(record, 'azimuth', path);
  if (!azimuth.ok) {
    return azimuth;
  }
  const elevation = readExpression(record, 'elevation', path);
  if (!elevation.ok) {
    return elevation;
  }
  return {
    ok: true,
    value: {
      mode: 'polar',
      base: base.value,
      distance: distance.value,
      azimuth: azimuth.value,
      elevation: elevation.value,
    },
  };
}

function readElementRef(value: unknown, path: string): Checked<SketchElementRef> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const featureId = readString(record.value, 'featureId', path);
  if (!featureId.ok) {
    return featureId;
  }
  // index は点列の中の 1 点を指すときだけ付く。無ければ欄ごと持たない。
  if (!('index' in record.value)) {
    return { ok: true, value: { featureId: featureId.value } };
  }
  const index = readNumber(record.value, 'index', path);
  if (!index.ok) {
    return index;
  }
  return { ok: true, value: { featureId: featureId.value, index: index.value } };
}

/** スケッチフィーチャーに共通の欄。 */
interface SketchFeatureBase {
  readonly id: string;
  readonly name: string;
  readonly planeId: WorkPlaneId;
}

function readSketchFeatureBase(
  record: Record<string, unknown>,
  path: string,
): Checked<SketchFeatureBase> {
  const id = readString(record, 'id', path);
  if (!id.ok) {
    return id;
  }
  const name = readString(record, 'name', path);
  if (!name.ok) {
    return name;
  }
  const planeId = readLiteral(record, 'planeId', path, WORK_PLANE_IDS);
  if (!planeId.ok) {
    return planeId;
  }
  return { ok: true, value: { id: id.value, name: name.value, planeId: planeId.value } };
}

function readSketchFeature(value: unknown, path: string): Checked<SketchFeature> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, SKETCH_FEATURE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const base = readSketchFeatureBase(record.value, path);
  if (!base.ok) {
    return base;
  }
  switch (kind.value) {
    case 'point':
      return readPointFeature(record.value, path, base.value);
    case 'line':
      return readLineFeature(record.value, path, base.value);
    case 'arc':
      return readArcFeature(record.value, path, base.value);
    case 'pointArray':
      return readPointArrayFeature(record.value, path, base.value);
    case 'face':
      return readFaceFeature(record.value, path, base.value);
    case 'rectangle':
      return readRectangleFeature(record.value, path, base.value);
    case 'polygon':
      return readPolygonFeature(record.value, path, base.value);
    case 'slot':
      return readSlotFeature(record.value, path, base.value);
    case 'ellipse':
      return readEllipseFeature(record.value, path, base.value);
    case 'spline':
      return readSplineFeature(record.value, path, base.value);
  }
}

/**
 * 構築線(FR-320)の欄。**版3以前(スキーマ版は上げない、統括の差し戻し 2026-09-04)は
 * この欄を持たないファイルもあるため、無ければ false として読む**(要件§8の前方互換、
 * P3完了条件9「版2のファイルも開ける」と同じ考え方)。書き手(`serializeSketchFeature`)は
 * 常にこの欄を書くので、往復すると新形式(欄あり)へ正規化される。
 */
function readConstructionFlag(record: Record<string, unknown>, path: string): Checked<boolean> {
  if (!('construction' in record)) {
    return { ok: true, value: false };
  }
  return readBoolean(record, 'construction', path);
}

function readPointFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const at = readCoordinate(record, 'at', path);
  if (!at.ok) {
    return at;
  }
  return { ok: true, value: { ...base, kind: 'point', at: at.value } };
}

function readLineFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const from = readCoordinate(record, 'from', path);
  if (!from.ok) {
    return from;
  }
  const to = readCoordinate(record, 'to', path);
  if (!to.ok) {
    return to;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'line',
      from: from.value,
      to: to.value,
      construction: construction.value,
    },
  };
}

function readArcFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const radius = readExpression(record, 'radius', path);
  if (!radius.ok) {
    return radius;
  }
  const startAngle = readExpression(record, 'startAngle', path);
  if (!startAngle.ok) {
    return startAngle;
  }
  const endAngle = readExpression(record, 'endAngle', path);
  if (!endAngle.ok) {
    return endAngle;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'arc',
      center: center.value,
      radius: radius.value,
      startAngle: startAngle.value,
      endAngle: endAngle.value,
      construction: construction.value,
    },
  };
}

/**
 * 点列の並べ方(FR-327、タスク6)。`kind` で直線状・円周上・格子状を見分けてから
 * 種類ごとの欄を読む(スプラインの `mode` と同じ、先に判別子だけを確かめる書き方)。
 */
function readPointArrayLayout(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PointArrayLayout> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, POINT_ARRAY_LAYOUT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'linear':
      return readLinearLayout(record.value, path);
    case 'circular':
      return readCircularLayout(record.value, path);
    case 'grid':
      return readGridLayout(record.value, path);
  }
}

function readLinearLayout(
  record: Record<string, unknown>,
  path: string,
): Checked<PointArrayLayout> {
  const base = readCoordinate(record, 'base', path);
  if (!base.ok) {
    return base;
  }
  const azimuth = readExpression(record, 'azimuth', path);
  if (!azimuth.ok) {
    return azimuth;
  }
  const spacing = readExpression(record, 'spacing', path);
  if (!spacing.ok) {
    return spacing;
  }
  const count = readExpression(record, 'count', path);
  if (!count.ok) {
    return count;
  }
  return {
    ok: true,
    value: {
      kind: 'linear',
      base: base.value,
      azimuth: azimuth.value,
      spacing: spacing.value,
      count: count.value,
    },
  };
}

function readCircularLayout(
  record: Record<string, unknown>,
  path: string,
): Checked<PointArrayLayout> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const radius = readExpression(record, 'radius', path);
  if (!radius.ok) {
    return radius;
  }
  const count = readExpression(record, 'count', path);
  if (!count.ok) {
    return count;
  }
  return {
    ok: true,
    value: { kind: 'circular', center: center.value, radius: radius.value, count: count.value },
  };
}

function readGridLayout(
  record: Record<string, unknown>,
  path: string,
): Checked<PointArrayLayout> {
  const base = readCoordinate(record, 'base', path);
  if (!base.ok) {
    return base;
  }
  const rowAzimuth = readExpression(record, 'rowAzimuth', path);
  if (!rowAzimuth.ok) {
    return rowAzimuth;
  }
  const rowSpacing = readExpression(record, 'rowSpacing', path);
  if (!rowSpacing.ok) {
    return rowSpacing;
  }
  const rowCount = readExpression(record, 'rowCount', path);
  if (!rowCount.ok) {
    return rowCount;
  }
  const colAzimuth = readExpression(record, 'colAzimuth', path);
  if (!colAzimuth.ok) {
    return colAzimuth;
  }
  const colSpacing = readExpression(record, 'colSpacing', path);
  if (!colSpacing.ok) {
    return colSpacing;
  }
  const colCount = readExpression(record, 'colCount', path);
  if (!colCount.ok) {
    return colCount;
  }
  return {
    ok: true,
    value: {
      kind: 'grid',
      base: base.value,
      rowAzimuth: rowAzimuth.value,
      rowSpacing: rowSpacing.value,
      rowCount: rowCount.value,
      colAzimuth: colAzimuth.value,
      colSpacing: colSpacing.value,
      colCount: colCount.value,
    },
  };
}

/**
 * 点列(FR-308、FR-327)。**版3以前(スキーマ版は上げない)は `layout` を挟まず、
 * `base`/`azimuth`/`spacing`/`count` を直下に持つ**(統括の差し戻し 2026-09-04、要件§8の
 * 前方互換、P3完了条件9)。`layout` が無ければ旧形式とみなし、直線状(`kind: 'linear'`)へ
 * 包み直して読む。`readLinearLayout` は「base/azimuth/spacing/count を直下に持つ record」を
 * 読む関数なので、`layout` サブレコードにも版3以前のフラットな record にもそのまま使える。
 * 書き手は常に `layout` を書くので、往復すると新形式へ正規化される。
 */
function readPointArrayFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  if (!('layout' in record)) {
    const legacy = readLinearLayout(record, path);
    if (!legacy.ok) {
      return legacy;
    }
    return { ok: true, value: { ...base, kind: 'pointArray', layout: legacy.value } };
  }
  const layout = readPointArrayLayout(record, 'layout', path);
  if (!layout.ok) {
    return layout;
  }
  return { ok: true, value: { ...base, kind: 'pointArray', layout: layout.value } };
}

function readFaceFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const boundary = readList(record, 'boundary', path, readElementRef);
  if (!boundary.ok) {
    return boundary;
  }
  const color = readString(record, 'color', path);
  if (!color.ok) {
    return color;
  }
  return {
    ok: true,
    value: { ...base, kind: 'face', boundary: boundary.value, color: color.value },
  };
}

function readRectangleFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const corner1 = readCoordinate(record, 'corner1', path);
  if (!corner1.ok) {
    return corner1;
  }
  const corner2 = readCoordinate(record, 'corner2', path);
  if (!corner2.ok) {
    return corner2;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'rectangle',
      corner1: corner1.value,
      corner2: corner2.value,
      construction: construction.value,
    },
  };
}

function readPolygonFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const sides = readExpression(record, 'sides', path);
  if (!sides.ok) {
    return sides;
  }
  const radius = readExpression(record, 'radius', path);
  if (!radius.ok) {
    return radius;
  }
  const radiusMode = readLiteral(record, 'radiusMode', path, POLYGON_RADIUS_MODES);
  if (!radiusMode.ok) {
    return radiusMode;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'polygon',
      center: center.value,
      sides: sides.value,
      radius: radius.value,
      radiusMode: radiusMode.value,
      construction: construction.value,
    },
  };
}

function readSlotFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const center1 = readCoordinate(record, 'center1', path);
  if (!center1.ok) {
    return center1;
  }
  const center2 = readCoordinate(record, 'center2', path);
  if (!center2.ok) {
    return center2;
  }
  const width = readExpression(record, 'width', path);
  if (!width.ok) {
    return width;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'slot',
      center1: center1.value,
      center2: center2.value,
      width: width.value,
      construction: construction.value,
    },
  };
}

function readEllipseFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const majorRadius = readExpression(record, 'majorRadius', path);
  if (!majorRadius.ok) {
    return majorRadius;
  }
  const minorRadius = readExpression(record, 'minorRadius', path);
  if (!minorRadius.ok) {
    return minorRadius;
  }
  const rotation = readExpression(record, 'rotation', path);
  if (!rotation.ok) {
    return rotation;
  }
  const startAngle = readExpression(record, 'startAngle', path);
  if (!startAngle.ok) {
    return startAngle;
  }
  const endAngle = readExpression(record, 'endAngle', path);
  if (!endAngle.ok) {
    return endAngle;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'ellipse',
      center: center.value,
      majorRadius: majorRadius.value,
      minorRadius: minorRadius.value,
      rotation: rotation.value,
      startAngle: startAngle.value,
      endAngle: endAngle.value,
      construction: construction.value,
    },
  };
}

function readSplineFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const mode = readLiteral(record, 'mode', path, SPLINE_MODES);
  if (!mode.ok) {
    return mode;
  }
  const points = readList(record, 'points', path, readCoordinateItem);
  if (!points.ok) {
    return points;
  }
  const closed = readBoolean(record, 'closed', path);
  if (!closed.ok) {
    return closed;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'spline',
      mode: mode.value,
      points: points.value,
      closed: closed.value,
      construction: construction.value,
    },
  };
}

function readSketch(value: unknown, path: string): Checked<SketchDocument> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = readString(record.value, 'id', path);
  if (!id.ok) {
    return id;
  }
  const name = readString(record.value, 'name', path);
  if (!name.ok) {
    return name;
  }
  const features = readList(record.value, 'features', path, readSketchFeature);
  if (!features.ok) {
    return features;
  }
  return { ok: true, value: { id: id.value, name: name.value, features: features.value } };
}

function readFaceRef(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<SketchFaceRef> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readFaceRefItem(found.value, joinPath(parentPath, key));
}

function readFaceRefItem(value: unknown, path: string): Checked<SketchFaceRef> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const sketchId = readString(record.value, 'sketchId', path);
  if (!sketchId.ok) {
    return sketchId;
  }
  const faceFeatureId = readString(record.value, 'faceFeatureId', path);
  if (!faceFeatureId.ok) {
    return faceFeatureId;
  }
  return { ok: true, value: { sketchId: sketchId.value, faceFeatureId: faceFeatureId.value } };
}

function readRevolveAxis(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<RevolveAxis> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, REVOLVE_AXIS_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'world': {
      const axis = readLiteral(record.value, 'axis', path, WORLD_AXES);
      if (!axis.ok) {
        return axis;
      }
      return { ok: true, value: { kind: 'world', axis: axis.value } };
    }
    case 'line': {
      const line = readRecord(record.value, 'line', path);
      if (!line.ok) {
        return line;
      }
      const linePath = joinPath(path, 'line');
      const sketchId = readString(line.value, 'sketchId', linePath);
      if (!sketchId.ok) {
        return sketchId;
      }
      const lineFeatureId = readString(line.value, 'lineFeatureId', linePath);
      if (!lineFeatureId.ok) {
        return lineFeatureId;
      }
      return {
        ok: true,
        value: {
          kind: 'line',
          line: { sketchId: sketchId.value, lineFeatureId: lineFeatureId.value },
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// P3(§2.2、§2.6、§2.7、§2.7b、タスク19)が足す部分形状の参照と加工の欄の読み込み
// ---------------------------------------------------------------------------

/**
 * スケッチの点・点列フィーチャーへの参照を読む(穴の中心・ばねの始点、§0.a-0.9、§0.a-0.29)。
 * `readSubShapeRef` と同じく、値を直に読む版(readPointRef)と欄から読む版(readPointRefField)
 * の組にする(`readFaceRef` / `readFaceRefItem` と同じ流儀)。
 */
function readPointRef(value: unknown, path: string): Checked<SketchPointRef> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const sketchId = readString(record.value, 'sketchId', path);
  if (!sketchId.ok) {
    return sketchId;
  }
  const pointFeatureId = readString(record.value, 'pointFeatureId', path);
  if (!pointFeatureId.ok) {
    return pointFeatureId;
  }
  return { ok: true, value: { sketchId: sketchId.value, pointFeatureId: pointFeatureId.value } };
}

function readPointRefField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<SketchPointRef> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readPointRef(found.value, joinPath(parentPath, key));
}

/**
 * 部分形状の指紋を種類ごとに読む(§2.2.2)。`face` / `edge` / `vertex` で欄が違うので、
 * `kind` を先に判別してから分ける。
 */
function readSubShapeFingerprint(value: unknown, path: string): Checked<SubShapeFingerprint> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, SUB_SHAPE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'face': {
      const surfaceKind = readLiteral(record.value, 'surfaceKind', path, FACE_SURFACE_KINDS);
      if (!surfaceKind.ok) {
        return surfaceKind;
      }
      const area = readNumber(record.value, 'area', path);
      if (!area.ok) {
        return area;
      }
      const position = readVec3(record.value, 'position', path);
      if (!position.ok) {
        return position;
      }
      const axis = readOptionalVec3(record.value, 'axis', path);
      if (!axis.ok) {
        return axis;
      }
      const radius = readOptionalNumber(record.value, 'radius', path);
      if (!radius.ok) {
        return radius;
      }
      return {
        ok: true,
        value: {
          kind: 'face',
          surfaceKind: surfaceKind.value,
          area: area.value,
          position: position.value,
          axis: axis.value,
          radius: radius.value,
        },
      };
    }
    case 'edge': {
      const curveKind = readLiteral(record.value, 'curveKind', path, EDGE_CURVE_KINDS);
      if (!curveKind.ok) {
        return curveKind;
      }
      const length = readNumber(record.value, 'length', path);
      if (!length.ok) {
        return length;
      }
      const position = readVec3(record.value, 'position', path);
      if (!position.ok) {
        return position;
      }
      const axis = readOptionalVec3(record.value, 'axis', path);
      if (!axis.ok) {
        return axis;
      }
      const radius = readOptionalNumber(record.value, 'radius', path);
      if (!radius.ok) {
        return radius;
      }
      return {
        ok: true,
        value: {
          kind: 'edge',
          curveKind: curveKind.value,
          length: length.value,
          position: position.value,
          axis: axis.value,
          radius: radius.value,
        },
      };
    }
    case 'vertex': {
      const position = readVec3(record.value, 'position', path);
      if (!position.ok) {
        return position;
      }
      return { ok: true, value: { kind: 'vertex', position: position.value } };
    }
  }
}

/** 部分形状への参照を読む(面・辺・頂点、5種類のフィーチャーが共有する)。 */
function readSubShapeRef(value: unknown, path: string): Checked<SubShapeRef> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const bodyFeatureId = readString(record.value, 'bodyFeatureId', path);
  if (!bodyFeatureId.ok) {
    return bodyFeatureId;
  }
  const index = readNumber(record.value, 'index', path);
  if (!index.ok) {
    return index;
  }
  const fingerprintField = readValue(record.value, 'fingerprint', path);
  if (!fingerprintField.ok) {
    return fingerprintField;
  }
  const fingerprint = readSubShapeFingerprint(
    fingerprintField.value,
    joinPath(path, 'fingerprint'),
  );
  if (!fingerprint.ok) {
    return fingerprint;
  }
  return {
    ok: true,
    value: {
      bodyFeatureId: bodyFeatureId.value,
      index: index.value,
      fingerprint: fingerprint.value,
    },
  };
}

function readSubShapeRefField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<SubShapeRef> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readSubShapeRef(found.value, joinPath(parentPath, key));
}

/** 穴の深さ(貫通/止まり、§0.a-0.12)を読む。 */
function readHoleDepth(value: unknown, path: string): Checked<HoleDepth> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, HOLE_DEPTH_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'through':
      return { ok: true, value: { kind: 'through' } };
    case 'blind': {
      const depth = readExpression(record.value, 'depth', path);
      if (!depth.ok) {
        return depth;
      }
      return { ok: true, value: { kind: 'blind', depth: depth.value } };
    }
  }
}

function readHoleDepthField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<HoleDepth> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readHoleDepth(found.value, joinPath(parentPath, key));
}

/** C 面取りの大きさ(等距離・2距離・距離と角度、§0.a-0.18)を読む。 */
function readChamferSize(value: unknown, path: string): Checked<ChamferSize> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, CHAMFER_SIZE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'equal': {
      const distance = readExpression(record.value, 'distance', path);
      if (!distance.ok) {
        return distance;
      }
      return { ok: true, value: { kind: 'equal', distance: distance.value } };
    }
    case 'twoDistances': {
      const distance1 = readExpression(record.value, 'distance1', path);
      if (!distance1.ok) {
        return distance1;
      }
      const distance2 = readExpression(record.value, 'distance2', path);
      if (!distance2.ok) {
        return distance2;
      }
      return {
        ok: true,
        value: { kind: 'twoDistances', distance1: distance1.value, distance2: distance2.value },
      };
    }
    case 'distanceAngle': {
      const distance = readExpression(record.value, 'distance', path);
      if (!distance.ok) {
        return distance;
      }
      const angle = readExpression(record.value, 'angle', path);
      if (!angle.ok) {
        return angle;
      }
      return {
        ok: true,
        value: { kind: 'distanceAngle', distance: distance.value, angle: angle.value },
      };
    }
  }
}

function readChamferSizeField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ChamferSize> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readChamferSize(found.value, joinPath(parentPath, key));
}

/**
 * パターンの向き・軸(§0.a-0.21)を読む。`RevolveAxis` と欄の形は同じだが、
 * 意味が違う別の型なので `readRevolveAxis` を使い回さず、同じ組み立てを別に持つ
 * (model 側が2つの型を分けているのと揃える)。
 */
function readPatternDirection(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PatternDirection> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, PATTERN_DIRECTION_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'world': {
      const axis = readLiteral(record.value, 'axis', path, WORLD_AXES);
      if (!axis.ok) {
        return axis;
      }
      return { ok: true, value: { kind: 'world', axis: axis.value } };
    }
    case 'line': {
      const line = readRecord(record.value, 'line', path);
      if (!line.ok) {
        return line;
      }
      const linePath = joinPath(path, 'line');
      const sketchId = readString(line.value, 'sketchId', linePath);
      if (!sketchId.ok) {
        return sketchId;
      }
      const lineFeatureId = readString(line.value, 'lineFeatureId', linePath);
      if (!lineFeatureId.ok) {
        return lineFeatureId;
      }
      return {
        ok: true,
        value: {
          kind: 'line',
          line: { sketchId: sketchId.value, lineFeatureId: lineFeatureId.value },
        },
      };
    }
  }
}

/** パターンの並べ方(直線・円形、§2.7)を読む。 */
function readPatternPlacement(value: unknown, path: string): Checked<PatternPlacement> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, PATTERN_PLACEMENT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'linear': {
      const direction = readPatternDirection(record.value, 'direction', path);
      if (!direction.ok) {
        return direction;
      }
      const spacing = readExpression(record.value, 'spacing', path);
      if (!spacing.ok) {
        return spacing;
      }
      const count = readExpression(record.value, 'count', path);
      if (!count.ok) {
        return count;
      }
      const symmetric = readBoolean(record.value, 'symmetric', path);
      if (!symmetric.ok) {
        return symmetric;
      }
      return {
        ok: true,
        value: {
          kind: 'linear',
          direction: direction.value,
          spacing: spacing.value,
          count: count.value,
          symmetric: symmetric.value,
        },
      };
    }
    case 'circular': {
      const axis = readPatternDirection(record.value, 'axis', path);
      if (!axis.ok) {
        return axis;
      }
      const angle = readExpression(record.value, 'angle', path);
      if (!angle.ok) {
        return angle;
      }
      const count = readExpression(record.value, 'count', path);
      if (!count.ok) {
        return count;
      }
      const fullCircle = readBoolean(record.value, 'fullCircle', path);
      if (!fullCircle.ok) {
        return fullCircle;
      }
      return {
        ok: true,
        value: {
          kind: 'circular',
          axis: axis.value,
          angle: angle.value,
          count: count.value,
          fullCircle: fullCircle.value,
        },
      };
    }
  }
}

function readPatternPlacementField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PatternPlacement> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readPatternPlacement(found.value, joinPath(parentPath, key));
}

/** ソリッドフィーチャーに共通の欄。 */
interface SolidFeatureBase {
  readonly id: string;
  readonly name: string;
  readonly suppressed: boolean;
}

function readSolidFeatureBase(
  record: Record<string, unknown>,
  path: string,
): Checked<SolidFeatureBase> {
  const id = readString(record, 'id', path);
  if (!id.ok) {
    return id;
  }
  const name = readString(record, 'name', path);
  if (!name.ok) {
    return name;
  }
  const suppressed = readBoolean(record, 'suppressed', path);
  if (!suppressed.ok) {
    return suppressed;
  }
  return { ok: true, value: { id: id.value, name: name.value, suppressed: suppressed.value } };
}

function readSolidFeature(value: unknown, path: string): Checked<SolidFeature> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, SOLID_FEATURE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const base = readSolidFeatureBase(record.value, path);
  if (!base.ok) {
    return base;
  }
  switch (kind.value) {
    case 'extrude':
      return readExtrudeFeature(record.value, path, base.value);
    case 'revolve':
      return readRevolveFeature(record.value, path, base.value);
    case 'sew':
      return readSewFeature(record.value, path, base.value);
    case 'boolean':
      return readBooleanFeature(record.value, path, base.value);
    case 'hole':
      return readHoleFeature(record.value, path, base.value);
    case 'threadHole':
      return readThreadHoleFeature(record.value, path, base.value);
    case 'fillet':
      return readFilletFeature(record.value, path, base.value);
    case 'chamfer':
      return readChamferFeature(record.value, path, base.value);
    case 'pattern':
      return readPatternFeature(record.value, path, base.value);
    case 'spring':
      return readSpringFeature(record.value, path, base.value);
  }
}

function readExtrudeFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const profile = readFaceRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const distance = readExpression(record, 'distance', path);
  if (!distance.ok) {
    return distance;
  }
  const reversed = readBoolean(record, 'reversed', path);
  if (!reversed.ok) {
    return reversed;
  }
  const symmetric = readBoolean(record, 'symmetric', path);
  if (!symmetric.ok) {
    return symmetric;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'extrude',
      profile: profile.value,
      distance: distance.value,
      reversed: reversed.value,
      symmetric: symmetric.value,
    },
  };
}

function readRevolveFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const profile = readFaceRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const axis = readRevolveAxis(record, 'axis', path);
  if (!axis.ok) {
    return axis;
  }
  const angle = readExpression(record, 'angle', path);
  if (!angle.ok) {
    return angle;
  }
  const reversed = readBoolean(record, 'reversed', path);
  if (!reversed.ok) {
    return reversed;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'revolve',
      profile: profile.value,
      axis: axis.value,
      angle: angle.value,
      reversed: reversed.value,
    },
  };
}

function readSewFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const faces = readList(record, 'faces', path, readFaceRefItem);
  if (!faces.ok) {
    return faces;
  }
  const tolerance = readExpression(record, 'tolerance', path);
  if (!tolerance.ok) {
    return tolerance;
  }
  return {
    ok: true,
    value: { ...base, kind: 'sew', faces: faces.value, tolerance: tolerance.value },
  };
}

function readBooleanFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const operation = readLiteral(record, 'operation', path, BOOLEAN_OPERATIONS);
  if (!operation.ok) {
    return operation;
  }
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const toolFeatureId = readString(record, 'toolFeatureId', path);
  if (!toolFeatureId.ok) {
    return toolFeatureId;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'boolean',
      operation: operation.value,
      targetFeatureId: targetFeatureId.value,
      toolFeatureId: toolFeatureId.value,
    },
  };
}

/** 穴(FR-405、§0.a-0.9〜0.a-0.12)を読む。中心は1つ以上(点列は展開済みの一覧として保存)。 */
function readHoleFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const face = readSubShapeRefField(record, 'face', path);
  if (!face.ok) {
    return face;
  }
  const centers = readList(record, 'centers', path, readPointRef);
  if (!centers.ok) {
    return centers;
  }
  const diameter = readExpression(record, 'diameter', path);
  if (!diameter.ok) {
    return diameter;
  }
  const depth = readHoleDepthField(record, 'depth', path);
  if (!depth.ok) {
    return depth;
  }
  const tiltAngle = readExpression(record, 'tiltAngle', path);
  if (!tiltAngle.ok) {
    return tiltAngle;
  }
  const tiltAzimuth = readExpression(record, 'tiltAzimuth', path);
  if (!tiltAzimuth.ok) {
    return tiltAzimuth;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'hole',
      targetFeatureId: targetFeatureId.value,
      face: face.value,
      centers: centers.value,
      diameter: diameter.value,
      depth: depth.value,
      tiltAngle: tiltAngle.value,
      tiltAzimuth: tiltAzimuth.value,
    },
  };
}

/** ねじ穴(FR-406、§0.a-0.13〜0.a-0.16)を読む。呼び・系列は一覧と突き合わせて絞る。 */
function readThreadHoleFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const face = readSubShapeRefField(record, 'face', path);
  if (!face.ok) {
    return face;
  }
  const centers = readList(record, 'centers', path, readPointRef);
  if (!centers.ok) {
    return centers;
  }
  const designation = readString(record, 'designation', path);
  if (!designation.ok) {
    return designation;
  }
  const series = readLiteral(record, 'series', path, THREAD_SERIES);
  if (!series.ok) {
    return series;
  }
  const pitch = readExpression(record, 'pitch', path);
  if (!pitch.ok) {
    return pitch;
  }
  const drillDiameter = readExpression(record, 'drillDiameter', path);
  if (!drillDiameter.ok) {
    return drillDiameter;
  }
  const depth = readHoleDepthField(record, 'depth', path);
  if (!depth.ok) {
    return depth;
  }
  const threadLength = readExpression(record, 'threadLength', path);
  if (!threadLength.ok) {
    return threadLength;
  }
  const representation = readLiteral(record, 'representation', path, THREAD_REPRESENTATIONS);
  if (!representation.ok) {
    return representation;
  }
  const tiltAngle = readExpression(record, 'tiltAngle', path);
  if (!tiltAngle.ok) {
    return tiltAngle;
  }
  const tiltAzimuth = readExpression(record, 'tiltAzimuth', path);
  if (!tiltAzimuth.ok) {
    return tiltAzimuth;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'threadHole',
      targetFeatureId: targetFeatureId.value,
      face: face.value,
      centers: centers.value,
      designation: designation.value,
      series: series.value,
      pitch: pitch.value,
      drillDiameter: drillDiameter.value,
      depth: depth.value,
      threadLength: threadLength.value,
      representation: representation.value,
      tiltAngle: tiltAngle.value,
      tiltAzimuth: tiltAzimuth.value,
    },
  };
}

/** R 面取り(FR-407、§0.a-0.17)を読む。丸める辺・頂点の一覧(頂点は展開せずそのまま保存)。 */
function readFilletFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const targets = readList(record, 'targets', path, readSubShapeRef);
  if (!targets.ok) {
    return targets;
  }
  const radius = readExpression(record, 'radius', path);
  if (!radius.ok) {
    return radius;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'fillet',
      targetFeatureId: targetFeatureId.value,
      targets: targets.value,
      radius: radius.value,
    },
  };
}

/** C 面取り(FR-408、§0.a-0.18)を読む。 */
function readChamferFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const targets = readList(record, 'targets', path, readSubShapeRef);
  if (!targets.ok) {
    return targets;
  }
  const size = readChamferSizeField(record, 'size', path);
  if (!size.ok) {
    return size;
  }
  const swapReferenceFace = readBoolean(record, 'swapReferenceFace', path);
  if (!swapReferenceFace.ok) {
    return swapReferenceFace;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'chamfer',
      targetFeatureId: targetFeatureId.value,
      targets: targets.value,
      size: size.value,
      swapReferenceFace: swapReferenceFace.value,
    },
  };
}

/** パターン(FR-411、FR-412、§0.a-0.20、§0.a-0.21)を読む。もとにする加工フィーチャーの id を持つ。 */
function readPatternFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const sourceFeatureId = readString(record, 'sourceFeatureId', path);
  if (!sourceFeatureId.ok) {
    return sourceFeatureId;
  }
  const placement = readPatternPlacementField(record, 'placement', path);
  if (!placement.ok) {
    return placement;
  }
  return {
    ok: true,
    value: { ...base, kind: 'pattern', sourceFeatureId: sourceFeatureId.value, placement: placement.value },
  };
}

/**
 * ばね(FR-414、§2.7b)を読む。`derived` / `handedness` は選択肢の一覧と突き合わせて絞る
 * (知らない値は断る)。
 */
function readSpringFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const origin = readPointRefField(record, 'origin', path);
  if (!origin.ok) {
    return origin;
  }
  const axis = readRevolveAxis(record, 'axis', path);
  if (!axis.ok) {
    return axis;
  }
  const tiltAngle = readExpression(record, 'tiltAngle', path);
  if (!tiltAngle.ok) {
    return tiltAngle;
  }
  const tiltAzimuth = readExpression(record, 'tiltAzimuth', path);
  if (!tiltAzimuth.ok) {
    return tiltAzimuth;
  }
  const length = readExpression(record, 'length', path);
  if (!length.ok) {
    return length;
  }
  const pitch = readExpression(record, 'pitch', path);
  if (!pitch.ok) {
    return pitch;
  }
  const turns = readExpression(record, 'turns', path);
  if (!turns.ok) {
    return turns;
  }
  const derived = readLiteral(record, 'derived', path, SPRING_DERIVED_VALUES);
  if (!derived.ok) {
    return derived;
  }
  const coilDiameter = readExpression(record, 'coilDiameter', path);
  if (!coilDiameter.ok) {
    return coilDiameter;
  }
  const wireDiameter = readExpression(record, 'wireDiameter', path);
  if (!wireDiameter.ok) {
    return wireDiameter;
  }
  const handedness = readLiteral(record, 'handedness', path, SPRING_HANDEDNESS_VALUES);
  if (!handedness.ok) {
    return handedness;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'spring',
      origin: origin.value,
      axis: axis.value,
      tiltAngle: tiltAngle.value,
      tiltAzimuth: tiltAzimuth.value,
      length: length.value,
      pitch: pitch.value,
      turns: turns.value,
      derived: derived.value,
      coilDiameter: coilDiameter.value,
      wireDiameter: wireDiameter.value,
      handedness: handedness.value,
    },
  };
}

function readPartDocument(value: unknown, path: string): Checked<PartDocument> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = readString(record.value, 'id', path);
  if (!id.ok) {
    return id;
  }
  const name = readString(record.value, 'name', path);
  if (!name.ok) {
    return name;
  }
  const schemaVersion = readNumber(record.value, 'schemaVersion', path);
  if (!schemaVersion.ok) {
    return schemaVersion;
  }
  const sketches = readList(record.value, 'sketches', path, readSketch);
  if (!sketches.ok) {
    return sketches;
  }
  const activeSketchId = readString(record.value, 'activeSketchId', path);
  if (!activeSketchId.ok) {
    return activeSketchId;
  }
  const solids = readList(record.value, 'solids', path, readSolidFeature);
  if (!solids.ok) {
    return solids;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      schemaVersion: schemaVersion.value,
      sketches: sketches.value,
      activeSketchId: activeSketchId.value,
      solids: solids.value,
    },
  };
}

// ---------------------------------------------------------------------------
// 読み込みの入口と断り方(FR-504、NFR-UX-5)
// ---------------------------------------------------------------------------

export type ParseErrorCode =
  /** JSON として読めない。 */
  | 'invalidJson'
  /** PointerCAD の部品ファイルの封筒になっていない。 */
  | 'notPcad'
  /** PointerCAD のファイルではあるが、部品ではない種別(アセンブリ・図面)。 */
  | 'unsupportedKind'
  /** 版が古すぎて、今の版まで持ち上げる手立てが無い。 */
  | 'unsupportedOldVersion'
  /** 版が新しすぎる(このアプリより後の版で保存された)。 */
  | 'unsupportedNewVersion'
  /** 封筒の版と文書の版が食い違う。 */
  | 'versionMismatch'
  /** 必要な欄が無い。 */
  | 'missingField'
  /** 欄はあるが型が違う。 */
  | 'invalidField';

/** 読み込めなかった理由。`message` はそのまま利用者へ見せる日本語(NFR-UX-5)。 */
export interface ParseError {
  readonly code: ParseErrorCode;
  readonly message: string;
}

export type ParseDocumentResult =
  | { readonly ok: true; readonly document: PartDocument; readonly savedAt: string }
  | { readonly ok: false; readonly error: ParseError };

const NOT_PCAD_MESSAGE = 'PointerCAD の部品ファイルではないようです。';

function fail(code: ParseErrorCode, message: string): ParseDocumentResult {
  return { ok: false, error: { code, message } };
}

/** 欄の不備を、場所を添えた日本語にする。 */
function failField(problem: FieldProblem): ParseDocumentResult {
  return problem.reason === 'missing'
    ? fail('missingField', `ファイルの中身が壊れています(${problem.path} が見つかりません)。`)
    : fail('invalidField', `ファイルの中身が壊れています(${problem.path} の形が違います)。`);
}

function parseJsonText(text: string): Checked<unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return fieldProblem('', 'type');
  }
}

/**
 * 古い版を今の版まで順に持ち上げる(要件§8 の前方互換)。持ち上げられなければ null。
 * P2 では `SCHEMA_MIGRATIONS` が空なので、版 1 はここで必ず null になる。
 */
function migrateToCurrentSchema(
  raw: Record<string, unknown>,
  schema: number,
): Record<string, unknown> | null {
  let current = raw;
  let version = schema;
  while (version < PCAD_SCHEMA_VERSION) {
    const migration = SCHEMA_MIGRATIONS[version];
    if (migration === undefined) {
      return null;
    }
    const lifted = migration(current);
    if (!isRecord(lifted)) {
      return null;
    }
    const next = readNumber(lifted, 'schema', '');
    // 版が上がらない変換は同じ段を回り続けるので、変換表の誤りとして断る。
    if (!next.ok || next.value <= version) {
      return null;
    }
    current = lifted;
    version = next.value;
  }
  return version === PCAD_SCHEMA_VERSION ? current : null;
}

/** 版の判定が済んだ封筒を読む。 */
function readEnvelope(raw: Record<string, unknown>, schema: number): ParseDocumentResult {
  const app = readString(raw, 'app', '');
  if (!app.ok || app.value !== PCAD_APP_NAME) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  // 種別は封筒の欄なので、中身を読む前に見る(統括の決定、要件§8)。
  // 欄そのものが無い・文字列でないものは PointerCAD の封筒になっていないので notPcad、
  // 文字列だが part でないものは「PointerCAD のファイルだが、この種類はまだ読めない」と分けて断る。
  const kind = readString(raw, 'kind', '');
  if (!kind.ok) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  if (kind.value !== PCAD_DOCUMENT_KIND) {
    return fail(
      'unsupportedKind',
      `この形式の種類(${kind.value})にはまだ対応していません。`,
    );
  }
  const savedAt = readString(raw, 'savedAt', '');
  if (!savedAt.ok) {
    return failField(savedAt.problem);
  }
  const document = readValue(raw, 'document', '');
  if (!document.ok) {
    return failField(document.problem);
  }
  const decoded = readPartDocument(document.value, 'document');
  if (!decoded.ok) {
    return failField(decoded.problem);
  }
  if (decoded.value.schemaVersion !== schema) {
    return fail(
      'versionMismatch',
      `ファイルの版の記録が食い違っています(封筒 ${String(schema)} / 文書 ${String(decoded.value.schemaVersion)})。`,
    );
  }
  return { ok: true, document: decoded.value, savedAt: savedAt.value };
}

/**
 * `document.json` の中身(すでに JSON.parse 済みのもの)から部品文書を読む。
 * 封筒の `schema` を先に検査してから中身を読む(統括の決定④)。
 */
function decodeFile(raw: unknown): ParseDocumentResult {
  if (!isRecord(raw)) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  const schema = readNumber(raw, 'schema', '');
  if (!schema.ok) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  if (schema.value > PCAD_SCHEMA_VERSION) {
    return fail(
      'unsupportedNewVersion',
      `このファイルは新しい版の PointerCAD で保存されています(版 ${String(schema.value)})。アプリを更新してください。`,
    );
  }
  if (schema.value < PCAD_SCHEMA_VERSION) {
    const lifted = migrateToCurrentSchema(raw, schema.value);
    if (lifted === null) {
      return fail('unsupportedOldVersion', `対応していない古い版です(版 ${String(schema.value)})。`);
    }
    return readEnvelope(lifted, PCAD_SCHEMA_VERSION);
  }
  return readEnvelope(raw, schema.value);
}

/**
 * `.pcad` の `document.json` の中身から部品文書を読む。
 * 壊れていても例外を投げず、日本語の理由を返す(FR-504、NFR-RE-1)。
 */
export function parseDocument(text: string): ParseDocumentResult {
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    return fail(
      'invalidJson',
      'ファイルの中身を読み取れませんでした。PointerCAD のファイルか確かめてください。',
    );
  }
  return decodeFile(parsed.value);
}
