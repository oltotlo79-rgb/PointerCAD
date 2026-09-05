/**
 * 「完全に決まった要素」の見分け(FR-313、利用者の決定②(2026-09-05)、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md タスク22b)。
 *
 * 利用者の決定は「完全に決まった要素だけ色を変える(未決定は既定色のまま)」。
 * ここはその判定だけを持つ純関数で、色そのものは `themeColors.ts` の
 * `--pcad-sketch-constrained`、塗り分けは `buildSketchGeometry.ts` が受け持つ。
 *
 * **判定は「その要素の数が 1 つも動かせないこと」**。材料は model が返す 2 つだけで、
 * 画面の側で拘束を解き直したり自由度を数え直したりしない(同じ計算を 2 か所でしない)。
 *   ① `VariableSet`(`collectVariables`)… どの数が動かせるか。
 *   ② `ConstraintDiagnosis`(`diagnoseConstraints`)… 拘束を差し引いた残りの自由度。
 *
 * **控えめに判定する**(決まっていないものを決まったように見せない)。要素ごとの残り自由度は
 * ヤコビアンの零空間まで見ないと分からないので、ここでは次の 2 つだけを「決まった」とする。
 *   (a) その要素の数が 1 つも変数になっていない(すべて式・固定で書かれている)。
 *   (b) スケッチ全体の残り自由度が 0(`degreesOfFreedom === 0`)。このときは動かせる数が
 *       1 つも残っていないので、変数を持つ要素もすべて決まっている。
 * 逆に「一部の要素だけが拘束で決まり、他は自由」という途中の状態では、決まっている側も
 * 既定色のままになる(見落としはあっても、誤って決まったと見せることはない)。
 */

import type {
  ConstraintDiagnosis,
  SketchDocument,
  SketchFeatureKind,
  VariableSet,
} from '@pointercad/model';

/** 1 つも決まっていないとき。作り直さずに使い回す(参照の同一性を保つ)。 */
export const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/**
 * 自分の数(座標・半径)で形が決まる要素の種類。
 *
 * 矩形・正多角形・長穴・点列・オフセット・複製・投影・断面は、**解決した点が規則から
 * 導かれる**ので `collectVariables` ではすべて `derived`(変数でない)になる。ここへ
 * (a) をそのまま当てると「変数が 1 つも無い = 決まっている」と読めてしまうが、実際には
 * もとの数値(角の座標・間隔・個数)は自由に書き換えられるので、決まったとは言えない。
 * だから**種類で先に外す**。面は点も曲線も生まないので同じく外す。
 */
const SHAPED_BY_OWN_NUMBERS: ReadonlySet<SketchFeatureKind> = new Set<SketchFeatureKind>([
  'point',
  'line',
  'arc',
  'ellipse',
  'spline',
]);

/** その要素の種類が、自分の数で形が決まるものか(上の注釈のとおり)。 */
export function isShapedByOwnNumbers(kind: SketchFeatureKind): boolean {
  return SHAPED_BY_OWN_NUMBERS.has(kind);
}

/** 変数を 1 つでも持っているフィーチャーの id。 */
function featureIdsWithFreeNumbers(variableSet: VariableSet): ReadonlySet<string> {
  const free = new Set<string>();
  for (const variable of variableSet.variables) {
    if (variable.kind === 'radius') {
      free.add(variable.featureId);
      continue;
    }
    // 点の鍵から要素の id を取り出す規約は model の 1 か所(`featureIdOfPointKey`)だが、
    // 別名(`spline-1:start` → `spline-1#0`)は既に正本へ寄せてあるので、ここでは
    // 変数が持っている鍵をそのまま使う。
    free.add(featureIdOfKey(variable.pointKey));
  }
  return free;
}

/**
 * 点の鍵からフィーチャーの id(`line-1:end` → `line-1`、`spline-1#3` → `spline-1`)。
 * model の `featureIdOfPointKey` と同じ規約だが、model を呼ぶために鍵の形を
 * 組み立て直すより、ここで 3 行読むほうが依存が浅い。
 */
function featureIdOfKey(pointKey: string): string {
  const colon = pointKey.indexOf(':');
  const hash = pointKey.indexOf('#');
  if (colon < 0 && hash < 0) {
    return pointKey;
  }
  const separator = colon < 0 ? hash : hash < 0 ? colon : Math.min(colon, hash);
  return pointKey.slice(0, separator);
}

/**
 * 「完全に決まった」要素のフィーチャー id(FR-313、利用者の決定②)。
 *
 * `variableSet` が null(3D スケッチ・作図面が決まらない)のときは空を返す。
 * `diagnosis` が null(拘束が 1 つも無い)でも (a) の判定は働くので、式だけで書いた
 * 線分は拘束を付けなくても「決まった」色になる。
 */
export function fullyConstrainedFeatureIds(
  document: SketchDocument,
  variableSet: VariableSet | null,
  diagnosis: ConstraintDiagnosis | null,
): ReadonlySet<string> {
  if (variableSet === null) {
    return EMPTY_IDS;
  }
  const free = featureIdsWithFreeNumbers(variableSet);
  // 全体の残り自由度が 0 なら、動かせる数は 1 つも残っていない((b) の根拠)。
  const nothingMoves = diagnosis !== null && diagnosis.degreesOfFreedom === 0;
  const decided = new Set<string>();
  for (const feature of document.features) {
    if (!isShapedByOwnNumbers(feature.kind)) {
      continue;
    }
    // 形がまだ決まっていない(解決できなかった)要素は色を変えない。
    if (!variableSet.elementFeatureIds.has(feature.id)) {
      continue;
    }
    if (!free.has(feature.id) || nothingMoves) {
      decided.add(feature.id);
    }
  }
  return decided;
}
