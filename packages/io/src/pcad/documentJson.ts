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
  type CoordinateInput,
  type PartDocument,
  type PointReference,
  type RevolveAxis,
  type SketchDocument,
  type SketchElementRef,
  type SketchFaceRef,
  type SketchFeature,
  type SketchLineRef,
  type SolidFeature,
  type SolidFeatureKind,
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
  readRecord,
  readString,
  readValue,
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
];
/**
 * いま `.pcad` から読める立体の種類。
 *
 * P3 のタスク13 で `SolidFeatureKind` に加工フィーチャー(穴・ねじ穴・R 面取り・C 面取り・
 * パターン)とばねが増えたが、読み書きの実装はタスク19 でまとめて入れる。それまでは
 * 版2 までの4種類だけを受け付け、知らない種類の `kind` は `readLiteral` が
 * 「その欄の型が違う」として断る(新しい欄の解釈を推測しないため)。
 * `Extract` で `SolidFeatureKind` から取り出すので、model 側で名前が変われば型検査で落ちる。
 */
type StoredSolidFeatureKind = Extract<
  SolidFeatureKind,
  'extrude' | 'revolve' | 'sew' | 'boolean'
>;
const SOLID_FEATURE_KINDS: readonly StoredSolidFeatureKind[] = [
  'extrude',
  'revolve',
  'sew',
  'boolean',
];
const REVOLVE_AXIS_KINDS: readonly RevolveAxis['kind'][] = ['world', 'line'];
type WorldRevolveAxis = Extract<RevolveAxis, { readonly kind: 'world' }>;
const WORLD_AXES: readonly WorldRevolveAxis['axis'][] = ['x', 'y', 'z'];
const BOOLEAN_OPERATIONS: readonly BooleanOperation[] = ['union', 'subtract', 'intersect'];

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
      };
    case 'pointArray':
      return {
        id: feature.id,
        kind: 'pointArray',
        name: feature.name,
        planeId: feature.planeId,
        base: serializeCoordinate(feature.base),
        azimuth: serializeExpression(feature.azimuth),
        spacing: serializeExpression(feature.spacing),
        count: serializeExpression(feature.count),
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
    case 'threadHole':
    case 'fillet':
    case 'chamfer':
    case 'pattern':
    case 'spring':
      // P3 タスク13 で文書の型だけが先に増えたための暫定。欄を決まった順で組み立て直すのは
      // タスク19 の担当なので、それまでは受け取ったものをそのまま返して欄を落とさない。
      // 読み込み側(SOLID_FEATURE_KINDS)はこの6種類をまだ受け付けないため、
      // この状態では「書けても読めない」。**タスク19 がこの節を必ず置き換える。**
      // 画面からこれらのフィーチャーを作れるようになるのはタスク25 以降なので、
      // それまで実際の文書にこの種類が入ることはない。
      return feature;
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

function readCoordinate(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<CoordinateInput> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const mode = readLiteral(record.value, 'mode', path, COORDINATE_MODES);
  if (!mode.ok) {
    return mode;
  }
  switch (mode.value) {
    case 'absolute':
      return readAbsoluteCoordinate(record.value, path);
    case 'relative':
      return readRelativeCoordinate(record.value, path);
    case 'polar':
      return readPolarCoordinate(record.value, path);
  }
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
  }
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
  return { ok: true, value: { ...base, kind: 'line', from: from.value, to: to.value } };
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
  return {
    ok: true,
    value: {
      ...base,
      kind: 'arc',
      center: center.value,
      radius: radius.value,
      startAngle: startAngle.value,
      endAngle: endAngle.value,
    },
  };
}

function readPointArrayFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const arrayBase = readCoordinate(record, 'base', path);
  if (!arrayBase.ok) {
    return arrayBase;
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
      ...base,
      kind: 'pointArray',
      base: arrayBase.value,
      azimuth: azimuth.value,
      spacing: spacing.value,
      count: count.value,
    },
  };
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
