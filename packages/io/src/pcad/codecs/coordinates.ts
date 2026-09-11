/** 部品 JSON: 座標と点の参照。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  joinPath,
  readExpression,
  readLiteral,
  readRecord,
  readString,
} from '../guards.js';
import {
  VERTEX_NAMES,
} from './discriminants.js';
import {
  serializeExpression,
} from './fields.js';
import {
  readSubShapeRefField,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type CoordinateInput,
  type FreeArcOrientation,
  type PointReference,
} from '@pointercad/model';

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

export function serializePointReference(reference: PointReference): PointReference {
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

export function serializeCoordinate(input: CoordinateInput): CoordinateInput {
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
export function serializeFreeOrientation(orientation: FreeArcOrientation): FreeArcOrientation {
  return {
    normal: serializeCoordinate(orientation.normal),
    xAxis: serializeCoordinate(orientation.xAxis),
  };
}

export function readPointReference(
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
export function readPointReferenceItem(value: unknown, path: string): Checked<PointReference> {
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

export function readCoordinate(
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
export function readCoordinateItem(value: unknown, path: string): Checked<CoordinateInput> {
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
export function readFreeOrientation(
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
