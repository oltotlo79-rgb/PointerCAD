/** 部品 JSON: パラメータ表。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  readExpression,
  readLiteral,
  readString,
} from '../guards.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  type Parameter,
  PARAMETER_UNITS,
  type ParameterUnit,
} from '@pointercad/model';

/**
 * パラメータ表の1行(FR-207、P4b タスク2・タスク21)。欄を決まった順で組み立てて決定性を保つ。
 * 並び順(利用者が並べ替えた順)は呼び出し側の `document.parameters.map` がそのまま保つ
 * (§2.6「表の並び順を評価順で上書きしない」)。
 */
export function serializeParameter(parameter: Parameter): Parameter {
  return {
    name: parameter.name,
    value: serializeExpression(parameter.value),
    unit: parameter.unit,
    description: parameter.description,
  };
}

/** パラメータ表の1行(FR-207、P4b タスク21)を読む。単位は `PARAMETER_UNITS` を網羅表にする。 */
export function readParameter(value: unknown, path: string): Checked<Parameter> {
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
export function readParameters(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly Parameter[]> {
  return readList(record, 'parameters', path, readParameter);
}
