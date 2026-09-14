import { parseDisplayInput, type LengthUnit } from '@pointercad/model';

export type FieldUnit = 'mm' | 'degree' | 'count' | 'ratio' | 'N' | 'MPa' | 'Nmm';

/**
 * **どの欄が長さかを決める唯一の表**(P6 タスク3b、FR-811・FR-814・FR-205)。
 *
 * 欄ごとに「これは長さ」と書き分けず、欄の定義がすでに持っている `unit` 1 本で決める。
 * 角度(`degree`)・回数や個数(`count`)は長さではないので、表示の単位(mm / inch)の
 * 影響を 1 つも受けない(FR-205)。`switch` に `default` を書かないので、欄の単位が
 * 増えたら型検査で落ちて、この表を直し忘れられない。
 *
 * model 側にも同じ形の判定(`isLengthParameterUnit`、パラメータの単位 `mm|degree|none`)が
 * あるが、あちらが見るのは**パラメータ表の単位**、こちらは**ポップアップの欄の単位**で、
 * 型そのものが違う(`count` はパラメータには無い)。同じ規則の重複ではない。
 */
export function isLengthFieldUnit(unit: FieldUnit): boolean {
  switch (unit) {
    case 'mm':
      return true;
    case 'degree':
    case 'N':
    case 'MPa':
    case 'Nmm':
    case 'count':
    case 'ratio':
      return false;
  }
}

/**
 * 打たれた文字列を、**保存する式の文字列**へ直す(§0.a-0.63、§2.9.1 ②)。
 *
 * 長さの欄のときだけ model の `parseDisplayInput` へ回す(表示が inch で単位が 1 つも
 * 書かれていなければ `(<打った式>)in` で包む。mm のときは包まない)。**規則そのものは
 * model の 1 か所にしかない**——ここへ写すと「どの綴りが単位か」の判定が ui と model で
 * 食い違うため、この関数は「長さの欄かどうか」を足すだけの薄い層にしてある。
 *
 * 長さでない欄(角度・個数)は打った文字をそのまま返す。引用符の正規化(`3/8”` → `3/8"`)も
 * かけない——角度の欄に inch の記号が入る余地を作らないため。
 */
export function applyDisplayUnit(source: string, fieldUnit: FieldUnit, unit: LengthUnit): string {
  return isLengthFieldUnit(fieldUnit) ? parseDisplayInput(source, unit) : source;
}
