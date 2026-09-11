/** 部品 JSON: 形状の参照と指紋。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  joinPath,
  readLiteral,
  readNumber,
  readOptionalNumber,
  readOptionalVec3,
  readRecord,
  readString,
  readValue,
  readVec3,
} from '../guards.js';
import {
  WORLD_AXES,
} from './discriminants.js';
import {
  readList,
  readStringItem,
  serializeOptionalVec3,
  serializeVec3,
} from './fields.js';
import {
  type EdgeCurveKind,
  type FaceSurfaceKind,
  type RevolveAxis,
  type SketchCurveRef,
  type SketchElementRef,
  type SketchFaceRef,
  type SketchLineRef,
  type SketchPointRef,
  type SubShapeFingerprint,
  type SubShapeKind,
  type SubShapeRef,
} from '@pointercad/model';

const REVOLVE_AXIS_KINDS: readonly RevolveAxis['kind'][] = ['world', 'line', 'reference'];

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

/** 点列の中の 1 点を指すときだけ index を書く(無い欄は書かない)。 */
export function serializeElementRef(reference: SketchElementRef): SketchElementRef {
  return reference.index === undefined
    ? { featureId: reference.featureId }
    : { featureId: reference.featureId, index: reference.index };
}

export function serializeFaceRef(reference: SketchFaceRef): SketchFaceRef {
  return { sketchId: reference.sketchId, faceFeatureId: reference.faceFeatureId };
}

export function serializeLineRef(reference: SketchLineRef): SketchLineRef {
  return { sketchId: reference.sketchId, lineFeatureId: reference.lineFeatureId };
}

export function serializeRevolveAxis(axis: RevolveAxis): RevolveAxis {
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

export function serializePointRef(reference: SketchPointRef): SketchPointRef {
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

export function serializeSubShapeRef(reference: SubShapeRef): SubShapeRef {
  return {
    bodyFeatureId: reference.bodyFeatureId,
    index: reference.index,
    fingerprint: serializeSubShapeFingerprint(reference.fingerprint),
  };
}

/** スケッチの曲線の並びへの参照(P5 タスク43)。id の配列は写して持つ。 */
export function serializeCurveRef(reference: SketchCurveRef): SketchCurveRef {
  return { sketchId: reference.sketchId, curveIds: [...reference.curveIds] };
}

export function readElementRef(value: unknown, path: string): Checked<SketchElementRef> {
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

export function readFaceRef(
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

export function readFaceRefItem(value: unknown, path: string): Checked<SketchFaceRef> {
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

export function readRevolveAxis(
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
export function readPointRef(value: unknown, path: string): Checked<SketchPointRef> {
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

export function readPointRefField(
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
export function readSubShapeRef(value: unknown, path: string): Checked<SubShapeRef> {
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

export function readSubShapeRefField(
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

export function readCurveRef(
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

export function readCurveRefItem(value: unknown, path: string): Checked<SketchCurveRef> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  return readCurveRefRecord(record.value, path);
}

/** 無い(null)ことがある軸(移動/回転の回転軸)。 */
export function readOptionalRevolveAxis(
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
