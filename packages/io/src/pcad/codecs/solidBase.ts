/** 部品 JSON: 立体フィーチャーの共通欄。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  readBoolean,
  readString,
} from '../guards.js';

/** ソリッドフィーチャーに共通の欄。 */
export interface SolidFeatureBase {
  readonly id: string;
  readonly name: string;
  readonly suppressed: boolean;
}

export function readSolidFeatureBase(
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
