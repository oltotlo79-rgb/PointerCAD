/**
 * JSON(unknown)を型へ絞る道具(計画書 docs/plans/P2-ソリッド基礎.md タスク14)。
 *
 * ファイルから読んだ値は何が入っているか分からないので、`as` による強制変換を使わず、
 * 欄を1つずつ検査して型を確かめる(rules/02-禁止事項.md)。
 * 失敗したときは「どこが」「どう駄目か」を返し、利用者へ場所つきの理由を見せられるようにする
 * (FR-504、NFR-UX-5)。
 */

import type { ExtrudeFeature, Vec3 } from '@pointercad/model';

/**
 * 式文字列と評価値の組(FR-202)。@pointercad/expression の `ExpressionValue` と同じ型を、
 * 依存を1つも増やさずに @pointercad/model の型から取り出す
 * (packages/io の依存は @pointercad/model だけ。§0.a-0.2)。
 */
export type ExpressionValueJson = ExtrudeFeature['distance'];

/** 欄が読めなかった理由。欄そのものが無いのか、型が違うのかを分ける。 */
export type FieldReason = 'missing' | 'type';

/** どの欄が読めなかったか。`path` は `document.solids[0].distance.source` のような場所。 */
export interface FieldProblem {
  readonly path: string;
  readonly reason: FieldReason;
}

/** 検査の結果。成功なら絞り込めた値、失敗なら場所つきの理由。 */
export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: FieldProblem };

/** 親の場所と欄の名前をつないで場所を作る。親が空なら欄の名前だけ。 */
export function joinPath(parentPath: string, key: string): string {
  return parentPath === '' ? key : `${parentPath}.${key}`;
}

/** 配列の何番目かを場所に足す。 */
export function indexPath(parentPath: string, index: number): string {
  return `${parentPath}[${String(index)}]`;
}

/** 失敗を作る。どの `Checked<T>` としても返せる。 */
export function fieldProblem(path: string, reason: FieldReason): Checked<never> {
  return { ok: false, problem: { path, reason } };
}

/** JSON のオブジェクト(配列でも null でもないもの)か。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON の配列か。`Array.isArray` はそのままだと中身を `any` にしてしまうので、
 * `unknown` の配列として絞り直す(any を持ち込まないため)。
 */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** 値そのものをオブジェクトとして読む。 */
export function checkRecord(value: unknown, path: string): Checked<Record<string, unknown>> {
  return isRecord(value) ? { ok: true, value } : fieldProblem(path, 'type');
}

/** 欄の値を取り出す。欄が無ければ missing。型は問わない。 */
export function readValue(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<unknown> {
  if (!(key in source)) {
    return fieldProblem(joinPath(parentPath, key), 'missing');
  }
  return { ok: true, value: source[key] };
}

export function readString(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<string> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (typeof found.value !== 'string') {
    return fieldProblem(joinPath(parentPath, key), 'type');
  }
  return { ok: true, value: found.value };
}

export function readNumber(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<number> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (typeof found.value !== 'number') {
    return fieldProblem(joinPath(parentPath, key), 'type');
  }
  return { ok: true, value: found.value };
}

export function readBoolean(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<boolean> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (typeof found.value !== 'boolean') {
    return fieldProblem(joinPath(parentPath, key), 'type');
  }
  return { ok: true, value: found.value };
}

export function readArray(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<readonly unknown[]> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (!isUnknownArray(found.value)) {
    return fieldProblem(joinPath(parentPath, key), 'type');
  }
  return { ok: true, value: found.value };
}

export function readRecord(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<Record<string, unknown>> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return checkRecord(found.value, joinPath(parentPath, key));
}

/**
 * 決められた文字列のどれかとして読む(`kind` や `mode` の判別に使う)。
 * 一致するものが無ければ型違いとして断るので、知らない種類のフィーチャーは読み込まれない。
 */
export function readLiteral<T extends string>(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
  allowed: readonly T[],
): Checked<T> {
  const text = readString(source, key, parentPath);
  if (!text.ok) {
    return text;
  }
  for (const candidate of allowed) {
    if (candidate === text.value) {
      return { ok: true, value: candidate };
    }
  }
  return fieldProblem(joinPath(parentPath, key), 'type');
}

/**
 * 式文字列と評価値の組を読む(FR-202)。`source` / `value` / `display` の3つが揃っていなければ断る。
 *
 * ただし `value` が数値でないときだけは断らず、`source` を保ったまま `NaN` として読み込む。
 * こうしておくと、変数表が未定義などで評価値が壊れたファイルでも開けて、解決の段で
 * `invalidValue` として利用者へ知らせられる(FR-504。読み込みでファイルを失わせない)。
 * `NaN` は JSON に書けないため、書き出すと `null` になり、読み戻すとまた `NaN` になる。
 */
export function readExpression(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ExpressionValueJson> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readExpressionItem(found.value, joinPath(parentPath, key));
}

/**
 * 式文字列と評価値の組を**値そのものから**読む(`readVec3Item` / `readVec3` と同じ、
 * 値用と欄用の組)。配列の要素が式のとき(アセンブリの配置の位置 3 数、P7 §2.2)に使う。
 * 読み方の決めごとは 1 か所だけにしたいので、欄用の `readExpression` はこれを呼ぶ。
 */
export function readExpressionItem(item: unknown, path: string): Checked<ExpressionValueJson> {
  const record = checkRecord(item, path);
  if (!record.ok) {
    return record;
  }
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
  const value = typeof found.value === 'number' ? found.value : Number.NaN;
  return { ok: true, value: { source: text.value, value, display: display.value } };
}

/**
 * 3次元ベクトル(mm)を読む(P3、部分形状の指紋の位置・軸)。長さ3の配列で、
 * 3つとも数値でなければ断る。`readVec3` は欄から、`readVec3Item` は値そのものから読む
 * (`readFaceRef` / `readFaceRefItem` と同じ、欄用と値用の組)。
 */
export function readVec3Item(value: unknown, path: string): Checked<Vec3> {
  if (!isUnknownArray(value) || value.length !== 3) {
    return fieldProblem(path, 'type');
  }
  const x = value[0];
  const y = value[1];
  const z = value[2];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    return fieldProblem(path, 'type');
  }
  return { ok: true, value: [x, y, z] };
}

export function readVec3(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<Vec3> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readVec3Item(found.value, joinPath(parentPath, key));
}

/**
 * 無い(null)ことがある3次元ベクトルを読む(面・辺の指紋の `axis`。自由曲面や楕円には軸が無い)。
 * JSON の `null` はそのまま `null` として読み、`undefined` にはしない。
 */
export function readOptionalVec3(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<Vec3 | null> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return { ok: true, value: null };
  }
  return readVec3Item(found.value, joinPath(parentPath, key));
}

/** 無い(null)ことがある数値を読む(面・辺の指紋の `radius`。円柱・円でなければ無い)。 */
export function readOptionalNumber(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<number | null> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return { ok: true, value: null };
  }
  if (typeof found.value !== 'number') {
    return fieldProblem(joinPath(parentPath, key), 'type');
  }
  return { ok: true, value: found.value };
}
