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
  type AppearanceEntry,
  type AppearancePattern,
  type AppearancePresetId,
  type AppearanceSpec,
  type AppearanceTable,
  type AppearanceTarget,
  type BooleanOperation,
  type ChamferSize,
  type ConstraintTarget,
  type CoordinateInput,
  type CopyPlacement,
  // 平面による切断(FR-432、§2.9b、タスク27c)。
  type CutFeature,
  type EdgeCurveKind,
  // P5 の Should 群(§2.11、タスク43)が足した型。
  type ExtrudeEnd,
  type FaceSurfaceKind,
  type FreeArcOrientation,
  type HoleDepth,
  type HoleEntry,
  // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。
  type ImportedSolidFeature,
  type ImportedSource,
  type ImportedSourceFormat,
  type LengthUnit,
  LENGTH_UNITS,
  type MirrorBasis,
  type MirrorPlane,
  type Parameter,
  type ParameterUnit,
  PARAMETER_UNITS,
  type PartDocument,
  type PatternDirection,
  type PatternPlacement,
  type PlaneSpec,
  type OffsetCornerKind,
  type OffsetSide,
  type PointArrayLayout,
  type PointReference,
  type PrimitiveShape,
  type ReferenceAxisDefinition,
  type ReferenceFeature,
  type ReferenceFeatureKind,
  type ReferencePointDefinition,
  type RevolveAxis,
  type RibSide,
  DEFAULT_RULED_SPHERE_SEGMENTS,
  RULED_SPHERE_SEGMENT_CHOICES,
  type RuledSection,
  type RuledSphereSegments,
  type ScaleFactor,
  // 選択セット(FR-112、P6 §0.a-0.44、タスク37)。`SelectionMember` は
  // `AppearanceTarget` そのものなので、読み書きも外観のものを使い回す。
  type SelectionMember,
  type SelectionSet,
  SKETCH_CONSTRAINT_KINDS,
  type SketchArcFeature,
  // 下絵の画像(FR-332、P6 §0.a-0.45、タスク38)。画像そのものは ZIP の別エントリ。
  type SketchCanvas,
  type SketchConstraint,
  type SketchCurveRef,
  type SketchDocument,
  type SketchElementRef,
  type SketchFaceRef,
  type SketchFeature,
  type SketchLineRef,
  type SketchPointRef,
  sketchConstraints,
  type SolidFeature,
  SOLID_FEATURE_KINDS,
  type SolidOrigin,
  type SpringDerived,
  type SpringHandedness,
  type SubShapeFingerprint,
  type SubShapeKind,
  type SubShapeRef,
  type SurfaceOperation,
  type ThicknessSide,
  type ThreadRepresentation,
  type ThreadSeries,
  type Vec3,
  type WoodSpecies,
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
  PCAD_DOCUMENT_KINDS,
  PCAD_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  type PcadDocumentKind,
  type PcadEnvelope,
  type PcadToolDefaults,
} from './schema.js';

/** 判別に使う文字列の一覧。`as` を使わずに型から取り出す。 */
const COORDINATE_MODES: readonly CoordinateInput['mode'][] = ['absolute', 'relative', 'polar'];
const POINT_REFERENCE_KINDS: readonly PointReference['kind'][] = [
  'origin',
  'previous',
  'point',
  'vertex',
  // 立体の部分形状(3D スケッチの点、FR-330。P4 タスク10)。
  'subShape',
  // 球面上の点(FR-431。P5 タスク19)。種類が 1 つ増えるだけなのでスキーマ版は変えない。
  'sphereGrid',
];
type VertexReference = Extract<PointReference, { readonly kind: 'vertex' }>;
const VERTEX_NAMES: readonly VertexReference['vertex'][] = ['start', 'end', 'center'];
/**
 * 拘束が指す先の種類(FR-313、P4b タスク21)。`ConstraintTarget['vertex']` は
 * `PointReference` の同名の欄と同じ3値なので `VERTEX_NAMES` をそのまま使い回す
 * (同じ一覧を2か所に書かない)。
 */
const CONSTRAINT_TARGET_KINDS: readonly ConstraintTarget['kind'][] = ['point', 'vertex', 'curve'];
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
  'offset',
  'copy',
  // 投影・交差(FR-325、P4 タスク25)。曲線そのものは保存せず、立体への参照だけを持つ。
  'projectedCurve',
  'planeSection',
];
/**
 * オフセット(FR-321、P4 タスク15)の側と角。`model` の `OffsetSide` /
 * `OffsetCornerKind` と同じ2値ずつ。
 */
const OFFSET_SIDES: readonly OffsetSide[] = ['outside', 'inside'];
const OFFSET_CORNERS: readonly OffsetCornerKind[] = ['round', 'sharp'];
/**
 * 複製のしかたと鏡の基準(FR-324、P4 タスク20)。`model` の `CopyPlacement['kind']` /
 * `MirrorBasis['kind']` と同じ値ずつ。
 */
const COPY_PLACEMENT_KINDS: readonly CopyPlacement['kind'][] = [
  'mirror',
  'translate',
  'linearArray',
  'circularArray',
];
const MIRROR_BASIS_KINDS: readonly MirrorBasis['kind'][] = ['axis', 'plane'];
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
/*
 * `.pcad` から読める立体の種類(24 種)は `SOLID_FEATURE_KINDS`(`@pointercad/model`)を
 * そのまま使う(P5 仕上げ (h)、`docs/報告記録.md` 2026-09-05 23:08 の t47 指摘③)。
 *
 * 以前はここに io 自前の配列を持っていたが、model の `SolidFeatureKind` に種類を
 * 足しても揃えて直す仕組みが無く、`SolidFeatureKind` と数がずれる余地があった。
 * model 側は `satisfies Record<SolidFeatureKind, true>` で網羅を型検査しているので、
 * それを輸入するここは自前で並べ直さない。知らない種類の `kind` は `readLiteral` が
 * 「その欄の型が違う」として断る(新しい欄の解釈を推測しないため)。
 */
/** 押し出しの終端の4通り(FR-415、P5 タスク43)。 */
const EXTRUDE_END_KINDS: readonly ExtrudeEnd['kind'][] = [
  'distance',
  'symmetric',
  'toFace',
  'toNext',
];
/** 薄板押し出しの厚みの向き(FR-416、§0.a-0.46)。カーネルの `ThinExtrudeSide` と同じ3値。 */
const THICKNESS_SIDES: readonly ThicknessSide[] = ['inner', 'outer', 'both'];
/** 穴の入口の3通り(ざぐり・皿もみ。FR-422、§0.a-0.39)。 */
const HOLE_ENTRY_KINDS: readonly HoleEntry['kind'][] = ['plain', 'counterbore', 'countersink'];
/** ミラーの鏡にする平面の2通り(FR-419、§0.a-0.36)。 */
const MIRROR_PLANE_KINDS: readonly MirrorPlane['kind'][] = ['workPlane', 'face'];
/** 拡大縮小の倍率の2通り(FR-424、§0.a-0.41)。 */
const SCALE_FACTOR_KINDS: readonly ScaleFactor['kind'][] = ['uniform', 'perAxis'];
/** リブの厚みを付ける側(FR-420)。 */
const RIB_SIDES: readonly RibSide[] = ['both', 'positive', 'negative'];
/** 外ねじを切り始める端(FR-423)。 */
const THREAD_SHAFT_ENDS: readonly ('first' | 'last')[] = ['first', 'last'];
/** 曲面の作り方5種(FR-428)。カーネルの `SurfaceInput` と同じ実名(§0.a-0.45)。 */
const SURFACE_OPERATION_KINDS: readonly SurfaceOperation['kind'][] = [
  'extrude',
  'revolve',
  'planar',
  'loft',
  'face',
  // 面のオフセット(P5 タスク42b が kernel へ足した 6 種目。FR-428)。
  'offset',
];
/** 罫線面・ロフトの断面の 3 通り(P5 §2.9.1)。知らない `kind` は `readLiteral` が断る。 */
const RULED_SECTION_KINDS: readonly RuledSection['kind'][] = ['sketchFace', 'solidFace', 'sphere'];
const REVOLVE_AXIS_KINDS: readonly RevolveAxis['kind'][] = ['world', 'line', 'reference'];
type WorldRevolveAxis = Extract<RevolveAxis, { readonly kind: 'world' }>;
const WORLD_AXES: readonly WorldRevolveAxis['axis'][] = ['x', 'y', 'z'];
const BOOLEAN_OPERATIONS: readonly BooleanOperation[] = ['union', 'subtract', 'intersect'];
/**
 * 読み込んだ形の出どころの形式(FR-802、P6 §2.8、タスク20)。
 * 3MF / glTF は読み込みの口がまだ Could(FR-809)だが、**文書の型は最初から 5 通り**
 * (口が開いてから型を広げると版がもう一度上がるため。`ImportedSourceFormat` の注釈)。
 */
const IMPORTED_SOURCE_FORMATS: readonly ImportedSourceFormat[] = [
  'step',
  'stl',
  'obj',
  '3mf',
  'gltf',
];
/**
 * 読み込んだ形の種類(FR-802、P6 §2.8)。**三角形の形はここに入らない**——
 * `'mesh'` は `importedMesh` という別のフィーチャーとして持つ(§0.a-0.24)。
 */
const IMPORTED_BODY_KINDS: readonly ImportedSolidFeature['bodyKind'][] = ['solid', 'shell'];

/**
 * 基本形状(FR-429、P5 計画書 §0.a-0.18、タスク17)の基準点の3通り
 * (座標の式・スケッチの点・立体の頂点)。
 */
const SOLID_ORIGIN_KINDS: readonly SolidOrigin['kind'][] = ['coordinate', 'sketchPoint', 'vertex'];
/** 基本形状5種の判別(球・箱・円柱・円錐・トーラス。FR-429、P5 計画書 §2.7.1、タスク17)。 */
const PRIMITIVE_SHAPE_KINDS: readonly PrimitiveShape['kind'][] = [
  'sphere',
  'box',
  'cylinder',
  'cone',
  'torus',
];

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
const PATTERN_DIRECTION_KINDS: readonly PatternDirection['kind'][] = [
  'world',
  'line',
  'reference',
];
/** 平面の決め方(FR-328。P5 の切断 FR-432 と共有する)。 */
const PLANE_SPEC_KINDS: readonly PlaneSpec['kind'][] = [
  'threePoints',
  'pointAndEdge',
  'pointAndAxis',
  'pointAndParallelFace',
  'face',
  'workPlane',
  'tilted',
];
/** 切断で残す側(FR-432、§0.a-0.57)。法線の側か、その反対。 */
const CUT_KEEP_SIDES: readonly CutFeature['keep'][] = ['positive', 'negative'];
type PointAndEdgeSpec = Extract<PlaneSpec, { readonly kind: 'pointAndEdge' }>;
const POINT_AND_EDGE_MODES: readonly PointAndEdgeSpec['mode'][] = ['perpendicular', 'containing'];
/** 基準ジオメトリの種類(FR-328、FR-329)。 */
const REFERENCE_FEATURE_KINDS: readonly ReferenceFeatureKind[] = [
  'referencePlane',
  'referenceAxis',
  'referencePoint',
  'referenceCoordinateSystem',
];
const REFERENCE_AXIS_KINDS: readonly ReferenceAxisDefinition['kind'][] = [
  'twoPoints',
  'edge',
  'faceNormal',
  'faceIntersection',
];
const REFERENCE_POINT_KINDS: readonly ReferencePointDefinition['kind'][] = [
  'coordinate',
  'vertex',
  'edgeMidpoint',
  'faceCenter',
];
const PATTERN_PLACEMENT_KINDS: readonly PatternPlacement['kind'][] = [
  'linear',
  'circular',
  // 点の集まりへ複製(FR-425、P5 §0.a-0.42、タスク43)。
  'points',
];
const SPRING_DERIVED_VALUES: readonly SpringDerived[] = ['length', 'pitch', 'turns'];
const SPRING_HANDEDNESS_VALUES: readonly SpringHandedness[] = ['right', 'left'];

// ---------------------------------------------------------------------------
// P5(FR-1106〜1110、要件§4.12、タスク5)が足す外観の割り当ての判別の一覧
// ---------------------------------------------------------------------------

/** 外観の割り当て先(§2.2.1)。立体はフィーチャー id、面は部分形状の参照。 */
const APPEARANCE_TARGET_KINDS: readonly AppearanceTarget['kind'][] = ['body', 'face'];
/**
 * 材質プリセットの id(§2.4.1、11 種)。**未来のプリセットが増えたときの前方互換のため**、
 * ここに無い文字列は `readLiteral` のように断らず、その割り当てだけを落として読み進める
 * (`readAppearanceSpec` 参照)。
 */
const APPEARANCE_PRESET_IDS: readonly AppearancePresetId[] = [
  'default',
  'steel',
  'checkerPlate',
  'expandedMetal',
  'aluminum',
  'stainless',
  'plastic',
  'wood',
  'mirror',
  'glass',
  'custom',
];
/** 柄の種類(FR-1108)。未知の種類は前方互換のため割り当てを落とす(プリセット id と同じ理由)。 */
const APPEARANCE_PATTERN_KINDS: readonly AppearancePattern['kind'][] = [
  'none',
  'expandedMetal',
  'checkerPlate',
  'woodGrain',
];
/** 木材の樹種(§0.a-0.5、6 種)。未知の樹種も同じ理由で割り当てを落とす。 */
const WOOD_SPECIES_VALUES: readonly WoodSpecies[] = [
  'hinoki',
  'sugi',
  'oak',
  'walnut',
  'teak',
  'maple',
];

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
    case 'subShape':
      return { kind: 'subShape', ref: serializeSubShapeRef(reference.ref) };
    case 'sphereGrid':
      // 球面上の点(FR-431)。座標は保存せず、球の id と緯度・経度の式だけを書く
      // (導出できるものは保存しない。要件§8)。
      return {
        kind: 'sphereGrid',
        sphereFeatureId: reference.sphereFeatureId,
        latitude: serializeExpression(reference.latitude),
        longitude: serializeExpression(reference.longitude),
      };
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

/** 3D スケッチの円弧の向き(FR-330、P4 タスク10)。中身は 2 つの座標指定。 */
function serializeFreeOrientation(orientation: FreeArcOrientation): FreeArcOrientation {
  return {
    normal: serializeCoordinate(orientation.normal),
    xAxis: serializeCoordinate(orientation.xAxis),
  };
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

/** 鏡の基準(FR-324、タスク20)。線を軸にするか平面かで欄が違うので `kind` で分岐する。 */
function serializeMirrorBasis(basis: MirrorBasis): MirrorBasis {
  switch (basis.kind) {
    case 'axis':
      return { kind: 'axis', axis: serializeElementRef(basis.axis) };
    case 'plane':
      return { kind: 'plane', planeId: basis.planeId };
  }
}

/** 複製のしかた(FR-324、タスク20)。並べ方ごとに欄が違うので `kind` で分岐する。 */
function serializeCopyPlacement(placement: CopyPlacement): CopyPlacement {
  switch (placement.kind) {
    case 'mirror':
      return { kind: 'mirror', basis: serializeMirrorBasis(placement.basis) };
    case 'translate':
      return { kind: 'translate', delta: serializeCoordinate(placement.delta) };
    case 'linearArray':
      return {
        kind: 'linearArray',
        direction: serializeCoordinate(placement.direction),
        spacing: serializeExpression(placement.spacing),
        count: serializeExpression(placement.count),
      };
    case 'circularArray':
      return {
        kind: 'circularArray',
        center: serializeCoordinate(placement.center),
        angle: serializeExpression(placement.angle),
        count: serializeExpression(placement.count),
        fullCircle: placement.fullCircle,
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
    case 'arc': {
      const arc: SketchArcFeature = {
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
      // 3D スケッチの円弧の向き(FR-330、P4 タスク10)。作図面のある円弧は持たないので、
      // そのときは欄そのものを書かない(持たない状態と「空の向き」を混ぜないため)。
      if (feature.freeOrientation === undefined) {
        return arc;
      }
      return { ...arc, freeOrientation: serializeFreeOrientation(feature.freeOrientation) };
    }
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
    case 'offset':
      // ずらした曲線そのものは保存しない(導出できるものは保存しない、rules/04)。
      return {
        id: feature.id,
        kind: 'offset',
        name: feature.name,
        planeId: feature.planeId,
        source: feature.source.map(serializeElementRef),
        distance: serializeExpression(feature.distance),
        side: feature.side,
        corner: feature.corner,
        construction: feature.construction,
      };
    case 'copy':
      // 複製された曲線そのものは保存しない(元の id と複製のしかたから導ける、rules/04)。
      return {
        id: feature.id,
        kind: 'copy',
        name: feature.name,
        planeId: feature.planeId,
        source: feature.source.map(serializeElementRef),
        placement: serializeCopyPlacement(feature.placement),
        construction: feature.construction,
      };
    case 'projectedCurve':
      // 投影された曲線そのものは保存しない(立体と作図面から再計算で導ける、rules/04)。
      return {
        id: feature.id,
        kind: 'projectedCurve',
        name: feature.name,
        planeId: feature.planeId,
        source: serializeSubShapeRef(feature.source),
        construction: feature.construction,
      };
    case 'planeSection':
      return {
        id: feature.id,
        kind: 'planeSection',
        name: feature.name,
        planeId: feature.planeId,
        targetFeatureId: feature.targetFeatureId,
        construction: feature.construction,
      };
  }
}

/**
 * 拘束が指す先(FR-313、P4b タスク21)。`resolveCoordinate.ts` の `vertexKey` /
 * `ResolvedPoint.id` と同じ規約(`constraints/types.ts` の `ConstraintTarget` のコメント参照)。
 */
function serializeConstraintTarget(target: ConstraintTarget): ConstraintTarget {
  switch (target.kind) {
    case 'point':
      return { kind: 'point', pointId: target.pointId };
    case 'vertex':
      return { kind: 'vertex', featureId: target.featureId, vertex: target.vertex };
    case 'curve':
      return { kind: 'curve', element: serializeElementRef(target.element) };
  }
}

/**
 * 拘束1件(FR-313、P4b タスク21)。寸法の目標値(距離・角度・半径・直径)は式のまま保存する
 * (FR-202)。拘束の**解**(座標の上書き)は保存しない(rules/04「導出できるものは保存しない」)。
 */
function serializeConstraint(constraint: SketchConstraint): SketchConstraint {
  const base = { id: constraint.id, name: constraint.name };
  switch (constraint.kind) {
    case 'coincident':
      return {
        ...base,
        kind: 'coincident',
        a: serializeConstraintTarget(constraint.a),
        b: serializeConstraintTarget(constraint.b),
      };
    case 'horizontal':
    case 'vertical':
      return { ...base, kind: constraint.kind, target: serializeConstraintTarget(constraint.target) };
    case 'parallel':
    case 'perpendicular':
    case 'equal':
      return {
        ...base,
        kind: constraint.kind,
        a: serializeConstraintTarget(constraint.a),
        b: serializeConstraintTarget(constraint.b),
      };
    case 'tangent':
      return {
        ...base,
        kind: 'tangent',
        line: serializeConstraintTarget(constraint.line),
        circle: serializeConstraintTarget(constraint.circle),
      };
    case 'concentric':
      return {
        ...base,
        kind: 'concentric',
        a: serializeConstraintTarget(constraint.a),
        b: serializeConstraintTarget(constraint.b),
      };
    case 'symmetric':
      return {
        ...base,
        kind: 'symmetric',
        a: serializeConstraintTarget(constraint.a),
        b: serializeConstraintTarget(constraint.b),
        axis: serializeElementRef(constraint.axis),
      };
    case 'fix':
      return { ...base, kind: 'fix', target: serializeConstraintTarget(constraint.target) };
    case 'distance':
      return {
        ...base,
        kind: 'distance',
        a: serializeConstraintTarget(constraint.a),
        b: serializeConstraintTarget(constraint.b),
        length: serializeExpression(constraint.length),
      };
    case 'angle':
      return {
        ...base,
        kind: 'angle',
        a: serializeConstraintTarget(constraint.a),
        b: serializeConstraintTarget(constraint.b),
        angle: serializeExpression(constraint.angle),
      };
    case 'radius':
    case 'diameter':
      return {
        ...base,
        kind: constraint.kind,
        target: serializeConstraintTarget(constraint.target),
        size: serializeExpression(constraint.size),
      };
  }
}

function serializeSketch(sketch: SketchDocument): SketchDocument {
  const base: SketchDocument = {
    id: sketch.id,
    name: sketch.name,
    features: sketch.features.map(serializeSketchFeature),
  };
  // 拘束(FR-313、P4b タスク21)。**型自体が恒常的に省略可能**(`SketchDocument.constraints?`)
  // なので、`freeOrientation` と同じ約束で「有れば有るまま、無ければ書かない」にする
  // (`references` と違い、無い文書に `[]` を足す正規化はしない。往復が元の文書と
  // deep equal になることを不変条件にするため。統括の決定 2026-09-04)。
  if (sketch.constraints === undefined) {
    return base;
  }
  return { ...base, constraints: sketch.constraints.map(serializeConstraint) };
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
    case 'reference':
      // 基準軸フィーチャーへの参照(FR-329、P4 タスク9)。
      return { kind: 'reference', referenceFeatureId: axis.referenceFeatureId };
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
    case 'reference':
      return { kind: 'reference', referenceFeatureId: direction.referenceFeatureId };
  }
}

/**
 * 押し出しの終端(FR-415、P5 タスク43)。呼び出し側が**省略されていない**ときだけ呼ぶ
 * (既定を書き込むと版 6 までのファイルの往復で欄が増えてしまう)。
 */
function serializeExtrudeEnd(end: ExtrudeEnd): ExtrudeEnd {
  switch (end.kind) {
    case 'distance':
    case 'symmetric':
    case 'toNext':
      // 欄を持たない 3 種。`kind` だけを写す(元の入れ物を持ち回らない)。
      return { kind: end.kind };
    case 'toFace':
      return { kind: 'toFace', face: serializeSubShapeRef(end.face) };
  }
}

/** 穴の入口(ざぐり・皿もみ。FR-422、P5 タスク43)。省略でないときだけ呼ぶ。 */
function serializeHoleEntry(entry: HoleEntry): HoleEntry {
  switch (entry.kind) {
    case 'plain':
      return { kind: 'plain' };
    case 'counterbore':
      return {
        kind: 'counterbore',
        diameter: serializeExpression(entry.diameter),
        depth: serializeExpression(entry.depth),
      };
    case 'countersink':
      return {
        kind: 'countersink',
        diameter: serializeExpression(entry.diameter),
        angle: serializeExpression(entry.angle),
      };
  }
}

/** スケッチの曲線の並びへの参照(P5 タスク43)。id の配列は写して持つ。 */
function serializeCurveRef(reference: SketchCurveRef): SketchCurveRef {
  return { sketchId: reference.sketchId, curveIds: [...reference.curveIds] };
}

/** ミラーの鏡にする平面(FR-419、P5 タスク43)。 */
function serializeMirrorPlane(plane: MirrorPlane): MirrorPlane {
  switch (plane.kind) {
    case 'workPlane':
      return { kind: 'workPlane', planeId: plane.planeId };
    case 'face':
      return { kind: 'face', face: serializeSubShapeRef(plane.face) };
  }
}

/** 拡大縮小の倍率(FR-424、P5 タスク43)。 */
function serializeScaleFactor(factor: ScaleFactor): ScaleFactor {
  switch (factor.kind) {
    case 'uniform':
      return { kind: 'uniform', value: serializeExpression(factor.value) };
    case 'perAxis':
      return {
        kind: 'perAxis',
        x: serializeExpression(factor.x),
        y: serializeExpression(factor.y),
        z: serializeExpression(factor.z),
      };
  }
}

/** 曲面の作り方5種(FR-428、P5 タスク43)。実名はカーネルの `SurfaceInput` と同じ。 */
function serializeSurfaceOperation(operation: SurfaceOperation): SurfaceOperation {
  switch (operation.kind) {
    case 'extrude':
      return {
        kind: 'extrude',
        profile: serializeCurveRef(operation.profile),
        distance: serializeExpression(operation.distance),
        reversed: operation.reversed,
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: serializeCurveRef(operation.profile),
        axis: serializeRevolveAxis(operation.axis),
        angle: serializeExpression(operation.angle),
        reversed: operation.reversed,
      };
    case 'planar':
      return { kind: 'planar', profile: serializeCurveRef(operation.profile) };
    case 'loft':
      return {
        kind: 'loft',
        sections: operation.sections.map(serializeCurveRef),
        ruled: operation.ruled,
      };
    case 'face':
      return {
        kind: 'face',
        targetFeatureId: operation.targetFeatureId,
        face: serializeSubShapeRef(operation.face),
      };
    case 'offset':
      // 面のオフセット(FR-428 の 6 種目、P5 タスク42b・46)。面と距離を書く。
      return {
        kind: 'offset',
        targetFeatureId: operation.targetFeatureId,
        face: serializeSubShapeRef(operation.face),
        distance: serializeExpression(operation.distance),
      };
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
    case 'points':
      // 点の集まりへ複製(FR-425、P5 タスク43)。個数・間隔の欄は無く、点の並びだけ。
      return { kind: 'points', points: placement.points.map(serializePointReference) };
  }
}

/**
 * 基本形状の基準点(FR-429、P5 計画書 §2.7.1、タスク17)。3通りで欄が違うので
 * `kind` で分岐する。`vertex` の指紋は `serializeSubShapeRef` をそのまま使い回す
 * (P3 の加工フィーチャーと同じ形)。
 */
function serializeSolidOrigin(origin: SolidOrigin): SolidOrigin {
  switch (origin.kind) {
    case 'coordinate':
      return { kind: 'coordinate', value: serializeCoordinate(origin.value) };
    case 'sketchPoint':
      return { kind: 'sketchPoint', ref: serializePointRef(origin.ref) };
    case 'vertex':
      return { kind: 'vertex', ref: serializeSubShapeRef(origin.ref) };
  }
}

/**
 * 基本形状の寸法(FR-429、P5 計画書 §2.7.1、タスク17)。種類ごとに欄が違うので
 * `kind` で分岐する。寸法は式のまま保存する(FR-202)。
 */
function serializePrimitiveShape(shape: PrimitiveShape): PrimitiveShape {
  switch (shape.kind) {
    case 'sphere':
      return { kind: 'sphere', radius: serializeExpression(shape.radius) };
    case 'box':
      return {
        kind: 'box',
        sizeX: serializeExpression(shape.sizeX),
        sizeY: serializeExpression(shape.sizeY),
        sizeZ: serializeExpression(shape.sizeZ),
      };
    case 'cylinder':
      return {
        kind: 'cylinder',
        radius: serializeExpression(shape.radius),
        height: serializeExpression(shape.height),
      };
    case 'cone':
      return {
        kind: 'cone',
        bottomRadius: serializeExpression(shape.bottomRadius),
        topRadius: serializeExpression(shape.topRadius),
        height: serializeExpression(shape.height),
      };
    case 'torus':
      return {
        kind: 'torus',
        majorRadius: serializeExpression(shape.majorRadius),
        minorRadius: serializeExpression(shape.minorRadius),
      };
  }
}

/**
 * 罫線面・ロフトの断面 1 つ(FR-430、FR-410、P5 計画書 §2.9.1、タスク25)。
 * 参照は id と指紋のまま保存し、輪郭の座標は保存しない(導出物、rules/04)。
 */
function serializeRuledSection(section: RuledSection): RuledSection {
  switch (section.kind) {
    case 'sketchFace':
      return { kind: 'sketchFace', ref: serializeFaceRef(section.ref) };
    case 'solidFace':
      return { kind: 'solidFace', ref: serializeSubShapeRef(section.ref) };
    case 'sphere':
      return { kind: 'sphere', sphereFeatureId: section.sphereFeatureId };
  }
}

/**
 * 読み込んだ形の素性(FR-802、P6 §2.8、タスク20)を書き出す。
 *
 * **`importedAt` は省略できる欄**なので、無ければ欄ごと出さない(押し出しの `end`・
 * 穴の `entry` と同じ流儀。版 7 のファイルを往復しても欄が 1 つも増えない)。
 * 形そのもの(B-rep / 三角形)はここに 1 バイトも入らない——ZIP の別エントリ
 * (`shapes/<shapeRef>.brep` / `meshes/<meshRef>.bin`)にあり、その出し入れはタスク21 の担当。
 */
function serializeImportedSource(source: ImportedSource): ImportedSource {
  return {
    format: source.format,
    fileName: source.fileName,
    unit: source.unit,
    byteLength: source.byteLength,
    ...(source.importedAt === undefined ? {} : { importedAt: source.importedAt }),
  };
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
        /*
          終端・傾き・薄板(FR-415、FR-401、FR-416。P5 タスク43)。**省略は欄ごと省略のまま**
          にするので、版 6 までのファイルは往復しても欄が 1 つも増えない。
        */
        ...(feature.end === undefined ? {} : { end: serializeExtrudeEnd(feature.end) }),
        ...(feature.taperAngle === undefined
          ? {}
          : { taperAngle: serializeExpression(feature.taperAngle) }),
        ...(feature.taperOutward === undefined ? {} : { taperOutward: feature.taperOutward }),
        ...(feature.thickness === undefined
          ? {}
          : {
              thickness:
                feature.thickness === null ? null : serializeExpression(feature.thickness),
            }),
        ...(feature.thicknessSide === undefined ? {} : { thicknessSide: feature.thicknessSide }),
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
        // 入口(ざぐり・皿もみ。FR-422、P5 タスク43)。省略は欄ごと省略のまま。
        ...(feature.entry === undefined ? {} : { entry: serializeHoleEntry(feature.entry) }),
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
        ...(feature.entry === undefined ? {} : { entry: serializeHoleEntry(feature.entry) }),
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
        // 可変半径(FR-426、P5 タスク46)。**一定半径のときは欄そのものを書かない**ので、
        // 版 4 以前・版 5 前半のファイルと 1 バイトも変わらない(押し出しの `end` と同じ決め)。
        ...(feature.radiusEnd === undefined || feature.radiusEnd === null
          ? {}
          : { radiusEnd: serializeExpression(feature.radiusEnd) }),
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
    case 'primitive':
      // 基本形状(FR-429、P5 計画書 §2.7.1、タスク17)。対象を消費しない「作る」
      // フィーチャーなので、押し出し・ばねと同じく欄をそのまま組み立てる。
      return {
        id: feature.id,
        kind: 'primitive',
        name: feature.name,
        suppressed: feature.suppressed,
        origin: serializeSolidOrigin(feature.origin),
        axis: serializeRevolveAxis(feature.axis),
        shape: serializePrimitiveShape(feature.shape),
      };
    case 'ruled':
      // 面をつなぐ(FR-430、P5 §2.9.1、タスク25)。断面 2 つ+ねじれ+球の点の数。
      return {
        id: feature.id,
        kind: 'ruled',
        name: feature.name,
        suppressed: feature.suppressed,
        first: serializeRuledSection(feature.first),
        second: serializeRuledSection(feature.second),
        twist: serializeExpression(feature.twist),
        sphereSegments: feature.sphereSegments,
      };
    case 'loft':
      // ロフト(FR-410)。断面は 2 つ以上で、球を置けないので点の数の欄は持たない。
      return {
        id: feature.id,
        kind: 'loft',
        name: feature.name,
        suppressed: feature.suppressed,
        sections: feature.sections.map(serializeRuledSection),
        twist: serializeExpression(feature.twist),
      };
    /*
      P5 の Should 群 9 種(§2.11、タスク43)。**参照は id と指紋のまま、寸法は式のまま**
      書き出す(座標・ラジアン・解決した形は 1 つも保存しない。要件§8、rules/04)。
    */
    case 'draft':
      return {
        id: feature.id,
        kind: 'draft',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        faces: feature.faces.map(serializeSubShapeRef),
        neutralFace: serializeSubShapeRef(feature.neutralFace),
        angle: serializeExpression(feature.angle),
        reversed: feature.reversed,
      };
    case 'mirror':
      return {
        id: feature.id,
        kind: 'mirror',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        plane: serializeMirrorPlane(feature.plane),
      };
    case 'transform':
      return {
        id: feature.id,
        kind: 'transform',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        translation: [
          serializeExpression(feature.translation[0]),
          serializeExpression(feature.translation[1]),
          serializeExpression(feature.translation[2]),
        ],
        rotationAxis:
          feature.rotationAxis === null ? null : serializeRevolveAxis(feature.rotationAxis),
        rotationAngle: serializeExpression(feature.rotationAngle),
      };
    case 'scale':
      return {
        id: feature.id,
        kind: 'scale',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        origin: serializePointReference(feature.origin),
        factor: serializeScaleFactor(feature.factor),
      };
    case 'sweep':
      return {
        id: feature.id,
        kind: 'sweep',
        name: feature.name,
        suppressed: feature.suppressed,
        profile: serializeFaceRef(feature.profile),
        path: serializeCurveRef(feature.path),
        frenet: feature.frenet,
      };
    case 'rib':
      return {
        id: feature.id,
        kind: 'rib',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        profile: serializeCurveRef(feature.profile),
        thickness: serializeExpression(feature.thickness),
        side: feature.side,
        extendToBody: feature.extendToBody,
      };
    case 'emboss':
      return {
        id: feature.id,
        kind: 'emboss',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        face: serializeSubShapeRef(feature.face),
        profile: serializeFaceRef(feature.profile),
        height: serializeExpression(feature.height),
        raised: feature.raised,
      };
    case 'threadShaft':
      return {
        id: feature.id,
        kind: 'threadShaft',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        face: serializeSubShapeRef(feature.face),
        nominal: feature.nominal,
        series: feature.series,
        pitch: serializeExpression(feature.pitch),
        length: serializeExpression(feature.length),
        fromEnd: feature.fromEnd,
        modeled: feature.modeled,
      };
    case 'surface':
      return {
        id: feature.id,
        kind: 'surface',
        name: feature.name,
        suppressed: feature.suppressed,
        operation: serializeSurfaceOperation(feature.operation),
      };
    case 'shell':
      // くり抜き(FR-418、§2.12、P5 タスク46)。開ける面は 0 枚でもよい。
      return {
        id: feature.id,
        kind: 'shell',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        openFaces: feature.openFaces.map(serializeSubShapeRef),
        thickness: serializeExpression(feature.thickness),
        outward: feature.outward,
      };
    case 'cut':
      // 平面による切断(FR-432、§2.9b、タスク27c)。切断面は任意の作業平面(FR-328)と
      // 同じ `serializePlaneSpec` を通す(読み書きを 2 か所に書かない)。
      // `pairedWith` は単独なら null をそのまま書き出す(欄ごと省略しない。
      // 「対の相手がいない」ことを読む側が判定に使うため)。
      return {
        id: feature.id,
        kind: 'cut',
        name: feature.name,
        suppressed: feature.suppressed,
        targetFeatureId: feature.targetFeatureId,
        plane: serializePlaneSpec(feature.plane),
        keep: feature.keep,
        pairedWith: feature.pairedWith,
      };
    case 'importedSolid':
      /*
        読み込んだ形(FR-802、P6 §2.8、§0.a-0.9)。**`document.json` に入るのは
        「入れ物の名前」と素性だけ**で、B-rep のバイト列は ZIP の別エントリになる
        (`shapes/<shapeRef>.brep`。エントリの出し入れはタスク21 の担当)。
      */
      return {
        id: feature.id,
        kind: 'importedSolid',
        name: feature.name,
        suppressed: feature.suppressed,
        shapeRef: feature.shapeRef,
        source: serializeImportedSource(feature.source),
        bodyKind: feature.bodyKind,
      };
    case 'importedMesh':
      // 読み込んだ三角形の形(FR-802、P6 §2.8、§0.a-0.24)。三角形は
      // `meshes/<meshRef>.bin` にある。`volume` は省略できる欄なので、無ければ出さない。
      return {
        id: feature.id,
        kind: 'importedMesh',
        name: feature.name,
        suppressed: feature.suppressed,
        meshRef: feature.meshRef,
        source: serializeImportedSource(feature.source),
        triangleCount: feature.triangleCount,
        ...(feature.volume === undefined ? {} : { volume: feature.volume }),
      };
  }
}

// ---------------------------------------------------------------------------
// P4(FR-328、FR-329、タスク9)が足す平面の指定と基準ジオメトリの書き出し
// ---------------------------------------------------------------------------

/** 平面の決め方(FR-328)。P5 の切断(FR-432)も同じ型を読み書きする。 */
function serializePlaneSpec(spec: PlaneSpec): PlaneSpec {
  switch (spec.kind) {
    case 'threePoints':
      return {
        kind: 'threePoints',
        p1: serializePointReference(spec.p1),
        p2: serializePointReference(spec.p2),
        p3: serializePointReference(spec.p3),
      };
    case 'pointAndEdge':
      return {
        kind: 'pointAndEdge',
        point: serializePointReference(spec.point),
        edge: serializeSubShapeRef(spec.edge),
        mode: spec.mode,
      };
    case 'pointAndAxis':
      return {
        kind: 'pointAndAxis',
        point: serializePointReference(spec.point),
        axis: serializeRevolveAxis(spec.axis),
        tilt: serializeExpression(spec.tilt),
        azimuth: serializeExpression(spec.azimuth),
      };
    case 'pointAndParallelFace':
      return {
        kind: 'pointAndParallelFace',
        point: serializePointReference(spec.point),
        face: serializeSubShapeRef(spec.face),
      };
    case 'face':
      return {
        kind: 'face',
        face: serializeSubShapeRef(spec.face),
        offset: serializeExpression(spec.offset),
      };
    case 'workPlane':
      return {
        kind: 'workPlane',
        planeId: spec.planeId,
        offset: serializeExpression(spec.offset),
      };
    case 'tilted':
      return {
        kind: 'tilted',
        base: spec.base,
        axis: serializeRevolveAxis(spec.axis),
        angle: serializeExpression(spec.angle),
      };
  }
}

/** 基準軸の決め方(FR-329)。 */
function serializeReferenceAxisDefinition(
  definition: ReferenceAxisDefinition,
): ReferenceAxisDefinition {
  switch (definition.kind) {
    case 'twoPoints':
      return {
        kind: 'twoPoints',
        from: serializePointReference(definition.from),
        to: serializePointReference(definition.to),
      };
    case 'edge':
      return { kind: 'edge', edge: serializeSubShapeRef(definition.edge) };
    case 'faceNormal':
      return { kind: 'faceNormal', face: serializeSubShapeRef(definition.face) };
    case 'faceIntersection':
      return {
        kind: 'faceIntersection',
        face1: serializeSubShapeRef(definition.face1),
        face2: serializeSubShapeRef(definition.face2),
      };
  }
}

/** 基準点の決め方(FR-329)。 */
function serializeReferencePointDefinition(
  definition: ReferencePointDefinition,
): ReferencePointDefinition {
  switch (definition.kind) {
    case 'coordinate':
      return { kind: 'coordinate', at: serializeCoordinate(definition.at) };
    case 'vertex':
      return { kind: 'vertex', vertex: serializeSubShapeRef(definition.vertex) };
    case 'edgeMidpoint':
      return { kind: 'edgeMidpoint', edge: serializeSubShapeRef(definition.edge) };
    case 'faceCenter':
      return { kind: 'faceCenter', face: serializeSubShapeRef(definition.face) };
  }
}

/** 基準ジオメトリ 1 つ(作業平面・基準軸・基準点・座標系。FR-328、FR-329)。 */
function serializeReferenceFeature(feature: ReferenceFeature): ReferenceFeature {
  switch (feature.kind) {
    case 'referencePlane':
      return {
        kind: 'referencePlane',
        id: feature.id,
        name: feature.name,
        visible: feature.visible,
        plane: serializePlaneSpec(feature.plane),
      };
    case 'referenceAxis':
      return {
        kind: 'referenceAxis',
        id: feature.id,
        name: feature.name,
        visible: feature.visible,
        definition: serializeReferenceAxisDefinition(feature.definition),
      };
    case 'referencePoint':
      return {
        kind: 'referencePoint',
        id: feature.id,
        name: feature.name,
        visible: feature.visible,
        definition: serializeReferencePointDefinition(feature.definition),
      };
    case 'referenceCoordinateSystem':
      return {
        kind: 'referenceCoordinateSystem',
        id: feature.id,
        name: feature.name,
        visible: feature.visible,
        origin: serializePointReference(feature.origin),
        xAxis: serializeRevolveAxis(feature.xAxis),
        yAxis: serializeRevolveAxis(feature.yAxis),
      };
  }
}

/**
 * パラメータ表の1行(FR-207、P4b タスク2・タスク21)。欄を決まった順で組み立てて決定性を保つ。
 * 並び順(利用者が並べ替えた順)は呼び出し側の `document.parameters.map` がそのまま保つ
 * (§2.6「表の並び順を評価順で上書きしない」)。
 */
function serializeParameter(parameter: Parameter): Parameter {
  return {
    name: parameter.name,
    value: serializeExpression(parameter.value),
    unit: parameter.unit,
    description: parameter.description,
  };
}

/** 柄(FR-1108)。繰り返しの間隔は式のまま保存する(FR-202)。 */
function serializeAppearancePattern(pattern: AppearancePattern): AppearancePattern {
  switch (pattern.kind) {
    case 'none':
      return { kind: 'none' };
    case 'expandedMetal':
      return { kind: 'expandedMetal', spacing: serializeExpression(pattern.spacing) };
    case 'checkerPlate':
      return { kind: 'checkerPlate', spacing: serializeExpression(pattern.spacing) };
    case 'woodGrain':
      return {
        kind: 'woodGrain',
        spacing: serializeExpression(pattern.spacing),
        species: pattern.species,
      };
  }
}

/** 見た目そのもの(FR-1107、FR-1109)。透過率・光沢・粗さは式のまま保存する(FR-202)。 */
function serializeAppearanceSpec(spec: AppearanceSpec): AppearanceSpec {
  return {
    preset: spec.preset,
    color: spec.color,
    transmission: serializeExpression(spec.transmission),
    gloss: serializeExpression(spec.gloss),
    roughness: serializeExpression(spec.roughness),
    pattern: serializeAppearancePattern(spec.pattern),
  };
}

/** 外観の割り当て先(FR-1106)。面は部分形状の参照(P3 の `serializeSubShapeRef` を使い回す)。 */
function serializeAppearanceTarget(target: AppearanceTarget): AppearanceTarget {
  switch (target.kind) {
    case 'body':
      return { kind: 'body', bodyFeatureId: target.bodyFeatureId };
    case 'face':
      return { kind: 'face', ref: serializeSubShapeRef(target.ref) };
  }
}

function serializeAppearanceEntry(entry: AppearanceEntry): AppearanceEntry {
  return {
    id: entry.id,
    target: serializeAppearanceTarget(entry.target),
    appearance: serializeAppearanceSpec(entry.appearance),
  };
}

/** 外観の割り当て表(FR-1106〜1110、版6、P5 タスク5)。 */
function serializeAppearanceTable(table: AppearanceTable): AppearanceTable {
  return { entries: table.entries.map(serializeAppearanceEntry) };
}

/**
 * 選択セット 1 つ(FR-112、版7、P6 タスク37)。
 *
 * 要素(`SelectionMember`)は **`AppearanceTarget` そのもの**(model の §0.a-0.44)なので、
 * 書き出しも外観の `serializeAppearanceTarget` をそのまま使う(同じ形に 2 通りの
 * 書き方を作らない)。
 */
function serializeSelectionSet(set: SelectionSet): SelectionSet {
  return {
    id: set.id,
    name: set.name,
    members: set.members.map(serializeAppearanceTarget),
  };
}

/**
 * 下絵 1 枚(FR-332、版7、P6 タスク38)。
 *
 * **画像のバイト列はここに 1 バイトも書かない。** `imageId` が `.pcad` の ZIP のエントリ
 * (`canvases/<imageId>.png`、`pcadFile.ts`)を指すだけで、`document.json` には id と
 * 寸法しか入れない(読み込んだ B-rep・三角形と同じ流儀。§2.8)。
 */
function serializeSketchCanvas(canvas: SketchCanvas): SketchCanvas {
  return {
    id: canvas.id,
    name: canvas.name,
    plane: canvas.plane,
    imageId: canvas.imageId,
    width: serializeExpression(canvas.width),
    height: serializeExpression(canvas.height),
    origin: serializeCoordinate(canvas.origin),
    rotation: serializeExpression(canvas.rotation),
    opacity: serializeExpression(canvas.opacity),
    visible: canvas.visible,
  };
}

function serializePartDocument(document: PartDocument): PartDocument {
  return {
    id: document.id,
    name: document.name,
    schemaVersion: document.schemaVersion,
    sketches: document.sketches.map(serializeSketch),
    activeSketchId: document.activeSketchId,
    references: document.references.map(serializeReferenceFeature),
    solids: document.solids.map(serializeSolidFeature),
    parameters: document.parameters.map(serializeParameter),
    appearance: serializeAppearanceTable(document.appearance),
    // 版7 で足した 2 欄(P6 §0.a-0.44・0.45)。**外観の後ろに置く**ことで、版6 までの
    // ファイルの並び(id → … → appearance)が 1 行も動かない。
    selectionSets: document.selectionSets.map(serializeSelectionSet),
    canvases: document.canvases.map(serializeSketchCanvas),
  };
}

export interface SerializeOptions {
  /** 保存時刻(ISO 8601)。検査で時刻を固定するための口。既定は今の時刻。 */
  readonly savedAt?: string;
  /**
   * 封筒に書く種別(§0.a-0.35)。既定は部品(`PCAD_DOCUMENT_KIND`)で、
   * ひな形(`.pcadt`)として書き出すときだけ `PCAD_TEMPLATE_KIND` を渡す。
   * 中身(部品文書)の作りは種別で 1 文字も変わらない(履歴を空にするのは上の層の仕事)。
   */
  readonly kind?: PcadDocumentKind;
  /**
   * 表示の長さの単位(FR-814、§2.10)。**ひな形のときだけ渡す。**
   * 渡さなければ封筒にこの欄そのものが出ない(部品の `.pcad` のバイト列は
   * タスク27 の前後で 1 バイトも変わらない)。
   */
  readonly lengthUnit?: LengthUnit;
  /** 各道具の既定値(FR-814、§2.10)。`lengthUnit` と同じく、ひな形のときだけ渡す。 */
  readonly toolDefaults?: PcadToolDefaults;
}

/**
 * 道具の既定値を封筒へ書く形にする(FR-814、§2.10)。
 *
 * 他の `serialize*` と同じく**欄を 1 つずつ決まった順で書き写す**。渡された
 * オブジェクトをそのまま入れないのは、①欄の順が呼び出し側の作り方に左右されると
 * 同じ中身から同じバイト列ができなくなる(`pcadFile.ts` 冒頭の約束)、
 * ②知らない欄が紛れ込んでも保存されない、の 2 つによる。
 */
function serializeToolDefaults(toolDefaults: PcadToolDefaults): PcadToolDefaults {
  return {
    extrudeDistance: toolDefaults.extrudeDistance,
    holeDiameter: toolDefaults.holeDiameter,
    filletRadius: toolDefaults.filletRadius,
    chamferDistance: toolDefaults.chamferDistance,
    circleRadius: toolDefaults.circleRadius,
  };
}

/**
 * 部品文書を `.pcad` の `document.json` の中身へ書き出す(UTF-8、インデント 2、末尾に改行 1 つ)。
 * 同じ文書からは必ず同じ文字列ができる(欄を決まった順で組み立てるため)。
 */
export function serializeDocument(document: PartDocument, options: SerializeOptions = {}): string {
  const envelope: PcadEnvelope = {
    // 封筒の版は文書の版と同じ値を書く(統括の決定④)。
    schema: document.schemaVersion,
    // 既定は部品(要件§8)。ひな形のときだけ呼び出し側が種別を渡す(§0.a-0.35)。
    kind: options.kind ?? PCAD_DOCUMENT_KIND,
    app: PCAD_APP_NAME,
    savedAt: options.savedAt ?? new Date().toISOString(),
    /*
      ひな形の 2 欄(FR-814、§2.10)。**渡されなければ `undefined` のままにする。**
      `JSON.stringify` は値が `undefined` の欄を書かないので、部品の `.pcad` の
      バイト列はタスク27 の前後で 1 バイトも変わらない(既存の検査がそれを固定している)。
      場所を `savedAt` と `document` の間にしてあるのは、封筒の欄(小さい設定)を
      先に、中身(大きい文書)を最後に置く並びを崩さないためである。
    */
    lengthUnit: options.lengthUnit,
    toolDefaults:
      options.toolDefaults === undefined ? undefined : serializeToolDefaults(options.toolDefaults),
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
  return readPointReferenceRecord(record.value, joinPath(parentPath, key));
}

/**
 * 点の指定を値そのものから読む(一覧の 1 件用。P5 タスク43 の点集合パターンが使う)。
 * `readFaceRef` / `readFaceRefItem` と同じ「欄用と値用の組」の流儀
 * (`readPlaneSpecRecord` と同じく、中身の読み方は 1 か所にだけ置く)。
 */
function readPointReferenceItem(value: unknown, path: string): Checked<PointReference> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  return readPointReferenceRecord(record.value, path);
}

function readPointReferenceRecord(
  record: Record<string, unknown>,
  path: string,
): Checked<PointReference> {
  const kind = readLiteral(record, 'kind', path, POINT_REFERENCE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'origin':
      return { ok: true, value: { kind: 'origin' } };
    case 'previous':
      return { ok: true, value: { kind: 'previous' } };
    case 'point': {
      const pointId = readString(record, 'pointId', path);
      if (!pointId.ok) {
        return pointId;
      }
      return { ok: true, value: { kind: 'point', pointId: pointId.value } };
    }
    case 'vertex': {
      const featureId = readString(record, 'featureId', path);
      if (!featureId.ok) {
        return featureId;
      }
      const vertex = readLiteral(record, 'vertex', path, VERTEX_NAMES);
      if (!vertex.ok) {
        return vertex;
      }
      return {
        ok: true,
        value: { kind: 'vertex', featureId: featureId.value, vertex: vertex.value },
      };
    }
    case 'subShape': {
      // 立体の部分形状(3D スケッチの点、FR-330。P4 タスク10)。
      const ref = readSubShapeRefField(record, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'subShape', ref: ref.value } };
    }
    case 'sphereGrid': {
      // 球面上の点(FR-431。P5 タスク19)。球の id と緯度・経度の式だけを読む。
      const sphereFeatureId = readString(record, 'sphereFeatureId', path);
      if (!sphereFeatureId.ok) {
        return sphereFeatureId;
      }
      const latitude = readExpression(record, 'latitude', path);
      if (!latitude.ok) {
        return latitude;
      }
      const longitude = readExpression(record, 'longitude', path);
      if (!longitude.ok) {
        return longitude;
      }
      return {
        ok: true,
        value: {
          kind: 'sphereGrid',
          sphereFeatureId: sphereFeatureId.value,
          latitude: latitude.value,
          longitude: longitude.value,
        },
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
  // 作図面は基準の 3 面(xy / xz / yz)か、任意の作業平面フィーチャーの id(FR-328、
  // P4 タスク9)。決まった 3 つに限れなくなったので、空でない文字列であることだけを見る。
  const planeId = readString(record, 'planeId', path);
  if (!planeId.ok) {
    return planeId;
  }
  if (planeId.value === '') {
    return fieldProblem(joinPath(path, 'planeId'), 'type');
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
    case 'offset':
      return readOffsetFeature(record.value, path, base.value);
    case 'copy':
      return readCopyFeature(record.value, path, base.value);
    case 'projectedCurve':
      return readProjectedCurveFeature(record.value, path, base.value);
    case 'planeSection':
      return readPlaneSectionFeature(record.value, path, base.value);
  }
}

/**
 * 構築線(FR-320)の欄。**版4からは必須**(欠けていれば `missingField`)。
 * 版3以前(スキーマ版は上げなかった、統括の差し戻し 2026-09-04)はこの欄を持たない
 * ファイルもあったが、その寛容さは P4 タスク31(§0.a-0.24)で
 * `schema.ts` の `SCHEMA_MIGRATIONS[3]`(版3→4の移行)へ移した。移行済みの版4データは
 * 必ずこの欄を持つので、ここでは寛容に読まない。書き手(`serializeSketchFeature`)は
 * 常にこの欄を書く。
 */
function readConstructionFlag(record: Record<string, unknown>, path: string): Checked<boolean> {
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

/**
 * 3D スケッチの円弧の向き(FR-330、P4 タスク10)の欄。
 *
 * **作図面の上の円弧はこの欄を持たない**(版に関係なく恒常的に省略可能。書き手も
 * `feature.freeOrientation === undefined` のときは書かない)。`construction`・点列の
 * `layout`・`references` と違い、これは「版3以前だけの寛容さ」ではないので、
 * P4 タスク31(§0.a-0.24)の版4厳密化・`SCHEMA_MIGRATIONS[3]` の対象にしない
 * (版4でもこのまま無ければ null を返す)。
 * 欄があるのに中身が読めない場合はファイル全体を断る(このファイル冒頭の決めごと)。
 */
function readFreeOrientation(
  record: Record<string, unknown>,
  path: string,
): Checked<FreeArcOrientation | null> {
  if (!('freeOrientation' in record)) {
    return { ok: true, value: null };
  }
  const found = readRecord(record, 'freeOrientation', path);
  if (!found.ok) {
    return found;
  }
  const orientationPath = joinPath(path, 'freeOrientation');
  const normal = readCoordinate(found.value, 'normal', orientationPath);
  if (!normal.ok) {
    return normal;
  }
  const xAxis = readCoordinate(found.value, 'xAxis', orientationPath);
  if (!xAxis.ok) {
    return xAxis;
  }
  return { ok: true, value: { normal: normal.value, xAxis: xAxis.value } };
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
  const freeOrientation = readFreeOrientation(record, path);
  if (!freeOrientation.ok) {
    return freeOrientation;
  }
  const arc: SketchArcFeature = {
    ...base,
    kind: 'arc',
    center: center.value,
    radius: radius.value,
    startAngle: startAngle.value,
    endAngle: endAngle.value,
    construction: construction.value,
  };
  if (freeOrientation.value === null) {
    return { ok: true, value: arc };
  }
  return { ok: true, value: { ...arc, freeOrientation: freeOrientation.value } };
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
 * 点列(FR-308、FR-327)。**版4からは `layout` が必須**(欠けていれば `missingField`)。
 * 版3以前(スキーマ版は上げなかった、統括の差し戻し 2026-09-04)は `layout` を挟まず
 * `base`/`azimuth`/`spacing`/`count` を直下に持つフラットな形もあったが、その寛容さは
 * P4 タスク31(§0.a-0.24)で `schema.ts` の `SCHEMA_MIGRATIONS[3]` へ移した
 * (直線状 `kind: 'linear'` の `layout` へ包み直す変換)。書き手は常に `layout` を書く。
 */
function readPointArrayFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
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

/**
 * オフセット(FR-321、P4 タスク15)を読む。
 * ずらした後の曲線は保存されていない(再計算で導く)ので、読むのは元の要素・距離・
 * 側・角だけ。距離の符号は使わず、どちら側かは `side` が持つ。
 */
function readOffsetFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const source = readList(record, 'source', path, readElementRef);
  if (!source.ok) {
    return source;
  }
  const distance = readExpression(record, 'distance', path);
  if (!distance.ok) {
    return distance;
  }
  const side = readLiteral(record, 'side', path, OFFSET_SIDES);
  if (!side.ok) {
    return side;
  }
  const corner = readLiteral(record, 'corner', path, OFFSET_CORNERS);
  if (!corner.ok) {
    return corner;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'offset',
      source: source.value,
      distance: distance.value,
      side: side.value,
      corner: corner.value,
      construction: construction.value,
    },
  };
}

/** 鏡の基準(FR-324、タスク20)。`kind` で線を軸にするか平面かを見分けてから欄を読む。 */
function readMirrorBasis(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<MirrorBasis> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, MIRROR_BASIS_KINDS);
  if (!kind.ok) {
    return kind;
  }
  if (kind.value === 'plane') {
    const planeId = readString(record.value, 'planeId', path);
    if (!planeId.ok) {
      return planeId;
    }
    return { ok: true, value: { kind: 'plane', planeId: planeId.value } };
  }
  const axis = readRecord(record.value, 'axis', path);
  if (!axis.ok) {
    return axis;
  }
  const reference = readElementRef(axis.value, joinPath(path, 'axis'));
  if (!reference.ok) {
    return reference;
  }
  return { ok: true, value: { kind: 'axis', axis: reference.value } };
}

/**
 * 複製のしかた(FR-324、タスク20)。`kind` で並べ方を見分けてから種類ごとの欄を読む
 * (点列の `layout` と同じ書き方)。
 */
function readCopyPlacement(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<CopyPlacement> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, COPY_PLACEMENT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'mirror': {
      const basis = readMirrorBasis(record.value, 'basis', path);
      if (!basis.ok) {
        return basis;
      }
      return { ok: true, value: { kind: 'mirror', basis: basis.value } };
    }
    case 'translate': {
      const delta = readCoordinate(record.value, 'delta', path);
      if (!delta.ok) {
        return delta;
      }
      return { ok: true, value: { kind: 'translate', delta: delta.value } };
    }
    case 'linearArray':
      return readLinearArrayPlacement(record.value, path);
    case 'circularArray':
      return readCircularArrayPlacement(record.value, path);
  }
}

function readLinearArrayPlacement(
  record: Record<string, unknown>,
  path: string,
): Checked<CopyPlacement> {
  const direction = readCoordinate(record, 'direction', path);
  if (!direction.ok) {
    return direction;
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
      kind: 'linearArray',
      direction: direction.value,
      spacing: spacing.value,
      count: count.value,
    },
  };
}

function readCircularArrayPlacement(
  record: Record<string, unknown>,
  path: string,
): Checked<CopyPlacement> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const angle = readExpression(record, 'angle', path);
  if (!angle.ok) {
    return angle;
  }
  const count = readExpression(record, 'count', path);
  if (!count.ok) {
    return count;
  }
  const fullCircle = readBoolean(record, 'fullCircle', path);
  if (!fullCircle.ok) {
    return fullCircle;
  }
  return {
    ok: true,
    value: {
      kind: 'circularArray',
      center: center.value,
      angle: angle.value,
      count: count.value,
      fullCircle: fullCircle.value,
    },
  };
}

/**
 * ミラー・複写・配列複写(FR-324、P4 タスク20)を読む。
 * 複製された曲線は保存されていない(再計算で導く)ので、読むのは元の要素と複製のしかただけ。
 */
function readCopyFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const source = readList(record, 'source', path, readElementRef);
  if (!source.ok) {
    return source;
  }
  const placement = readCopyPlacement(record, 'placement', path);
  if (!placement.ok) {
    return placement;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'copy',
      source: source.value,
      placement: placement.value,
      construction: construction.value,
    },
  };
}

/**
 * 投影(FR-325、P4 タスク25)を読む。
 * 投影された曲線は保存されていない(立体と作図面から再計算で導く)ので、
 * 読むのは投影元の面・辺への参照だけ。
 */
function readProjectedCurveFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const source = readSubShapeRefField(record, 'source', path);
  if (!source.ok) {
    return source;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'projectedCurve',
      source: source.value,
      construction: construction.value,
    },
  };
}

/** 交差(FR-325、P4 タスク25)を読む。断面を取る立体の id だけを持つ。 */
function readPlaneSectionFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'planeSection',
      targetFeatureId: targetFeatureId.value,
      construction: construction.value,
    },
  };
}

/** 拘束が指す先(FR-313、P4b タスク21)。値そのものから読む(埋め込み先が多いため)。 */
function readConstraintTargetItem(value: unknown, path: string): Checked<ConstraintTarget> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, CONSTRAINT_TARGET_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
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
    case 'curve': {
      const elementField = readValue(record.value, 'element', path);
      if (!elementField.ok) {
        return elementField;
      }
      const element = readElementRef(elementField.value, joinPath(path, 'element'));
      if (!element.ok) {
        return element;
      }
      return { ok: true, value: { kind: 'curve', element: element.value } };
    }
  }
}

/** 拘束が指す先を欄から読む(`a` / `b` / `target` / `line` / `circle` の各欄用)。 */
function readConstraintTarget(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ConstraintTarget> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readConstraintTargetItem(found.value, joinPath(parentPath, key));
}

/**
 * 拘束1件(FR-313、P4b タスク21)を読む。`SKETCH_CONSTRAINT_KINDS` を網羅するので、
 * 知らない種類は `readLiteral` が場所つきで断る(既存の流儀と同じ)。
 */
function readConstraint(value: unknown, path: string): Checked<SketchConstraint> {
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
  const kind = readLiteral(record.value, 'kind', path, SKETCH_CONSTRAINT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const base = { id: id.value, name: name.value };
  switch (kind.value) {
    case 'coincident': {
      const a = readConstraintTarget(record.value, 'a', path);
      if (!a.ok) {
        return a;
      }
      const b = readConstraintTarget(record.value, 'b', path);
      if (!b.ok) {
        return b;
      }
      return { ok: true, value: { ...base, kind: 'coincident', a: a.value, b: b.value } };
    }
    case 'horizontal':
    case 'vertical': {
      const target = readConstraintTarget(record.value, 'target', path);
      if (!target.ok) {
        return target;
      }
      return { ok: true, value: { ...base, kind: kind.value, target: target.value } };
    }
    case 'parallel':
    case 'perpendicular':
    case 'equal': {
      const a = readConstraintTarget(record.value, 'a', path);
      if (!a.ok) {
        return a;
      }
      const b = readConstraintTarget(record.value, 'b', path);
      if (!b.ok) {
        return b;
      }
      return { ok: true, value: { ...base, kind: kind.value, a: a.value, b: b.value } };
    }
    case 'tangent': {
      const line = readConstraintTarget(record.value, 'line', path);
      if (!line.ok) {
        return line;
      }
      const circle = readConstraintTarget(record.value, 'circle', path);
      if (!circle.ok) {
        return circle;
      }
      return { ok: true, value: { ...base, kind: 'tangent', line: line.value, circle: circle.value } };
    }
    case 'concentric': {
      const a = readConstraintTarget(record.value, 'a', path);
      if (!a.ok) {
        return a;
      }
      const b = readConstraintTarget(record.value, 'b', path);
      if (!b.ok) {
        return b;
      }
      return { ok: true, value: { ...base, kind: 'concentric', a: a.value, b: b.value } };
    }
    case 'symmetric': {
      const a = readConstraintTarget(record.value, 'a', path);
      if (!a.ok) {
        return a;
      }
      const b = readConstraintTarget(record.value, 'b', path);
      if (!b.ok) {
        return b;
      }
      const axisField = readValue(record.value, 'axis', path);
      if (!axisField.ok) {
        return axisField;
      }
      const axis = readElementRef(axisField.value, joinPath(path, 'axis'));
      if (!axis.ok) {
        return axis;
      }
      return {
        ok: true,
        value: { ...base, kind: 'symmetric', a: a.value, b: b.value, axis: axis.value },
      };
    }
    case 'fix': {
      const target = readConstraintTarget(record.value, 'target', path);
      if (!target.ok) {
        return target;
      }
      return { ok: true, value: { ...base, kind: 'fix', target: target.value } };
    }
    case 'distance': {
      const a = readConstraintTarget(record.value, 'a', path);
      if (!a.ok) {
        return a;
      }
      const b = readConstraintTarget(record.value, 'b', path);
      if (!b.ok) {
        return b;
      }
      const length = readExpression(record.value, 'length', path);
      if (!length.ok) {
        return length;
      }
      return { ok: true, value: { ...base, kind: 'distance', a: a.value, b: b.value, length: length.value } };
    }
    case 'angle': {
      const a = readConstraintTarget(record.value, 'a', path);
      if (!a.ok) {
        return a;
      }
      const b = readConstraintTarget(record.value, 'b', path);
      if (!b.ok) {
        return b;
      }
      const angle = readExpression(record.value, 'angle', path);
      if (!angle.ok) {
        return angle;
      }
      return { ok: true, value: { ...base, kind: 'angle', a: a.value, b: b.value, angle: angle.value } };
    }
    case 'radius':
    case 'diameter': {
      const target = readConstraintTarget(record.value, 'target', path);
      if (!target.ok) {
        return target;
      }
      const size = readExpression(record.value, 'size', path);
      if (!size.ok) {
        return size;
      }
      return { ok: true, value: { ...base, kind: kind.value, target: target.value, size: size.value } };
    }
  }
}

/**
 * スケッチの拘束(FR-313、P4b タスク21)を読む。**型自体が恒常的に省略可能**
 * (`SketchDocument.constraints?`)なので、`freeOrientation` と同じ約束で「欄が無ければ
 * `null`」を返し、呼び出し側は欄そのものを持たない(`undefined` にもしない)。
 * 版に関係なく同じ扱いにする(移行の対象にしない。`schema.ts` の `migrateDocumentToV5` 参照)。
 */
function readSketchConstraintsField(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly SketchConstraint[] | null> {
  if (!('constraints' in record)) {
    return { ok: true, value: null };
  }
  return readList(record, 'constraints', path, readConstraint);
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
  const constraints = readSketchConstraintsField(record.value, path);
  if (!constraints.ok) {
    return constraints;
  }
  const sketch: SketchDocument = { id: id.value, name: name.value, features: features.value };
  if (constraints.value === null) {
    return { ok: true, value: sketch };
  }
  return { ok: true, value: { ...sketch, constraints: constraints.value } };
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
    case 'reference': {
      const referenceFeatureId = readString(record.value, 'referenceFeatureId', path);
      if (!referenceFeatureId.ok) {
        return referenceFeatureId;
      }
      return {
        ok: true,
        value: { kind: 'reference', referenceFeatureId: referenceFeatureId.value },
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

/**
 * 穴の入口(ざぐり・皿もみ。FR-422、P5 タスク43)を読む。
 *
 * **欄が無い古いファイルは `undefined` のまま返す**(`RuledSphereSegments` は既定値を
 * 埋めたが、こちらは型が省略可能なので既定を書き込まない。読む側は model の
 * `holeEntryOf` を通せば `plain` が返る)。知らない `kind` は `readLiteral` が断る。
 */
function readHoleEntry(
  record: Record<string, unknown>,
  path: string,
): Checked<HoleEntry | undefined> {
  if (!('entry' in record)) {
    return { ok: true, value: undefined };
  }
  const found = readRecord(record, 'entry', path);
  if (!found.ok) {
    return found;
  }
  const entryPath = joinPath(path, 'entry');
  const kind = readLiteral(found.value, 'kind', entryPath, HOLE_ENTRY_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'plain':
      return { ok: true, value: { kind: 'plain' } };
    case 'counterbore': {
      const diameter = readExpression(found.value, 'diameter', entryPath);
      if (!diameter.ok) {
        return diameter;
      }
      const depth = readExpression(found.value, 'depth', entryPath);
      if (!depth.ok) {
        return depth;
      }
      return {
        ok: true,
        value: { kind: 'counterbore', diameter: diameter.value, depth: depth.value },
      };
    }
    case 'countersink': {
      const diameter = readExpression(found.value, 'diameter', entryPath);
      if (!diameter.ok) {
        return diameter;
      }
      const angle = readExpression(found.value, 'angle', entryPath);
      if (!angle.ok) {
        return angle;
      }
      return {
        ok: true,
        value: { kind: 'countersink', diameter: diameter.value, angle: angle.value },
      };
    }
  }
}

/**
 * 押し出しの終端(FR-415、P5 タスク43)を読む。欄が無いファイルは `undefined` のまま
 * 返す(既定は model の `extrudeShapingOf` が `symmetric` から決める)。
 */
function readExtrudeEnd(
  record: Record<string, unknown>,
  path: string,
): Checked<ExtrudeEnd | undefined> {
  if (!('end' in record)) {
    return { ok: true, value: undefined };
  }
  const found = readRecord(record, 'end', path);
  if (!found.ok) {
    return found;
  }
  const endPath = joinPath(path, 'end');
  const kind = readLiteral(found.value, 'kind', endPath, EXTRUDE_END_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'distance':
    case 'symmetric':
    case 'toNext':
      return { ok: true, value: { kind: kind.value } };
    case 'toFace': {
      const face = readSubShapeRefField(found.value, 'face', endPath);
      if (!face.ok) {
        return face;
      }
      return { ok: true, value: { kind: 'toFace', face: face.value } };
    }
  }
}

/** 欄が無ければ `undefined`、あれば式として読む(P5 タスク43 の省略できる式の欄)。 */
function readOptionalExpression(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<ExpressionValueJson | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readExpression(record, key, path);
}

/**
 * 欄が無ければ `undefined`、`null` なら `null`、あれば式として読む
 * (薄板押し出しの厚み。FR-416。**`null` は「中実」という意味を持つ値**なので保つ)。
 */
function readNullableExpression(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<ExpressionValueJson | null | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  const found = readValue(record, key, path);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return { ok: true, value: null };
  }
  return readExpression(record, key, path);
}

/** 欄が無ければ `undefined`、あれば真偽として読む(P5 タスク43 の省略できるつまみ)。 */
function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<boolean | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readBoolean(record, key, path);
}

/** 欄が無ければ `undefined`、あれば決められた文字列として読む(P5 タスク43)。 */
function readOptionalLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): Checked<T | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readLiteral(record, key, path, allowed);
}

/**
 * 欄が無ければ `undefined`、あれば文字列として読む(読み込んだ形の `importedAt`、
 * P6 タスク20)。**`null` は受け付けない**——省略と `null` を別の意味にしないため。
 */
function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<string | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readString(record, key, path);
}

/**
 * 欄が無ければ `undefined`、あれば数として読む(読み込んだ三角形の形の `volume`、
 * P6 タスク20)。指紋の `radius` を読む `readOptionalNumber`(guards.ts)とは別物で、
 * あちらは**欄があって `null`** を許す(「円柱でないので半径が無い」の意味を持つ null)。
 */
function readOptionalNumberField(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<number | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readNumber(record, key, path);
}

/** スケッチの曲線の並びへの参照(P5 タスク43)。id の配列は 1 つ以上でなくてもここでは断らない。 */
function readCurveRefRecord(
  record: Record<string, unknown>,
  path: string,
): Checked<SketchCurveRef> {
  const sketchId = readString(record, 'sketchId', path);
  if (!sketchId.ok) {
    return sketchId;
  }
  const curveIds = readList(record, 'curveIds', path, readStringItem);
  if (!curveIds.ok) {
    return curveIds;
  }
  return { ok: true, value: { sketchId: sketchId.value, curveIds: curveIds.value } };
}

function readCurveRef(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<SketchCurveRef> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  return readCurveRefRecord(record.value, joinPath(parentPath, key));
}

function readCurveRefItem(value: unknown, path: string): Checked<SketchCurveRef> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  return readCurveRefRecord(record.value, path);
}

/** 文字列 1 件(id の一覧に使う)。 */
function readStringItem(value: unknown, path: string): Checked<string> {
  if (typeof value !== 'string') {
    return fieldProblem(path, 'type');
  }
  return { ok: true, value };
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
    case 'reference': {
      const referenceFeatureId = readString(record.value, 'referenceFeatureId', path);
      if (!referenceFeatureId.ok) {
        return referenceFeatureId;
      }
      return {
        ok: true,
        value: { kind: 'reference', referenceFeatureId: referenceFeatureId.value },
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
    case 'points': {
      // 点の集まりへ複製(FR-425、P5 タスク43)。個数・間隔の欄は無い。
      const points = readList(record.value, 'points', path, readPointReferenceItem);
      if (!points.ok) {
        return points;
      }
      return { ok: true, value: { kind: 'points', points: points.value } };
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
    case 'primitive':
      return readPrimitiveFeature(record.value, path, base.value);
    case 'ruled':
      return readRuledFeature(record.value, path, base.value);
    case 'loft':
      return readLoftFeature(record.value, path, base.value);
    // P5 の Should 群 9 種(§2.11、タスク43)。
    case 'draft':
      return readDraftFeature(record.value, path, base.value);
    case 'mirror':
      return readMirrorFeature(record.value, path, base.value);
    case 'transform':
      return readTransformFeature(record.value, path, base.value);
    case 'scale':
      return readScaleFeature(record.value, path, base.value);
    case 'sweep':
      return readSweepFeature(record.value, path, base.value);
    case 'rib':
      return readRibFeature(record.value, path, base.value);
    case 'emboss':
      return readEmbossFeature(record.value, path, base.value);
    case 'threadShaft':
      return readThreadShaftFeature(record.value, path, base.value);
    case 'surface':
      return readSurfaceFeature(record.value, path, base.value);
    // P5 の Could 群のうちタスク46 が前倒しした 1 種(FR-418)。
    case 'shell':
      return readShellFeature(record.value, path, base.value);
    // 平面による切断(FR-432、§2.9b、タスク27c)。
    case 'cut':
      return readCutFeature(record.value, path, base.value);
    // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。
    case 'importedSolid':
      return readImportedSolidFeature(record.value, path, base.value);
    case 'importedMesh':
      return readImportedMeshFeature(record.value, path, base.value);
  }
}

/**
 * 読み込んだ形の素性(FR-802、P6 §2.8)を読む。
 *
 * 形式・単位は決められた文字列のどれかで、知らない値は既存の `invalidField` になる
 * (**エラーコードは増やさない**。`docs/報告記録.md` 2026-09-04 01:40 の③)。
 * `importedAt` だけが省略できる欄で、無ければ `undefined` のまま持つ。
 */
function readImportedSource(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ImportedSource> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const format = readLiteral(record.value, 'format', path, IMPORTED_SOURCE_FORMATS);
  if (!format.ok) {
    return format;
  }
  const fileName = readString(record.value, 'fileName', path);
  if (!fileName.ok) {
    return fileName;
  }
  const unit = readLiteral<LengthUnit>(record.value, 'unit', path, LENGTH_UNITS);
  if (!unit.ok) {
    return unit;
  }
  const byteLength = readNumber(record.value, 'byteLength', path);
  if (!byteLength.ok) {
    return byteLength;
  }
  const importedAt = readOptionalString(record.value, 'importedAt', path);
  if (!importedAt.ok) {
    return importedAt;
  }
  return {
    ok: true,
    value: {
      format: format.value,
      fileName: fileName.value,
      unit: unit.value,
      byteLength: byteLength.value,
      ...(importedAt.value === undefined ? {} : { importedAt: importedAt.value }),
    },
  };
}

/** 読み込んだ形(FR-802、P6 §2.8、§0.a-0.9)を読む。 */
function readImportedSolidFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const shapeRef = readString(record, 'shapeRef', path);
  if (!shapeRef.ok) {
    return shapeRef;
  }
  const source = readImportedSource(record, 'source', path);
  if (!source.ok) {
    return source;
  }
  const bodyKind = readLiteral(record, 'bodyKind', path, IMPORTED_BODY_KINDS);
  if (!bodyKind.ok) {
    return bodyKind;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'importedSolid',
      shapeRef: shapeRef.value,
      source: source.value,
      bodyKind: bodyKind.value,
    },
  };
}

/** 読み込んだ三角形の形(FR-802、P6 §2.8、§0.a-0.24)を読む。`volume` は省略できる。 */
function readImportedMeshFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const meshRef = readString(record, 'meshRef', path);
  if (!meshRef.ok) {
    return meshRef;
  }
  const source = readImportedSource(record, 'source', path);
  if (!source.ok) {
    return source;
  }
  const triangleCount = readNumber(record, 'triangleCount', path);
  if (!triangleCount.ok) {
    return triangleCount;
  }
  const volume = readOptionalNumberField(record, 'volume', path);
  if (!volume.ok) {
    return volume;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'importedMesh',
      meshRef: meshRef.value,
      source: source.value,
      triangleCount: triangleCount.value,
      ...(volume.value === undefined ? {} : { volume: volume.value }),
    },
  };
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
  /*
    終端・傾き・薄板(FR-415、FR-401、FR-416。P5 タスク43)。**5 欄とも省略できる。**
    版 6 までのファイルはどれも持たないので、無いときは `undefined` のまま読み、
    既定は model の `extrudeShapingOf` が与える(既定値を io にも書くと 2 か所になる)。
  */
  const end = readExtrudeEnd(record, path);
  if (!end.ok) {
    return end;
  }
  const taperAngle = readOptionalExpression(record, 'taperAngle', path);
  if (!taperAngle.ok) {
    return taperAngle;
  }
  const taperOutward = readOptionalBoolean(record, 'taperOutward', path);
  if (!taperOutward.ok) {
    return taperOutward;
  }
  const thickness = readNullableExpression(record, 'thickness', path);
  if (!thickness.ok) {
    return thickness;
  }
  const thicknessSide = readOptionalLiteral(record, 'thicknessSide', path, THICKNESS_SIDES);
  if (!thicknessSide.ok) {
    return thicknessSide;
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
      /*
        **省略されていた欄は欄ごと省略のまま返す**(`end: undefined` を持たせない)。
        `Object.keys` で欄の顔ぶれを固定している検査があり、値が undefined でも
        欄があると数が変わってしまうためで、意味の上でも「無い」と「未定」を分けない。
      */
      ...(end.value === undefined ? {} : { end: end.value }),
      ...(taperAngle.value === undefined ? {} : { taperAngle: taperAngle.value }),
      ...(taperOutward.value === undefined ? {} : { taperOutward: taperOutward.value }),
      ...(thickness.value === undefined ? {} : { thickness: thickness.value }),
      ...(thicknessSide.value === undefined ? {} : { thicknessSide: thicknessSide.value }),
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
  // 入口(ざぐり・皿もみ。FR-422、P5 タスク43)。欄が無ければ省略のまま(= 広げない)。
  const entry = readHoleEntry(record, path);
  if (!entry.ok) {
    return entry;
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
      // 押し出しの終端と同じ理由で、省略されていた入口は欄ごと省略のまま返す。
      ...(entry.value === undefined ? {} : { entry: entry.value }),
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
  // 入口(ざぐり・皿もみ。FR-422、P5 タスク43)。穴とまったく同じ扱い。
  const entry = readHoleEntry(record, path);
  if (!entry.ok) {
    return entry;
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
      ...(entry.value === undefined ? {} : { entry: entry.value }),
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
  /*
    可変半径の終点側(FR-426、P5 タスク46)。**省略できる欄**なので、版 4 以前・
    版 5 前半のファイル(`radius` だけを持つ)は欄が無いまま読めて、`filletRadiusOf` が
    「一定半径」として返す。読み手で 2 通りの形へ分岐する必要も、移行を増やす必要もない
    (計画書 タスク54 の注意書きが求めていた「両方の形を読める」を、欄を足す形で満たす)。

    **`radiusEnd` が `null` のときも「欄が無い」として読む**(P5 仕上げ (h)、
    `docs/報告記録.md` 2026-09-05 23:08 の t47 指摘①)。書き手(`serializeSolidFeature`)は
    `radiusEnd` が `undefined` でも `null` でも欄ごと落とすので(§0.a-0.48「一定半径」)、
    読み手だけが `null` を型違いとして断ると書き手と非対称になる。`filletRadiusOf` も
    `undefined` と `null` を同じ「一定半径」として扱う(`createPartDocument.ts` の
    「省略できる欄の約束」を参照。`radiusEnd` は `thickness` と違い `null` に
    別の意味を持たせていない)。
  */
  const radiusEnd: Checked<ExpressionValueJson | undefined> =
    record['radiusEnd'] === null
      ? { ok: true, value: undefined }
      : readOptionalExpression(record, 'radiusEnd', path);
  if (!radiusEnd.ok) {
    return radiusEnd;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'fillet',
      targetFeatureId: targetFeatureId.value,
      targets: targets.value,
      radius: radius.value,
      ...(radiusEnd.value === undefined ? {} : { radiusEnd: radiusEnd.value }),
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

// ---------------------------------------------------------------------------
// P5(FR-429、計画書 §2.7.1、タスク17)が足す基本形状の読み込み
// ---------------------------------------------------------------------------

/**
 * 基本形状の基準点を読む(FR-429)。3通りで欄が違うので `kind` で分岐する。
 * `sketchPoint` は `readPointRefField`、`vertex` は `readSubShapeRefField`(P3 の
 * 加工フィーチャーと同じ組み立て)をそのまま使い回す。
 */
function readSolidOrigin(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<SolidOrigin> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, SOLID_ORIGIN_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'coordinate': {
      const coordinate = readCoordinate(record.value, 'value', path);
      if (!coordinate.ok) {
        return coordinate;
      }
      return { ok: true, value: { kind: 'coordinate', value: coordinate.value } };
    }
    case 'sketchPoint': {
      const ref = readPointRefField(record.value, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'sketchPoint', ref: ref.value } };
    }
    case 'vertex': {
      const ref = readSubShapeRefField(record.value, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'vertex', ref: ref.value } };
    }
  }
}

/** 基本形状の寸法を読む(FR-429)。種類ごとに欄が違うので `kind` で分岐する。 */
function readPrimitiveShape(value: unknown, path: string): Checked<PrimitiveShape> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, PRIMITIVE_SHAPE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'sphere': {
      const radius = readExpression(record.value, 'radius', path);
      if (!radius.ok) {
        return radius;
      }
      return { ok: true, value: { kind: 'sphere', radius: radius.value } };
    }
    case 'box': {
      const sizeX = readExpression(record.value, 'sizeX', path);
      if (!sizeX.ok) {
        return sizeX;
      }
      const sizeY = readExpression(record.value, 'sizeY', path);
      if (!sizeY.ok) {
        return sizeY;
      }
      const sizeZ = readExpression(record.value, 'sizeZ', path);
      if (!sizeZ.ok) {
        return sizeZ;
      }
      return {
        ok: true,
        value: { kind: 'box', sizeX: sizeX.value, sizeY: sizeY.value, sizeZ: sizeZ.value },
      };
    }
    case 'cylinder': {
      const radius = readExpression(record.value, 'radius', path);
      if (!radius.ok) {
        return radius;
      }
      const height = readExpression(record.value, 'height', path);
      if (!height.ok) {
        return height;
      }
      return { ok: true, value: { kind: 'cylinder', radius: radius.value, height: height.value } };
    }
    case 'cone': {
      const bottomRadius = readExpression(record.value, 'bottomRadius', path);
      if (!bottomRadius.ok) {
        return bottomRadius;
      }
      const topRadius = readExpression(record.value, 'topRadius', path);
      if (!topRadius.ok) {
        return topRadius;
      }
      const height = readExpression(record.value, 'height', path);
      if (!height.ok) {
        return height;
      }
      return {
        ok: true,
        value: {
          kind: 'cone',
          bottomRadius: bottomRadius.value,
          topRadius: topRadius.value,
          height: height.value,
        },
      };
    }
    case 'torus': {
      const majorRadius = readExpression(record.value, 'majorRadius', path);
      if (!majorRadius.ok) {
        return majorRadius;
      }
      const minorRadius = readExpression(record.value, 'minorRadius', path);
      if (!minorRadius.ok) {
        return minorRadius;
      }
      return {
        ok: true,
        value: { kind: 'torus', majorRadius: majorRadius.value, minorRadius: minorRadius.value },
      };
    }
  }
}

function readPrimitiveShapeField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PrimitiveShape> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readPrimitiveShape(found.value, joinPath(parentPath, key));
}

/**
 * 基本形状(球・箱・円柱・円錐・トーラス。FR-429、P5 計画書 §2.7.1、タスク17)を読む。
 * 対象を消費しない「作る」フィーチャーなので、押し出し・ばねと同じ構え(基本の欄 +
 * 種類固有の欄)で読む。
 */
function readPrimitiveFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const origin = readSolidOrigin(record, 'origin', path);
  if (!origin.ok) {
    return origin;
  }
  const axis = readRevolveAxis(record, 'axis', path);
  if (!axis.ok) {
    return axis;
  }
  const shape = readPrimitiveShapeField(record, 'shape', path);
  if (!shape.ok) {
    return shape;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'primitive',
      origin: origin.value,
      axis: axis.value,
      shape: shape.value,
    },
  };
}

/** 罫線面・ロフトの断面 1 つ(P5 §2.9.1、タスク25)。 */
function readRuledSectionItem(value: unknown, path: string): Checked<RuledSection> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, RULED_SECTION_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'sketchFace': {
      const ref = readFaceRef(record.value, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'sketchFace', ref: ref.value } };
    }
    case 'solidFace': {
      const ref = readSubShapeRefField(record.value, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'solidFace', ref: ref.value } };
    }
    case 'sphere': {
      const sphereFeatureId = readString(record.value, 'sphereFeatureId', path);
      if (!sphereFeatureId.ok) {
        return sphereFeatureId;
      }
      return { ok: true, value: { kind: 'sphere', sphereFeatureId: sphereFeatureId.value } };
    }
  }
}

function readRuledSectionField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<RuledSection> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readRuledSectionItem(found.value, joinPath(parentPath, key));
}

/**
 * 球へつなぐときの近似の点の数(§0.a-0.74)。
 *
 * **欄が無い古いファイルは既定の 24 として読む**(この欄は P5 の途中で足したもので、
 * 無いことが「壊れている」を意味しないため)。24 / 48 / 72 以外の数は
 * その欄の型が違うとして断る(新しい値の意味を推測しない)。
 */
function readRuledSphereSegments(
  record: Record<string, unknown>,
  path: string,
): Checked<RuledSphereSegments> {
  if (!('sphereSegments' in record)) {
    return { ok: true, value: DEFAULT_RULED_SPHERE_SEGMENTS };
  }
  const found = readNumber(record, 'sphereSegments', path);
  if (!found.ok) {
    return found;
  }
  for (const candidate of RULED_SPHERE_SEGMENT_CHOICES) {
    if (candidate === found.value) {
      return { ok: true, value: candidate };
    }
  }
  return fieldProblem(joinPath(path, 'sphereSegments'), 'type');
}

function readRuledFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const first = readRuledSectionField(record, 'first', path);
  if (!first.ok) {
    return first;
  }
  const second = readRuledSectionField(record, 'second', path);
  if (!second.ok) {
    return second;
  }
  const twist = readExpression(record, 'twist', path);
  if (!twist.ok) {
    return twist;
  }
  const sphereSegments = readRuledSphereSegments(record, path);
  if (!sphereSegments.ok) {
    return sphereSegments;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'ruled',
      first: first.value,
      second: second.value,
      twist: twist.value,
      sphereSegments: sphereSegments.value,
    },
  };
}

function readLoftFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const sections = readList(record, 'sections', path, readRuledSectionItem);
  if (!sections.ok) {
    return sections;
  }
  const twist = readExpression(record, 'twist', path);
  if (!twist.ok) {
    return twist;
  }
  return {
    ok: true,
    value: { ...base, kind: 'loft', sections: sections.value, twist: twist.value },
  };
}

// ---------------------------------------------------------------------------
// P5 の Should 群 9 種の読み込み(§2.11、タスク43)。
//
// **書き出し(`serializeSolidFeature`)と欄名・順序を必ず揃える。** 参照は id と指紋、
// 寸法は式のままで、座標・ラジアン・解決した形は 1 つも読まない(要件§8)。
// ---------------------------------------------------------------------------

/** 抜き勾配(FR-417)を読む。傾ける面は 1 枚以上、中立面は 1 枚。 */
function readDraftFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const faces = readList(record, 'faces', path, readSubShapeRef);
  if (!faces.ok) {
    return faces;
  }
  const neutralFace = readSubShapeRefField(record, 'neutralFace', path);
  if (!neutralFace.ok) {
    return neutralFace;
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
      kind: 'draft',
      targetFeatureId: targetFeatureId.value,
      faces: faces.value,
      neutralFace: neutralFace.value,
      angle: angle.value,
      reversed: reversed.value,
    },
  };
}

/** ミラー(FR-419)を読む。鏡は作業平面の id か立体の平らな面。 */
function readMirrorFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const plane = readMirrorPlane(record, 'plane', path);
  if (!plane.ok) {
    return plane;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'mirror',
      targetFeatureId: targetFeatureId.value,
      plane: plane.value,
    },
  };
}

function readMirrorPlane(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<MirrorPlane> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, MIRROR_PLANE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'workPlane': {
      const planeId = readString(record.value, 'planeId', path);
      if (!planeId.ok) {
        return planeId;
      }
      return { ok: true, value: { kind: 'workPlane', planeId: planeId.value } };
    }
    case 'face': {
      const face = readSubShapeRefField(record.value, 'face', path);
      if (!face.ok) {
        return face;
      }
      return { ok: true, value: { kind: 'face', face: face.value } };
    }
  }
}

/** 移動/回転(FR-424)を読む。移動は式 3 つ、回転軸は無し(null)でもよい。 */
function readTransformFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const translation = readList(record, 'translation', path, readExpressionItem);
  if (!translation.ok) {
    return translation;
  }
  if (translation.value.length !== 3) {
    return fieldProblem(joinPath(path, 'translation'), 'type');
  }
  const rotationAxis = readOptionalRevolveAxis(record, 'rotationAxis', path);
  if (!rotationAxis.ok) {
    return rotationAxis;
  }
  const rotationAngle = readExpression(record, 'rotationAngle', path);
  if (!rotationAngle.ok) {
    return rotationAngle;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'transform',
      targetFeatureId: targetFeatureId.value,
      translation: [translation.value[0], translation.value[1], translation.value[2]],
      rotationAxis: rotationAxis.value,
      rotationAngle: rotationAngle.value,
    },
  };
}

/** 式 1 件(一覧に使う)。 */
function readExpressionItem(value: unknown, path: string): Checked<ExpressionValueJson> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  // `readExpression` は親のレコードと欄名で受け取る形なので、1 欄だけの入れ物に包む。
  // 断りの位置は包む前の `path` のままにしたいので、欄名は同じ `path` の下に付かない。
  const text = readString(record.value, 'source', path);
  if (!text.ok) {
    return text;
  }
  const display = readString(record.value, 'display', path);
  if (!display.ok) {
    return display;
  }
  const found = readValue(record.value, 'value', path);
  if (!found.ok) {
    return found;
  }
  // 数でない `value` は NaN として読む(`readExpression` と同じ扱い。FR-504)。
  const number = typeof found.value === 'number' ? found.value : Number.NaN;
  return { ok: true, value: { source: text.value, value: number, display: display.value } };
}

/** 無い(null)ことがある軸(移動/回転の回転軸)。 */
function readOptionalRevolveAxis(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<RevolveAxis | null> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return { ok: true, value: null };
  }
  return readRevolveAxis(source, key, parentPath);
}

/** 拡大縮小(FR-424)を読む。中心は点の指定、倍率は全体か軸ごと。 */
function readScaleFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const origin = readPointReference(record, 'origin', path);
  if (!origin.ok) {
    return origin;
  }
  const factor = readScaleFactor(record, 'factor', path);
  if (!factor.ok) {
    return factor;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'scale',
      targetFeatureId: targetFeatureId.value,
      origin: origin.value,
      factor: factor.value,
    },
  };
}

function readScaleFactor(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ScaleFactor> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, SCALE_FACTOR_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'uniform': {
      const value = readExpression(record.value, 'value', path);
      if (!value.ok) {
        return value;
      }
      return { ok: true, value: { kind: 'uniform', value: value.value } };
    }
    case 'perAxis': {
      const x = readExpression(record.value, 'x', path);
      if (!x.ok) {
        return x;
      }
      const y = readExpression(record.value, 'y', path);
      if (!y.ok) {
        return y;
      }
      const z = readExpression(record.value, 'z', path);
      if (!z.ok) {
        return z;
      }
      return { ok: true, value: { kind: 'perAxis', x: x.value, y: y.value, z: z.value } };
    }
  }
}

/** スイープ(FR-409)を読む。断面はスケッチの面、経路はスケッチの曲線の並び。 */
function readSweepFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const profile = readFaceRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const sweepPath = readCurveRef(record, 'path', path);
  if (!sweepPath.ok) {
    return sweepPath;
  }
  const frenet = readBoolean(record, 'frenet', path);
  if (!frenet.ok) {
    return frenet;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'sweep',
      profile: profile.value,
      path: sweepPath.value,
      frenet: frenet.value,
    },
  };
}

/** リブ(FR-420)を読む。輪郭は開いていてよいのでスケッチの曲線の並び。 */
function readRibFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const profile = readCurveRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const thickness = readExpression(record, 'thickness', path);
  if (!thickness.ok) {
    return thickness;
  }
  const side = readLiteral(record, 'side', path, RIB_SIDES);
  if (!side.ok) {
    return side;
  }
  const extendToBody = readBoolean(record, 'extendToBody', path);
  if (!extendToBody.ok) {
    return extendToBody;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'rib',
      targetFeatureId: targetFeatureId.value,
      profile: profile.value,
      thickness: thickness.value,
      side: side.value,
      extendToBody: extendToBody.value,
    },
  };
}

/** エンボス(FR-421)を読む。相手の面は指紋、輪郭はスケッチの面。 */
function readEmbossFeature(
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
  const profile = readFaceRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const height = readExpression(record, 'height', path);
  if (!height.ok) {
    return height;
  }
  const raised = readBoolean(record, 'raised', path);
  if (!raised.ok) {
    return raised;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'emboss',
      targetFeatureId: targetFeatureId.value,
      face: face.value,
      profile: profile.value,
      height: height.value,
      raised: raised.value,
    },
  };
}

/** 外ねじ(FR-423)を読む。呼びはねじ穴と同じ規格表の鍵で、面は円柱面。 */
function readThreadShaftFeature(
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
  const nominal = readString(record, 'nominal', path);
  if (!nominal.ok) {
    return nominal;
  }
  const series = readLiteral(record, 'series', path, THREAD_SERIES);
  if (!series.ok) {
    return series;
  }
  const pitch = readExpression(record, 'pitch', path);
  if (!pitch.ok) {
    return pitch;
  }
  const length = readExpression(record, 'length', path);
  if (!length.ok) {
    return length;
  }
  const fromEnd = readLiteral(record, 'fromEnd', path, THREAD_SHAFT_ENDS);
  if (!fromEnd.ok) {
    return fromEnd;
  }
  const modeled = readBoolean(record, 'modeled', path);
  if (!modeled.ok) {
    return modeled;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'threadShaft',
      targetFeatureId: targetFeatureId.value,
      face: face.value,
      nominal: nominal.value,
      series: series.value,
      pitch: pitch.value,
      length: length.value,
      fromEnd: fromEnd.value,
      modeled: modeled.value,
    },
  };
}

/** 曲面(FR-428)を読む。作り方 5 種で欄が違う。 */
function readSurfaceFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const operation = readSurfaceOperation(record, 'operation', path);
  if (!operation.ok) {
    return operation;
  }
  return { ok: true, value: { ...base, kind: 'surface', operation: operation.value } };
}

function readSurfaceOperation(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<SurfaceOperation> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, SURFACE_OPERATION_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'extrude': {
      const profile = readCurveRef(record.value, 'profile', path);
      if (!profile.ok) {
        return profile;
      }
      const distance = readExpression(record.value, 'distance', path);
      if (!distance.ok) {
        return distance;
      }
      const reversed = readBoolean(record.value, 'reversed', path);
      if (!reversed.ok) {
        return reversed;
      }
      return {
        ok: true,
        value: {
          kind: 'extrude',
          profile: profile.value,
          distance: distance.value,
          reversed: reversed.value,
        },
      };
    }
    case 'revolve': {
      const profile = readCurveRef(record.value, 'profile', path);
      if (!profile.ok) {
        return profile;
      }
      const axis = readRevolveAxis(record.value, 'axis', path);
      if (!axis.ok) {
        return axis;
      }
      const angle = readExpression(record.value, 'angle', path);
      if (!angle.ok) {
        return angle;
      }
      const reversed = readBoolean(record.value, 'reversed', path);
      if (!reversed.ok) {
        return reversed;
      }
      return {
        ok: true,
        value: {
          kind: 'revolve',
          profile: profile.value,
          axis: axis.value,
          angle: angle.value,
          reversed: reversed.value,
        },
      };
    }
    case 'planar': {
      const profile = readCurveRef(record.value, 'profile', path);
      if (!profile.ok) {
        return profile;
      }
      return { ok: true, value: { kind: 'planar', profile: profile.value } };
    }
    case 'loft': {
      const sections = readList(record.value, 'sections', path, readCurveRefItem);
      if (!sections.ok) {
        return sections;
      }
      const ruled = readBoolean(record.value, 'ruled', path);
      if (!ruled.ok) {
        return ruled;
      }
      return { ok: true, value: { kind: 'loft', sections: sections.value, ruled: ruled.value } };
    }
    case 'face': {
      const targetFeatureId = readString(record.value, 'targetFeatureId', path);
      if (!targetFeatureId.ok) {
        return targetFeatureId;
      }
      const face = readSubShapeRefField(record.value, 'face', path);
      if (!face.ok) {
        return face;
      }
      return {
        ok: true,
        value: { kind: 'face', targetFeatureId: targetFeatureId.value, face: face.value },
      };
    }
    case 'offset': {
      const targetFeatureId = readString(record.value, 'targetFeatureId', path);
      if (!targetFeatureId.ok) {
        return targetFeatureId;
      }
      const face = readSubShapeRefField(record.value, 'face', path);
      if (!face.ok) {
        return face;
      }
      const distance = readExpression(record.value, 'distance', path);
      if (!distance.ok) {
        return distance;
      }
      return {
        ok: true,
        value: {
          kind: 'offset',
          targetFeatureId: targetFeatureId.value,
          face: face.value,
          distance: distance.value,
        },
      };
    }
  }
}

/** くり抜き(FR-418、§2.12、P5 タスク46)を読む。開ける面は 0 枚でもよい。 */
function readShellFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const openFaces = readList(record, 'openFaces', path, readSubShapeRef);
  if (!openFaces.ok) {
    return openFaces;
  }
  const thickness = readExpression(record, 'thickness', path);
  if (!thickness.ok) {
    return thickness;
  }
  const outward = readBoolean(record, 'outward', path);
  if (!outward.ok) {
    return outward;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'shell',
      targetFeatureId: targetFeatureId.value,
      openFaces: openFaces.value,
      thickness: thickness.value,
      outward: outward.value,
    },
  };
}

/**
 * 平面による切断(FR-432、§2.9b、タスク27c)を読む。
 *
 * 切断面は任意の作業平面(FR-328)と同じ `readPlaneSpec` を通す(読み書きを 2 か所に
 * 書かない)。`pairedWith` は**文字列か null** で、欄が無ければ型が違うとして断る
 * (「対の相手がいない」は null であって、欄の省略ではない)。
 * 知らない値は既存の `invalidField` になる(エラーコードは増やさない)。
 */
function readCutFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const plane = readPlaneSpec(record, 'plane', path);
  if (!plane.ok) {
    return plane;
  }
  const keep = readLiteral(record, 'keep', path, CUT_KEEP_SIDES);
  if (!keep.ok) {
    return keep;
  }
  const pairedWith = readNullableString(record, 'pairedWith', path);
  if (!pairedWith.ok) {
    return pairedWith;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'cut',
      targetFeatureId: targetFeatureId.value,
      plane: plane.value,
      keep: keep.value,
      pairedWith: pairedWith.value,
    },
  };
}

/** 文字列か `null`(切断の `pairedWith`)。欄が無い・別の型なら断る。 */
function readNullableString(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<string | null> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return { ok: true, value: null };
  }
  return readString(source, key, parentPath);
}

// ---------------------------------------------------------------------------
// P4(FR-328、FR-329、タスク9)が足す平面の指定と基準ジオメトリの読み込み
// ---------------------------------------------------------------------------

function readPlaneSpecRecord(
  record: Record<string, unknown>,
  path: string,
): Checked<PlaneSpec> {
  const kind = readLiteral(record, 'kind', path, PLANE_SPEC_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'threePoints': {
      const p1 = readPointReference(record, 'p1', path);
      if (!p1.ok) {
        return p1;
      }
      const p2 = readPointReference(record, 'p2', path);
      if (!p2.ok) {
        return p2;
      }
      const p3 = readPointReference(record, 'p3', path);
      if (!p3.ok) {
        return p3;
      }
      return { ok: true, value: { kind: 'threePoints', p1: p1.value, p2: p2.value, p3: p3.value } };
    }
    case 'pointAndEdge': {
      const point = readPointReference(record, 'point', path);
      if (!point.ok) {
        return point;
      }
      const edge = readSubShapeRefField(record, 'edge', path);
      if (!edge.ok) {
        return edge;
      }
      const mode = readLiteral(record, 'mode', path, POINT_AND_EDGE_MODES);
      if (!mode.ok) {
        return mode;
      }
      return {
        ok: true,
        value: { kind: 'pointAndEdge', point: point.value, edge: edge.value, mode: mode.value },
      };
    }
    case 'pointAndAxis': {
      const point = readPointReference(record, 'point', path);
      if (!point.ok) {
        return point;
      }
      const axis = readRevolveAxis(record, 'axis', path);
      if (!axis.ok) {
        return axis;
      }
      const tilt = readExpression(record, 'tilt', path);
      if (!tilt.ok) {
        return tilt;
      }
      const azimuth = readExpression(record, 'azimuth', path);
      if (!azimuth.ok) {
        return azimuth;
      }
      return {
        ok: true,
        value: {
          kind: 'pointAndAxis',
          point: point.value,
          axis: axis.value,
          tilt: tilt.value,
          azimuth: azimuth.value,
        },
      };
    }
    case 'pointAndParallelFace': {
      const point = readPointReference(record, 'point', path);
      if (!point.ok) {
        return point;
      }
      const face = readSubShapeRefField(record, 'face', path);
      if (!face.ok) {
        return face;
      }
      return {
        ok: true,
        value: { kind: 'pointAndParallelFace', point: point.value, face: face.value },
      };
    }
    case 'face': {
      const face = readSubShapeRefField(record, 'face', path);
      if (!face.ok) {
        return face;
      }
      const offset = readExpression(record, 'offset', path);
      if (!offset.ok) {
        return offset;
      }
      return { ok: true, value: { kind: 'face', face: face.value, offset: offset.value } };
    }
    case 'workPlane': {
      const planeId = readString(record, 'planeId', path);
      if (!planeId.ok) {
        return planeId;
      }
      const offset = readExpression(record, 'offset', path);
      if (!offset.ok) {
        return offset;
      }
      return {
        ok: true,
        value: { kind: 'workPlane', planeId: planeId.value, offset: offset.value },
      };
    }
    case 'tilted': {
      const base = readString(record, 'base', path);
      if (!base.ok) {
        return base;
      }
      const axis = readRevolveAxis(record, 'axis', path);
      if (!axis.ok) {
        return axis;
      }
      const angle = readExpression(record, 'angle', path);
      if (!angle.ok) {
        return angle;
      }
      return {
        ok: true,
        value: { kind: 'tilted', base: base.value, axis: axis.value, angle: angle.value },
      };
    }
  }
}

function readPlaneSpec(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PlaneSpec> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  return readPlaneSpecRecord(record.value, joinPath(parentPath, key));
}

function readReferenceAxisDefinition(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ReferenceAxisDefinition> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, REFERENCE_AXIS_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'twoPoints': {
      const from = readPointReference(record.value, 'from', path);
      if (!from.ok) {
        return from;
      }
      const to = readPointReference(record.value, 'to', path);
      if (!to.ok) {
        return to;
      }
      return { ok: true, value: { kind: 'twoPoints', from: from.value, to: to.value } };
    }
    case 'edge': {
      const edge = readSubShapeRefField(record.value, 'edge', path);
      if (!edge.ok) {
        return edge;
      }
      return { ok: true, value: { kind: 'edge', edge: edge.value } };
    }
    case 'faceNormal': {
      const face = readSubShapeRefField(record.value, 'face', path);
      if (!face.ok) {
        return face;
      }
      return { ok: true, value: { kind: 'faceNormal', face: face.value } };
    }
    case 'faceIntersection': {
      const face1 = readSubShapeRefField(record.value, 'face1', path);
      if (!face1.ok) {
        return face1;
      }
      const face2 = readSubShapeRefField(record.value, 'face2', path);
      if (!face2.ok) {
        return face2;
      }
      return {
        ok: true,
        value: { kind: 'faceIntersection', face1: face1.value, face2: face2.value },
      };
    }
  }
}

function readReferencePointDefinition(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ReferencePointDefinition> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, REFERENCE_POINT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'coordinate': {
      const at = readCoordinate(record.value, 'at', path);
      if (!at.ok) {
        return at;
      }
      return { ok: true, value: { kind: 'coordinate', at: at.value } };
    }
    case 'vertex': {
      const vertex = readSubShapeRefField(record.value, 'vertex', path);
      if (!vertex.ok) {
        return vertex;
      }
      return { ok: true, value: { kind: 'vertex', vertex: vertex.value } };
    }
    case 'edgeMidpoint': {
      const edge = readSubShapeRefField(record.value, 'edge', path);
      if (!edge.ok) {
        return edge;
      }
      return { ok: true, value: { kind: 'edgeMidpoint', edge: edge.value } };
    }
    case 'faceCenter': {
      const face = readSubShapeRefField(record.value, 'face', path);
      if (!face.ok) {
        return face;
      }
      return { ok: true, value: { kind: 'faceCenter', face: face.value } };
    }
  }
}

function readReferenceFeature(value: unknown, path: string): Checked<ReferenceFeature> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, REFERENCE_FEATURE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const id = readString(record.value, 'id', path);
  if (!id.ok) {
    return id;
  }
  const name = readString(record.value, 'name', path);
  if (!name.ok) {
    return name;
  }
  const visible = readBoolean(record.value, 'visible', path);
  if (!visible.ok) {
    return visible;
  }
  const base = { id: id.value, name: name.value, visible: visible.value };
  switch (kind.value) {
    case 'referencePlane': {
      const plane = readPlaneSpec(record.value, 'plane', path);
      if (!plane.ok) {
        return plane;
      }
      return { ok: true, value: { ...base, kind: 'referencePlane', plane: plane.value } };
    }
    case 'referenceAxis': {
      const definition = readReferenceAxisDefinition(record.value, 'definition', path);
      if (!definition.ok) {
        return definition;
      }
      return { ok: true, value: { ...base, kind: 'referenceAxis', definition: definition.value } };
    }
    case 'referencePoint': {
      const definition = readReferencePointDefinition(record.value, 'definition', path);
      if (!definition.ok) {
        return definition;
      }
      return { ok: true, value: { ...base, kind: 'referencePoint', definition: definition.value } };
    }
    case 'referenceCoordinateSystem': {
      const origin = readPointReference(record.value, 'origin', path);
      if (!origin.ok) {
        return origin;
      }
      const xAxis = readRevolveAxis(record.value, 'xAxis', path);
      if (!xAxis.ok) {
        return xAxis;
      }
      const yAxis = readRevolveAxis(record.value, 'yAxis', path);
      if (!yAxis.ok) {
        return yAxis;
      }
      return {
        ok: true,
        value: {
          ...base,
          kind: 'referenceCoordinateSystem',
          origin: origin.value,
          xAxis: xAxis.value,
          yAxis: yAxis.value,
        },
      };
    }
  }
}

/**
 * 基準ジオメトリの履歴を読む(FR-328、FR-329)。
 *
 * **版4からは必須**(欠けていれば `missingField`)。版3のまま追加されていた期間
 * (タスク9)はこの欄を持たないファイルもあったが、その寛容さは P4 タスク31(§0.a-0.24)で
 * `schema.ts` の `SCHEMA_MIGRATIONS[3]`(欄が無ければ空配列で補う)へ移した。
 * 書き手は常にこの欄を書く。
 */
function readReferences(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly ReferenceFeature[]> {
  return readList(record, 'references', path, readReferenceFeature);
}

/** パラメータ表の1行(FR-207、P4b タスク21)を読む。単位は `PARAMETER_UNITS` を網羅表にする。 */
function readParameter(value: unknown, path: string): Checked<Parameter> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const name = readString(record.value, 'name', path);
  if (!name.ok) {
    return name;
  }
  const parameterValue = readExpression(record.value, 'value', path);
  if (!parameterValue.ok) {
    return parameterValue;
  }
  const unit: Checked<ParameterUnit> = readLiteral(record.value, 'unit', path, PARAMETER_UNITS);
  if (!unit.ok) {
    return unit;
  }
  const description = readString(record.value, 'description', path);
  if (!description.ok) {
    return description;
  }
  return {
    ok: true,
    value: {
      name: name.value,
      value: parameterValue.value,
      unit: unit.value,
      description: description.value,
    },
  };
}

/**
 * パラメータ表(FR-207、P4b タスク21)を読む。**版5からは必須**(欠けていれば `missingField`)。
 * 版4以前のこの欄が無いファイルは `schema.ts` の `SCHEMA_MIGRATIONS[4]`(欄が無ければ空配列で
 * 補う)へ移す。書き手は常にこの欄を書く。並び順は利用者が並べ替えた順のまま返す(§2.6)。
 */
function readParameters(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly Parameter[]> {
  return readList(record, 'parameters', path, readParameter);
}

/**
 * 決まった文字列のどれかとして読むが、`readLiteral` と違い**一致しなくても断らない**
 * (`{ ok: true, value: null }` を返す)。将来プリセット・柄・樹種が増えても、古い版の
 * アプリで新しい文書を(部分的に)開けるようにするための前方互換の道具
 * (計画書 P5-高度なソリッド・外観と測定.md タスク5「未知のプリセット id / 柄の種類は、
 * その割り当てを落として読み進める」)。欄そのものが無い・文字列でない場合は通常どおり断る。
 */
function readKnownLiteralOrNull<T extends string>(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
  allowed: readonly T[],
): Checked<T | null> {
  const text = readString(source, key, parentPath);
  if (!text.ok) {
    return text;
  }
  for (const candidate of allowed) {
    if (candidate === text.value) {
      return { ok: true, value: candidate };
    }
  }
  return { ok: true, value: null };
}

/**
 * 光沢・粗さ・透過率(FR-1107、FR-1109)。0〜100(%)の式を読む。式が壊れて評価値が NaN の
 * ときは `readExpression` が既に許容しているので対象にしないが、有限の数で 0〜100 の範囲外
 * なら壊れたファイルとして断る(統括の指示。範囲外は `invalidField`)。
 */
function readAppearancePercent(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ExpressionValueJson> {
  const value = readExpression(source, key, parentPath);
  if (!value.ok) {
    return value;
  }
  const path = joinPath(parentPath, key);
  const evaluated = value.value.value;
  if (!Number.isNaN(evaluated) && (evaluated < 0 || evaluated > 100)) {
    return fieldProblem(path, 'type');
  }
  return value;
}

/**
 * 柄(FR-1108)を読む。**未知の柄の種類・未知の樹種は `null` を返し**、呼び出し側
 * (`readAppearanceSpec`)がその割り当てごと落とす(前方互換、タスク5)。
 */
function readAppearancePattern(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<AppearancePattern | null> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readKnownLiteralOrNull(record.value, 'kind', path, APPEARANCE_PATTERN_KINDS);
  if (!kind.ok) {
    return kind;
  }
  if (kind.value === null) {
    return { ok: true, value: null };
  }
  switch (kind.value) {
    case 'none':
      return { ok: true, value: { kind: 'none' } };
    case 'expandedMetal': {
      const spacing = readExpression(record.value, 'spacing', path);
      if (!spacing.ok) {
        return spacing;
      }
      return { ok: true, value: { kind: 'expandedMetal', spacing: spacing.value } };
    }
    case 'checkerPlate': {
      const spacing = readExpression(record.value, 'spacing', path);
      if (!spacing.ok) {
        return spacing;
      }
      return { ok: true, value: { kind: 'checkerPlate', spacing: spacing.value } };
    }
    case 'woodGrain': {
      const spacing = readExpression(record.value, 'spacing', path);
      if (!spacing.ok) {
        return spacing;
      }
      const species = readKnownLiteralOrNull(record.value, 'species', path, WOOD_SPECIES_VALUES);
      if (!species.ok) {
        return species;
      }
      if (species.value === null) {
        return { ok: true, value: null };
      }
      return {
        ok: true,
        value: { kind: 'woodGrain', spacing: spacing.value, species: species.value },
      };
    }
  }
}

/**
 * 見た目そのもの(FR-1107、FR-1109)を読む。**未知のプリセット id・未知の柄・未知の樹種は
 * `null` を返し**、呼び出し側(`readAppearanceEntry`)がその割り当てごと落とす(前方互換)。
 */
function readAppearanceSpec(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<AppearanceSpec | null> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const preset = readKnownLiteralOrNull(record.value, 'preset', path, APPEARANCE_PRESET_IDS);
  if (!preset.ok) {
    return preset;
  }
  if (preset.value === null) {
    return { ok: true, value: null };
  }
  const color = readString(record.value, 'color', path);
  if (!color.ok) {
    return color;
  }
  const transmission = readAppearancePercent(record.value, 'transmission', path);
  if (!transmission.ok) {
    return transmission;
  }
  const gloss = readAppearancePercent(record.value, 'gloss', path);
  if (!gloss.ok) {
    return gloss;
  }
  const roughness = readAppearancePercent(record.value, 'roughness', path);
  if (!roughness.ok) {
    return roughness;
  }
  const pattern = readAppearancePattern(record.value, 'pattern', path);
  if (!pattern.ok) {
    return pattern;
  }
  if (pattern.value === null) {
    return { ok: true, value: null };
  }
  return {
    ok: true,
    value: {
      preset: preset.value,
      color: color.value,
      transmission: transmission.value,
      gloss: gloss.value,
      roughness: roughness.value,
      pattern: pattern.value,
    },
  };
}

/**
 * 外観の割り当て先(FR-1106)を、値そのもの(record)から読む。面は部分形状の参照
 * (P3 の `readSubShapeRefField` を使い回す)。
 *
 * **選択セットの要素(`SelectionMember`、FR-112、P6 タスク37)も同じ形なので、この関数を
 * そのまま使う**(型を 2 つ作らないので、読み手も 1 つ)。欄から読む口(`readAppearanceTarget`)と
 * 値から読む口を分けてあるのは `readCoordinateRecord` / `readCoordinate` と同じ都合で、
 * 配列の要素として読むときに「欄の名前」を場所へ足さないためである。
 */
function readAppearanceTargetRecord(
  record: Record<string, unknown>,
  path: string,
): Checked<AppearanceTarget> {
  const kind = readLiteral(record, 'kind', path, APPEARANCE_TARGET_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'body': {
      const bodyFeatureId = readString(record, 'bodyFeatureId', path);
      if (!bodyFeatureId.ok) {
        return bodyFeatureId;
      }
      return { ok: true, value: { kind: 'body', bodyFeatureId: bodyFeatureId.value } };
    }
    case 'face': {
      const ref = readSubShapeRefField(record, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'face', ref: ref.value } };
    }
  }
}

/** 同じものを「親の record の欄」として読む(外観の割り当ての `target`)。 */
function readAppearanceTarget(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<AppearanceTarget> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  return readAppearanceTargetRecord(record.value, joinPath(parentPath, key));
}

/**
 * 外観の割り当て 1 件を読む。**未知のプリセット id・柄の種類・樹種は、この割り当てだけを
 * 落として読み進める**(戻り値 `null`。ファイル全体は断らない。前方互換、計画書タスク5)。
 * それ以外の壊れ方(id・対象・欄の型違い等)は、このファイルの他の読み手と同じく
 * ファイル全体を断る。
 */
function readAppearanceEntry(value: unknown, path: string): Checked<AppearanceEntry | null> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = readString(record.value, 'id', path);
  if (!id.ok) {
    return id;
  }
  const target = readAppearanceTarget(record.value, 'target', path);
  if (!target.ok) {
    return target;
  }
  const spec = readAppearanceSpec(record.value, 'appearance', path);
  if (!spec.ok) {
    return spec;
  }
  if (spec.value === null) {
    return { ok: true, value: null };
  }
  return { ok: true, value: { id: id.value, target: target.value, appearance: spec.value } };
}

/**
 * 外観の割り当て表(FR-1106〜1110、要件§4.12)を読む。**版6からは必須**(欠けていれば
 * `missingField`)。版5以前のこの欄が無いファイルは `schema.ts` の `SCHEMA_MIGRATIONS[5]`
 * (欄が無ければ空の表で補う)へ移す。書き手は常にこの欄を書く。
 *
 * id の重複は、表全体を読み終えてから `readEnvelope` がまとめて検査する
 * (`findDuplicateConstraintId` と同じ流儀。1件ずつ読むこの関数では前の割り当てを覚える
 * 状態を持たずに済む)。
 */
function readAppearanceTable(
  record: Record<string, unknown>,
  path: string,
): Checked<AppearanceTable> {
  const table = readRecord(record, 'appearance', path);
  if (!table.ok) {
    return table;
  }
  const tablePath = joinPath(path, 'appearance');
  const array = readArray(table.value, 'entries', tablePath);
  if (!array.ok) {
    return array;
  }
  const entriesPath = joinPath(tablePath, 'entries');
  const entries: AppearanceEntry[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const entry = readAppearanceEntry(array.value[index], indexPath(entriesPath, index));
    if (!entry.ok) {
      return entry;
    }
    if (entry.value !== null) {
      entries.push(entry.value);
    }
  }
  return { ok: true, value: { entries } };
}

/**
 * 選択セット 1 つ(FR-112、版7、P6 タスク37)を読む。
 *
 * 要素は外観の `readAppearanceTarget` をそのまま使い回す(型が同じなので読み手も 1 つ)。
 * **名前が空かどうかはここでは見ない。** 空にできないのは利用者の操作の話(model の
 * `createSelectionSet` が断る)で、壊れたファイルの判定ではないため、ここで断ると
 * 「開けないファイル」を作ってしまう(FR-504「読み込みでファイルを失わせない」)。
 * **同じ名前が 2 つあっても読む**(§2.13。区別は id が付ける)。
 */
function readSelectionSetItem(value: unknown, path: string): Checked<SelectionSet> {
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
  const array = readArray(record.value, 'members', path);
  if (!array.ok) {
    return array;
  }
  const membersPath = joinPath(path, 'members');
  const members: SelectionMember[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const itemPath = indexPath(membersPath, index);
    const item = checkRecord(array.value[index], itemPath);
    if (!item.ok) {
      return item;
    }
    // 外観の割り当て先の読み手をそのまま使う(型が同じなので読み手も 1 つ)。
    const member = readAppearanceTargetRecord(item.value, itemPath);
    if (!member.ok) {
      return member;
    }
    members.push(member.value);
  }
  return { ok: true, value: { id: id.value, name: name.value, members } };
}

/**
 * 選択セット(FR-112)を読む。**版7からは必須**(欠けていれば `missingField`)。
 * 版6以前のこの欄が無いファイルは `schema.ts` の `SCHEMA_MIGRATIONS[6]`(欄が無ければ
 * 空配列で補う)へ移す。書き手は常にこの欄を書く。
 */
function readSelectionSets(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly SelectionSet[]> {
  return readList(record, 'selectionSets', path, readSelectionSetItem);
}

/**
 * 下絵の不透明度(FR-332)。**0〜1** の式を読む(外観の透過率が 0〜100% なのと
 * 尺度が違う。理由は model の `SketchCanvas.opacity` の注記)。式が壊れて評価値が
 * NaN のときは `readExpression` が既に許容しているので対象にせず、有限の数で
 * 範囲外なら壊れたファイルとして断る(`readAppearancePercent` と同じ形)。
 */
function readCanvasOpacity(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ExpressionValueJson> {
  const value = readExpression(source, key, parentPath);
  if (!value.ok) {
    return value;
  }
  const evaluated = value.value.value;
  if (!Number.isNaN(evaluated) && (evaluated < 0 || evaluated > 1)) {
    return fieldProblem(joinPath(parentPath, key), 'type');
  }
  return value;
}

/**
 * 下絵 1 枚(FR-332、版7、P6 タスク38)を読む。
 *
 * `imageId` は ZIP のエントリを指す名前で、**指す先が入っているかはここでは見ない**
 * (`pcadFile.ts` の `findMissingAttachment` が `missingField` で断る。`document.json`
 * だけを読むこの層は ZIP の中身を知らない)。`plane` は作業平面の id なので、
 * ミラーの `MirrorPlane` と同じくただの文字列として読む(実在するかは解決が見る)。
 */
function readSketchCanvasItem(value: unknown, path: string): Checked<SketchCanvas> {
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
  const plane: Checked<WorkPlaneId> = readString(record.value, 'plane', path);
  if (!plane.ok) {
    return plane;
  }
  const imageId = readString(record.value, 'imageId', path);
  if (!imageId.ok) {
    return imageId;
  }
  const width = readExpression(record.value, 'width', path);
  if (!width.ok) {
    return width;
  }
  const height = readExpression(record.value, 'height', path);
  if (!height.ok) {
    return height;
  }
  const origin = readCoordinate(record.value, 'origin', path);
  if (!origin.ok) {
    return origin;
  }
  const rotation = readExpression(record.value, 'rotation', path);
  if (!rotation.ok) {
    return rotation;
  }
  const opacity = readCanvasOpacity(record.value, 'opacity', path);
  if (!opacity.ok) {
    return opacity;
  }
  const visible = readBoolean(record.value, 'visible', path);
  if (!visible.ok) {
    return visible;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      plane: plane.value,
      imageId: imageId.value,
      width: width.value,
      height: height.value,
      origin: origin.value,
      rotation: rotation.value,
      opacity: opacity.value,
      visible: visible.value,
    },
  };
}

/**
 * 下絵(FR-332)を読む。**版7からは必須**(`selectionSets` とまったく同じ道筋)。
 */
function readCanvases(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly SketchCanvas[]> {
  return readList(record, 'canvases', path, readSketchCanvasItem);
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
  const references = readReferences(record.value, path);
  if (!references.ok) {
    return references;
  }
  const solids = readList(record.value, 'solids', path, readSolidFeature);
  if (!solids.ok) {
    return solids;
  }
  const parameters = readParameters(record.value, path);
  if (!parameters.ok) {
    return parameters;
  }
  const appearance = readAppearanceTable(record.value, path);
  if (!appearance.ok) {
    return appearance;
  }
  const selectionSets = readSelectionSets(record.value, path);
  if (!selectionSets.ok) {
    return selectionSets;
  }
  const canvases = readCanvases(record.value, path);
  if (!canvases.ok) {
    return canvases;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      schemaVersion: schemaVersion.value,
      sketches: sketches.value,
      activeSketchId: activeSketchId.value,
      references: references.value,
      solids: solids.value,
      parameters: parameters.value,
      appearance: appearance.value,
      selectionSets: selectionSets.value,
      canvases: canvases.value,
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
  | {
      readonly ok: true;
      readonly document: PartDocument;
      readonly savedAt: string;
      /**
       * 封筒に書かれていた種別(§0.a-0.35)。部品なら `'part'`、ひな形なら `'partTemplate'`。
       * **中身の読み方は種別で変わらない**ので、ここで返して上の層(タスク27 の
       * 「このファイルはひな形ではありません。」の断り)に判断させる。
       */
      readonly kind: PcadDocumentKind;
      /**
       * 封筒に書かれていた表示の長さの単位(FR-814、§2.10)。**欄が無ければ `undefined`**
       * ——ここではファイルに書いてあったとおりを返し、既定(`'mm'`)で埋めるのは上の層
       * (model の `openTemplate`)の仕事にする。既定値を io と model の両方に置かないため。
       */
      readonly lengthUnit?: LengthUnit;
      /** 封筒に書かれていた道具の既定値(FR-814)。`lengthUnit` と同じく、無ければ `undefined`。 */
      readonly toolDefaults?: PcadToolDefaults;
    }
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

/**
 * 封筒の任意の欄「表示の長さの単位」を読む(FR-814、§2.10。P6 タスク27)。
 *
 * **欄が無いのは不備ではない**(版 7 でも持たないファイルがある)ので `undefined` を返す。
 * 欄があるのに知らない値だったときだけ、他の欄と同じ厳しさで断る(`invalidField`)。
 */
function readEnvelopeLengthUnit(raw: Record<string, unknown>): Checked<LengthUnit | undefined> {
  if (!('lengthUnit' in raw)) {
    return { ok: true, value: undefined };
  }
  return readLiteral<LengthUnit>(raw, 'lengthUnit', '', LENGTH_UNITS);
}

/**
 * 封筒の任意の欄「道具の既定値」を読む(FR-814、§2.10)。`lengthUnit` と同じく、
 * **欄が無ければ `undefined`、あれば 5 欄すべてを厳密に検査する。**
 *
 * 途中まで書かれた `toolDefaults` を「ある分だけ読む」ようにはしない。半端な設定を
 * 黙って受け入れると、どの値が利用者の指定でどれが既定なのかが後から分からなくなる。
 * 知らない欄は読み飛ばす(P12 で欄が増えたひな形を、この版のアプリでも開けるように)。
 */
function readEnvelopeToolDefaults(
  raw: Record<string, unknown>,
): Checked<PcadToolDefaults | undefined> {
  if (!('toolDefaults' in raw)) {
    return { ok: true, value: undefined };
  }
  const record = readRecord(raw, 'toolDefaults', '');
  if (!record.ok) {
    return record;
  }
  const path = 'toolDefaults';
  const extrudeDistance = readString(record.value, 'extrudeDistance', path);
  if (!extrudeDistance.ok) {
    return extrudeDistance;
  }
  const holeDiameter = readString(record.value, 'holeDiameter', path);
  if (!holeDiameter.ok) {
    return holeDiameter;
  }
  const filletRadius = readString(record.value, 'filletRadius', path);
  if (!filletRadius.ok) {
    return filletRadius;
  }
  const chamferDistance = readString(record.value, 'chamferDistance', path);
  if (!chamferDistance.ok) {
    return chamferDistance;
  }
  const circleRadius = readString(record.value, 'circleRadius', path);
  if (!circleRadius.ok) {
    return circleRadius;
  }
  return {
    ok: true,
    value: {
      extrudeDistance: extrudeDistance.value,
      holeDiameter: holeDiameter.value,
      filletRadius: filletRadius.value,
      chamferDistance: chamferDistance.value,
      circleRadius: circleRadius.value,
    },
  };
}

/** 版の判定が済んだ封筒を読む。 */
function readEnvelope(raw: Record<string, unknown>, schema: number): ParseDocumentResult {
  const app = readString(raw, 'app', '');
  if (!app.ok || app.value !== PCAD_APP_NAME) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  // 種別は封筒の欄なので、中身を読む前に見る(統括の決定、要件§8)。
  // 欄そのものが無い・文字列でないものは PointerCAD の封筒になっていないので notPcad、
  // 文字列だが受け入れる一覧(部品とひな形。§0.a-0.35)に無いものは
  // 「PointerCAD のファイルだが、この種類はまだ読めない」と分けて断る。
  const kind = readString(raw, 'kind', '');
  if (!kind.ok) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  if (!isPcadDocumentKind(kind.value)) {
    return fail(
      'unsupportedKind',
      `この形式の種類(${kind.value})にはまだ対応していません。`,
    );
  }
  const savedAt = readString(raw, 'savedAt', '');
  if (!savedAt.ok) {
    return failField(savedAt.problem);
  }
  // ひな形の 2 欄(FR-814、§2.10)。どちらも任意なので、無いこと自体は断りにならない。
  const lengthUnit = readEnvelopeLengthUnit(raw);
  if (!lengthUnit.ok) {
    return failField(lengthUnit.problem);
  }
  const toolDefaults = readEnvelopeToolDefaults(raw);
  if (!toolDefaults.ok) {
    return failField(toolDefaults.problem);
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
  const duplicateConstraintId = findDuplicateConstraintId(decoded.value.sketches);
  if (duplicateConstraintId !== null) {
    return fail(
      'invalidField',
      `拘束の id が文書の中で重なっています(${duplicateConstraintId})。ファイルが壊れている可能性があります。`,
    );
  }
  const duplicateAppearanceId = findDuplicateAppearanceId(decoded.value.appearance);
  if (duplicateAppearanceId !== null) {
    return fail(
      'invalidField',
      `外観の割り当ての id が重なっています(${duplicateAppearanceId})。ファイルが壊れている可能性があります。`,
    );
  }
  const duplicateSelectionSetId = findDuplicateId(
    decoded.value.selectionSets.map((set) => set.id),
  );
  if (duplicateSelectionSetId !== null) {
    return fail(
      'invalidField',
      `選択セットの id が重なっています(${duplicateSelectionSetId})。ファイルが壊れている可能性があります。`,
    );
  }
  const duplicateCanvasId = findDuplicateId(decoded.value.canvases.map((canvas) => canvas.id));
  if (duplicateCanvasId !== null) {
    return fail(
      'invalidField',
      `下絵の id が重なっています(${duplicateCanvasId})。ファイルが壊れている可能性があります。`,
    );
  }
  return {
    ok: true,
    document: decoded.value,
    savedAt: savedAt.value,
    kind: kind.value,
    lengthUnit: lengthUnit.value,
    toolDefaults: toolDefaults.value,
  };
}

/**
 * 封筒の `kind` が受け入れる種別のどれかかを確かめる(§0.a-0.35)。
 * `Array.includes` は引数の型を一覧の型に狭めてしまい `as` が要るので、
 * 自前の型ガードで書く(**`as` / `any` を使わない**)。
 */
function isPcadDocumentKind(value: string): value is PcadDocumentKind {
  for (const candidate of PCAD_DOCUMENT_KINDS) {
    if (candidate === value) {
      return true;
    }
  }
  return false;
}

/**
 * 拘束の `id` は文書の中(複数スケッチをまたいで)重ならないことを確かめる(P4b タスク21の
 * 落とし穴)。重なると一覧と印が混ざるため、見つけたら理由つきで断る。
 */
function findDuplicateConstraintId(sketches: readonly SketchDocument[]): string | null {
  const seen = new Set<string>();
  for (const sketch of sketches) {
    for (const constraint of sketchConstraints(sketch)) {
      if (seen.has(constraint.id)) {
        return constraint.id;
      }
      seen.add(constraint.id);
    }
  }
  return null;
}

/**
 * 外観の割り当ての `id` は表の中で重ならないことを確かめる(FR-1106〜1110、P5 タスク5)。
 * `findDuplicateConstraintId` と同じ理由(重なると「1 つずつ外す」(FR-1110)がどちらを
 * 外すか決まらない。統括の指示により、重複は前方互換の対象にせず `invalidField` で断る)。
 */
function findDuplicateAppearanceId(table: AppearanceTable): string | null {
  const seen = new Set<string>();
  for (const entry of table.entries) {
    if (seen.has(entry.id)) {
      return entry.id;
    }
    seen.add(entry.id);
  }
  return null;
}

/**
 * 選択セット・下絵の `id` が重なっていないことを確かめる(FR-112、FR-332、P6 タスク37・38)。
 * `findDuplicateAppearanceId` とまったく同じ理由(重なると「1 つずつ消す」「名前を変える」が
 * どちらを指すか決まらない)で、**エラーコードは増やさず** `invalidField` で断る。
 */
function findDuplicateId(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      return id;
    }
    seen.add(id);
  }
  return null;
}

/**
 * 移行を試みる前に、封筒の版と文書自身が持つ版が食い違っていないかを確かめる
 * (要件§8、統括の決定④)。移行は封筒の版だけで判定し(このファイル冒頭の決めごと)、
 * `SCHEMA_MIGRATIONS` の各段は `schemaVersion` を無条件に書き換えるため、
 * ここで先に確かめないと版4への移行(P4 タスク31)が移行前の食い違いを握りつぶしてしまう
 * (`readEnvelope` の同種の検査は移行の要らない=封筒が今の版のときにしか通らない)。
 * `document` が record でない、または `schemaVersion` が数でなければ、
 * その不備は通常の欄検査(`readPartDocument`)に断らせるのでここでは何もしない。
 */
function envelopeDocumentVersionMismatch(
  raw: Record<string, unknown>,
  schema: number,
): ParseDocumentResult | null {
  const document = raw['document'];
  if (!isRecord(document)) {
    return null;
  }
  const declared = document['schemaVersion'];
  if (typeof declared !== 'number' || declared === schema) {
    return null;
  }
  return fail(
    'versionMismatch',
    `ファイルの版の記録が食い違っています(封筒 ${String(schema)} / 文書 ${String(declared)})。`,
  );
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
    // 移行先(`SCHEMA_MIGRATIONS[schema.value]`)が無い版(例: 版1)は、この時点では
    // まだ移行を試みないので、文書側の版と比べても意味が無い(必ず unsupportedOldVersion
    // になるべきところを versionMismatch にすり替えない)。移行が実在する版だけ検査する。
    if (SCHEMA_MIGRATIONS[schema.value] !== undefined) {
      const mismatch = envelopeDocumentVersionMismatch(raw, schema.value);
      if (mismatch !== null) {
        return mismatch;
      }
    }
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
