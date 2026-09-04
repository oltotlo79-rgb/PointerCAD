/**
 * 拘束を解いてから解決し直す 3 段の入口(FR-313、FR-504、NFR-RE-1、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md §2.2、タスク8)。
 *
 * ```
 * ① resolveSketch(document)                     拘束を無視した解決 = ソルバーの初期値
 * ② 変数を切り出す → Levenberg–Marquardt で解く → 診断する
 * ③ resolveSketch(document, { pointOverrides, radiusOverrides })   解を差し込んで解決し直す
 * ```
 *
 * ①③は同じ純関数、②も純関数(乱数・時刻・DOM に触れない)なので、**同じ文書からは
 * 必ず同じ形**になる(決定性。§2.2)。
 *
 * **文書は書き換えない。** 解いた座標は `.pcad` へ保存せず(§0.a-0.4「導出できるものは
 * 保存しない」)、開き直すたびに同じ拘束から同じ形へ解き直す。式で書かれた座標は
 * そもそも変数にならない(§0.a-0.2)ので、式を壊すこともない。書き戻すのは利用者が
 * 要素を引っぱったときだけで、それはタスク14 が `solution` を読んで行う。
 *
 * **拘束が 1 つも無ければ `resolveSketch` を 1 回呼ぶだけ**にして、拘束を使わない
 * 既存の文書の解決の結果も所要も変えない(§2.2 の落とし穴「解決が約 2 倍になる」)。
 */

import {
  baseWorkPlane,
  isFreeWorkPlaneId,
  planeToWorld,
  type WorkPlane,
  type WorkPlaneId,
} from '../planeMath.js';
import { resolveSketch, type SketchResolveOptions } from '../resolveSketch.js';
import type { ResolvedSketch, SketchDocument, SketchError } from '../types.js';
import type { Vec3 } from '../vec3.js';
import { diagnoseConstraints, type ConstraintDiagnosis } from './diagnose.js';
import { buildResiduals } from './residuals.js';
import {
  solveLevenbergMarquardt,
  type LinearizedRow,
  type SolveOptions,
  type SolveOutcome,
} from './solve.js';
import { sketchConstraints, type SketchConstraint } from './types.js';
import {
  collectVariables,
  MAX_CONSTRAINT_VARIABLES,
  pointValueAt,
  radiusComponentKey,
  type VariableSet,
} from './variables.js';

/**
 * 3D スケッチ(作図面を持たないスケッチ、FR-330)に拘束が付いていたときの断り
 * (§0.a-0.3)。水平・垂直・平行・直角は平面の中でしか意味が決まらないため。
 */
export const CONSTRAINT_FREE_SKETCH_MESSAGE =
  '3D スケッチには拘束を付けられません。作図面の上のスケッチで使ってください。';

/** 反復を使い切っても残差が残り、原因の拘束を絞り込めなかったときの断り。 */
export const CONSTRAINT_UNSOLVED_MESSAGE =
  '拘束を満たす形が見つかりませんでした。拘束をいくつか外して試してください。';

/** 解かなかったときに返す空の表(呼ぶたびに作らない)。 */
const NO_POINTS: ReadonlyMap<string, Vec3> = new Map<string, Vec3>();
const NO_RADII: ReadonlyMap<string, number> = new Map<string, number>();

/** 3 段の解決の結果(§2.2、タスク8)。 */
export interface ConstrainedSketch {
  /** ③の解決結果。拘束が無い・解かないときは①の結果(形は描いたまま。FR-504)。 */
  readonly resolved: ResolvedSketch;
  /**
   * 拘束の診断(自由度・足しすぎ・矛盾)。**拘束が 1 つも無いスケッチと、作図面を
   * 持たないスケッチでは `null`**(変数を切り出す計算そのものを行わないため。
   * 計画書の型は非 null だが、「拘束 0 個なら余分な計算をしない」という同じ節の要求と
   * 両立しないので `null` を許した。呼ぶ側は「診断していない」と読む)。
   */
  readonly diagnosis: ConstraintDiagnosis | null;
  /** 拘束の失敗。`resolved.errors` とは別に持ち、呼び出し側が両方を並べる(FR-504)。 */
  readonly errors: readonly SketchError[];
  /**
   * 解けた点の位置(ワールド座標)。鍵は `ResolvedPoint.id` / `vertexKey` の規約。
   * ③へ渡した上書き表そのもので、ドラッグの確定(タスク14)がここから座標を読む。
   */
  readonly solution: ReadonlyMap<string, Vec3>;
  /**
   * 解けた半径。鍵は `radiusComponentKey`(円弧は `featureId.r`、楕円は `.rmajor` / `.rminor`)。
   * 計画書は「鍵は featureId」と書いているが、楕円は 1 フィーチャーに半径が 2 つあり
   * featureId だけでは区別できないので、`variables.ts` の既存の鍵の規約へ寄せた。
   */
  readonly radiusSolution: ReadonlyMap<string, number>;
  /**
   * 切り出した変数。**動かせない点の理由**(`frozen`)を画面が出すのに使い(タスク13)、
   * 引っぱれるかの判定(タスク14 の `draggableAt`)もこれを読む。解かなかったときは null。
   */
  readonly variableSet: VariableSet | null;
  /** 反復の結果(収束したか、何回回ったか)。解かなかったときは null。 */
  readonly outcome: SolveOutcome | null;
}

/**
 * このスケッチの作図面(§0.a-0.3)。
 *
 * `SketchDocument` は面を 1 つだけ持つのではなく、フィーチャーがそれぞれ `planeId` を
 * 持つので、**履歴の中で最初に見つかった作図面つきのフィーチャーの面**をスケッチの面と
 * みなす。別の作図面を指すフィーチャーは `collectVariables` が定数として読む(動かさない)。
 * すべてが 3D スケッチ(`FREE_WORK_PLANE_ID`)なら null。
 */
function sketchWorkPlane(
  document: SketchDocument,
  lookup: (planeId: WorkPlaneId) => WorkPlane | null,
): WorkPlane | null {
  for (const feature of document.features) {
    if (isFreeWorkPlaneId(feature.planeId)) {
      continue;
    }
    const plane = lookup(feature.planeId);
    if (plane !== null) {
      return plane;
    }
  }
  return null;
}

/** 解けた x を、③へ渡す上書き表(点はワールド座標、半径は数)へ直す。 */
function buildOverrides(
  variableSet: VariableSet,
  x: readonly number[],
  plane: WorkPlane,
): {
  readonly pointOverrides: ReadonlyMap<string, Vec3>;
  readonly radiusOverrides: ReadonlyMap<string, number>;
} {
  const pointOverrides = new Map<string, Vec3>();
  const radiusOverrides = new Map<string, number>();
  variableSet.variables.forEach((variable, column) => {
    if (variable.kind === 'radius') {
      radiusOverrides.set(radiusComponentKey(variable.featureId, variable.radiusKind), x[column]);
      return;
    }
    if (variable.kind === 'v') {
      // 点は u の列で 1 度だけ組み立てる(u と v は必ず対で変数になる)。
      return;
    }
    const uv = pointValueAt(variableSet, x, variable.pointKey);
    if (uv !== null) {
      pointOverrides.set(variable.pointKey, planeToWorld(plane, uv[0], uv[1]));
    }
  });
  return { pointOverrides, radiusOverrides };
}

/** スケッチ全体に関わる断りを 1 件作る。指す先は文書の id にする。 */
function sketchError(
  documentId: string,
  code: SketchError['code'],
  message: string,
): SketchError {
  return { featureId: documentId, code, message };
}

/**
 * 診断と反復の結果を、画面へそのまま出せる断りへ直す(FR-504、NFR-RE-1)。
 *
 * - 多すぎる: 解かずに断る 1 件。
 * - 矛盾: **1 件にまとめる**(帯には 1 文しか出せないため。内訳は `diagnosis.conflictDetails`)。
 * - 収束しないが原因を絞り込めない: 1 件。
 * - 材料が足りない・縮退で式を作れなかった拘束: 1 件ずつ(どれが効いていないかを指す)。
 *
 * **足しすぎ(冗長)は断りにしない。** 形は正しく解けているので操作を妨げる理由が無く、
 * 「付けすぎの拘束が N 件あります」は `diagnosis.summary` / `messages` から帯へ出す。
 */
function constraintErrors(
  documentId: string,
  diagnosis: ConstraintDiagnosis,
  outcome: SolveOutcome | null,
): readonly SketchError[] {
  if (diagnosis.tooMany) {
    return [sketchError(documentId, 'constraintTooMany', diagnosis.summary)];
  }
  const errors: SketchError[] = [];
  if (diagnosis.conflictDetails.length > 0) {
    // 同じ文が相手の側にも入っているので、重複を除いてから並べる。
    const sentences: string[] = [];
    for (const detail of diagnosis.conflictDetails) {
      if (!sentences.includes(detail.message)) {
        sentences.push(detail.message);
      }
    }
    errors.push({
      featureId: diagnosis.conflictDetails[0].constraintId,
      code: 'constraintConflict',
      message: sentences.join(''),
    });
  } else if (outcome !== null && !outcome.converged) {
    errors.push(sketchError(documentId, 'constraintUnsolved', CONSTRAINT_UNSOLVED_MESSAGE));
  }
  for (const skipped of diagnosis.skipped) {
    errors.push({
      featureId: skipped.constraintId,
      code: 'constraintUnsolved',
      message: skipped.message,
    });
  }
  return errors;
}

/** 解かずに①の形のまま返す。 */
function unsolved(
  resolved: ResolvedSketch,
  errors: readonly SketchError[],
  diagnosis: ConstraintDiagnosis | null,
  variableSet: VariableSet | null,
): ConstrainedSketch {
  return {
    resolved,
    diagnosis,
    errors,
    solution: NO_POINTS,
    radiusSolution: NO_RADII,
    variableSet,
    outcome: null,
  };
}

/**
 * 3 段の解決の入口(§2.2)。**例外を投げない**(FR-504、NFR-RE-1)。
 *
 * `options` はそのまま①③の `resolveSketch` へ渡すので、作業平面・立体の部分形状・
 * オフセット・投影の受け渡しは拘束の有無で変わらない。
 * `solveOptions` は反復の上限と許容量の差し替え(既定は `constraints/solve.ts` の
 * `CONSTRAINT_*`)で、診断の許容量も同じ値に揃える。
 */
export function resolveConstrainedSketch(
  document: SketchDocument,
  options: SketchResolveOptions = {},
  solveOptions?: SolveOptions,
): ConstrainedSketch {
  // ① 拘束を無視した解決。ソルバーの初期値であり、解かないときの答えでもある。
  const base = resolveSketch(document, options);
  const constraints: readonly SketchConstraint[] = sketchConstraints(document);
  if (constraints.length === 0) {
    return unsolved(base, [], null, null);
  }

  const lookup = options.workPlane ?? baseWorkPlane;
  const plane = sketchWorkPlane(document, lookup);
  if (plane === null) {
    return unsolved(
      base,
      [sketchError(document.id, 'constraintUnsolved', CONSTRAINT_FREE_SKETCH_MESSAGE)],
      null,
      null,
    );
  }

  // ② 変数を切り出す。多すぎるときは解かずに断る(NFR-PF-2 を守るため。§2.2)。
  const variableSet = collectVariables(document, base, plane);
  if (variableSet.variables.length > MAX_CONSTRAINT_VARIABLES) {
    const diagnosis = diagnoseConstraints(constraints, variableSet, variableSet.initial);
    return unsolved(base, constraintErrors(document.id, diagnosis, null), diagnosis, variableSet);
  }

  const evaluate = (x: readonly number[]): readonly LinearizedRow[] =>
    buildResiduals(constraints, variableSet, x);
  const outcome = solveLevenbergMarquardt(variableSet.initial, evaluate, solveOptions);
  // 診断には**解いた後の x** を渡す。初期値のままだと、解けば消える残差を
  // 「矛盾」と読み違える(タスク7 の申し送り)。
  const diagnosis = diagnoseConstraints(constraints, variableSet, outcome.x, {
    tolerance: solveOptions?.tolerance,
  });

  // ③ 解を差し込んで解決し直す。収束しなかったときも**最後に得られた x** で上書きし、
  // 形は最も近い状態で描く(FR-504「止めずに警告する」)。
  const { pointOverrides, radiusOverrides } = buildOverrides(variableSet, outcome.x, plane);
  const resolved =
    pointOverrides.size === 0 && radiusOverrides.size === 0
      ? base
      : resolveSketch(document, { ...options, pointOverrides, radiusOverrides });

  return {
    resolved,
    diagnosis,
    errors: constraintErrors(document.id, diagnosis, outcome),
    solution: pointOverrides,
    radiusSolution: radiusOverrides,
    variableSet,
    outcome,
  };
}
