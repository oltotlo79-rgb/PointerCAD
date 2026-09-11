/** 部品 JSON: スケッチ拘束。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  joinPath,
  readExpression,
  readLiteral,
  readString,
  readValue,
} from '../guards.js';
import {
  VERTEX_NAMES,
} from './discriminants.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  readElementRef,
  serializeElementRef,
} from './shapeReferences.js';
import {
  type ConstraintTarget,
  SKETCH_CONSTRAINT_KINDS,
  type SketchConstraint,
} from '@pointercad/model';

/**
 * 拘束が指す先の種類(FR-313、P4b タスク21)。`ConstraintTarget['vertex']` は
 * `PointReference` の同名の欄と同じ3値なので `VERTEX_NAMES` をそのまま使い回す
 * (同じ一覧を2か所に書かない)。
 */
const CONSTRAINT_TARGET_KINDS: readonly ConstraintTarget['kind'][] = ['point', 'vertex', 'curve'];

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
export function serializeConstraint(constraint: SketchConstraint): SketchConstraint {
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
export function readSketchConstraintsField(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly SketchConstraint[] | null> {
  if (!('constraints' in record)) {
    return { ok: true, value: null };
  }
  return readList(record, 'constraints', path, readConstraint);
}
