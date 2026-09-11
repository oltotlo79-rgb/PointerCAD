/** 部品 JSON: 平面と基準ジオメトリ。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  joinPath,
  readBoolean,
  readExpression,
  readLiteral,
  readRecord,
  readString,
} from '../guards.js';
import {
  readCoordinate,
  readPointReference,
  serializeCoordinate,
  serializePointReference,
} from './coordinates.js';
import {
  type PointAndEdgeSpec,
} from './discriminants.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  readRevolveAxis,
  readSubShapeRefField,
  serializeRevolveAxis,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type PlaneSpec,
  type ReferenceAxisDefinition,
  type ReferenceFeature,
  type ReferenceFeatureKind,
  type ReferencePointDefinition,
} from '@pointercad/model';

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

// ---------------------------------------------------------------------------
// P4(FR-328、FR-329、タスク9)が足す平面の指定と基準ジオメトリの書き出し
// ---------------------------------------------------------------------------

/** 平面の決め方(FR-328)。P5 の切断(FR-432)も同じ型を読み書きする。 */
export function serializePlaneSpec(spec: PlaneSpec): PlaneSpec {
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
export function serializeReferenceFeature(feature: ReferenceFeature): ReferenceFeature {
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

export function readPlaneSpec(
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
export function readReferences(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly ReferenceFeature[]> {
  return readList(record, 'references', path, readReferenceFeature);
}
