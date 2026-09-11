/** 部品 JSON: 式・ベクトル・省略可能な欄の共通変換。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  type ExpressionValueJson,
  fieldProblem,
  indexPath,
  joinPath,
  readArray,
  readBoolean,
  readExpression,
  readLiteral,
  readNumber,
  readString,
  readValue,
} from '../guards.js';
import {
  type Vec3,
} from '@pointercad/model';

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

/*
  以下、`export` が付いている小さな変換は**アセンブリの読み書き**(`assemblyJson.ts`、
  P7 タスク3)からも呼ぶ(式・パラメータ・部分形状の参照・軸・外観・一覧の読み方・
  版の持ち上げ)。

  アセンブリ文書は部品文書とはまったく別の型だが、**その中に入っている部品と共通の値**
  (`ExpressionValue`・`Parameter`・`SubShapeRef`・`AxisSpec`・`AppearanceSpec`)は
  同じ書式で保存する。**同じ変換を 2 か所に書かない**ため、ここを正本にして輸出する
  (書き写すと、片方だけ直したときに同じファイルの中で書式が食い違う)。
  輸出にあたって足したのは `export` の 1 語だけで、中身は 1 行も変えていない。
*/

/**
 * 式は必ず式文字列と一緒に保存する(FR-202)。評価値と表示も保存するのは、変数表が
 * 未定義でもツリーに数値を出せるようにするため。評価値が NaN のときは JSON に NaN を
 * 書けないので `null` になり、読み戻すとまた NaN になる。
 */
export function serializeExpression(value: ExpressionValueJson): ExpressionValueJson {
  return { source: value.source, value: value.value, display: value.display };
}

// ---------------------------------------------------------------------------
// P3(§2.2、§2.6、§2.7、§2.7b、タスク19)が足す部分形状の参照と加工の欄
// ---------------------------------------------------------------------------

export function serializeVec3(vector: Vec3): Vec3 {
  return [vector[0], vector[1], vector[2]];
}

/** 無い(null)ことがあるベクトルを書き出す。`undefined` にはせず、常に欄を持つ。 */
export function serializeOptionalVec3(vector: Vec3 | null): Vec3 | null {
  return vector === null ? null : serializeVec3(vector);
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

/** 配列の要素を1つずつ読む。1つでも読めなければ、その場所を添えて全体を断る。 */
export function readList<T>(
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

/** 欄が無ければ `undefined`、あれば式として読む(P5 タスク43 の省略できる式の欄)。 */
export function readOptionalExpression(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<ExpressionValueJson | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readExpression(record, key, path);
}

/**
 * 欄が無ければ `undefined`、`null` なら `null`、あれば式として読む
 * (薄板押し出しの厚み。FR-416。**`null` は「中実」という意味を持つ値**なので保つ)。
 */
export function readNullableExpression(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<ExpressionValueJson | null | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  const found = readValue(record, key, path);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return { ok: true, value: null };
  }
  return readExpression(record, key, path);
}

/** 欄が無ければ `undefined`、あれば真偽として読む(P5 タスク43 の省略できるつまみ)。 */
export function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<boolean | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readBoolean(record, key, path);
}

/** 欄が無ければ `undefined`、あれば決められた文字列として読む(P5 タスク43)。 */
export function readOptionalLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): Checked<T | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readLiteral(record, key, path, allowed);
}

/**
 * 欄が無ければ `undefined`、あれば文字列として読む(読み込んだ形の `importedAt`、
 * P6 タスク20)。**`null` は受け付けない**——省略と `null` を別の意味にしないため。
 */
export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<string | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readString(record, key, path);
}

/**
 * 欄が無ければ `undefined`、あれば数として読む(読み込んだ三角形の形の `volume`、
 * P6 タスク20)。指紋の `radius` を読む `readOptionalNumber`(guards.ts)とは別物で、
 * あちらは**欄があって `null`** を許す(「円柱でないので半径が無い」の意味を持つ null)。
 */
export function readOptionalNumberField(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<number | undefined> {
  if (!(key in record)) {
    return { ok: true, value: undefined };
  }
  return readNumber(record, key, path);
}

/** 文字列 1 件(id の一覧に使う)。 */
export function readStringItem(value: unknown, path: string): Checked<string> {
  if (typeof value !== 'string') {
    return fieldProblem(path, 'type');
  }
  return { ok: true, value };
}

/** 式 1 件(一覧に使う)。 */
export function readExpressionItem(value: unknown, path: string): Checked<ExpressionValueJson> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  // `readExpression` は親のレコードと欄名で受け取る形なので、1 欄だけの入れ物に包む。
  // 断りの位置は包む前の `path` のままにしたいので、欄名は同じ `path` の下に付かない。
  const text = readString(record.value, 'source', path);
  if (!text.ok) {
    return text;
  }
  const display = readString(record.value, 'display', path);
  if (!display.ok) {
    return display;
  }
  const found = readValue(record.value, 'value', path);
  if (!found.ok) {
    return found;
  }
  // 数でない `value` は NaN として読む(`readExpression` と同じ扱い。FR-504)。
  const number = typeof found.value === 'number' ? found.value : Number.NaN;
  return { ok: true, value: { source: text.value, value: number, display: display.value } };
}

/** 文字列か `null`(切断の `pairedWith`)。欄が無い・別の型なら断る。 */
export function readNullableString(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<string | null> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return { ok: true, value: null };
  }
  return readString(source, key, parentPath);
}

/**
 * 決まった文字列のどれかとして読むが、`readLiteral` と違い**一致しなくても断らない**
 * (`{ ok: true, value: null }` を返す)。将来プリセット・柄・樹種が増えても、古い版の
 * アプリで新しい文書を(部分的に)開けるようにするための前方互換の道具
 * (計画書 P5-高度なソリッド・外観と測定.md タスク5「未知のプリセット id / 柄の種類は、
 * その割り当てを落として読み進める」)。欄そのものが無い・文字列でない場合は通常どおり断る。
 */
export function readKnownLiteralOrNull<T extends string>(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
  allowed: readonly T[],
): Checked<T | null> {
  const text = readString(source, key, parentPath);
  if (!text.ok) {
    return text;
  }
  for (const candidate of allowed) {
    if (candidate === text.value) {
      return { ok: true, value: candidate };
    }
  }
  return { ok: true, value: null };
}
