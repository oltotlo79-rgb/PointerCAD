/** 部品 JSON: サーフェス加工。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  joinPath,
  readBoolean,
  readExpression,
  readLiteral,
  readRecord,
  readString,
} from '../guards.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  readCurveRef,
  readCurveRefItem,
  readRevolveAxis,
  readSubShapeRefField,
  serializeCurveRef,
  serializeRevolveAxis,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type SolidFeatureBase,
} from './solidBase.js';
import {
  type SolidFeature,
  type SurfaceOperation,
} from '@pointercad/model';

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

/** 曲面(FR-428)を読む。作り方 5 種で欄が違う。 */
export function readSurfaceFeature(
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

/** surface の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeSurfaceFeature(feature: Extract<SolidFeature, { readonly kind: 'surface' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'surface',
    name: feature.name,
    suppressed: feature.suppressed,
    operation: serializeSurfaceOperation(feature.operation),
  };
}
