/** 部品 JSON: スケッチ要素の共通欄。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  fieldProblem,
  joinPath,
  readBoolean,
  readString,
} from '../guards.js';
import {
  type WorkPlaneId,
} from '@pointercad/model';

/** スケッチフィーチャーに共通の欄。 */
export interface SketchFeatureBase {
  readonly id: string;
  readonly name: string;
  readonly planeId: WorkPlaneId;
}

export function readSketchFeatureBase(
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

/**
 * 構築線(FR-320)の欄。**版4からは必須**(欠けていれば `missingField`)。
 * 版3以前(スキーマ版は上げなかった、統括の差し戻し 2026-09-04)はこの欄を持たない
 * ファイルもあったが、その寛容さは P4 タスク31(§0.a-0.24)で
 * `schema.ts` の `SCHEMA_MIGRATIONS[3]`(版3→4の移行)へ移した。移行済みの版4データは
 * 必ずこの欄を持つので、ここでは寛容に読まない。書き手(`serializeSketchFeature`)は
 * 常にこの欄を書く。
 */
export function readConstructionFlag(record: Record<string, unknown>, path: string): Checked<boolean> {
  return readBoolean(record, 'construction', path);
}
