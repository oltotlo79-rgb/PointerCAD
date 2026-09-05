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
  CONSTRAINT_TOLERANCE,
  solveLevenbergMarquardt,
  type LinearizedRow,
  type SolveOptions,
  type SolveOutcome,
} from './solve.js';
import { sketchConstraints, type SketchConstraint } from './types.js';
import {
  canonicalPointKey,
  collectVariables,
  MAX_CONSTRAINT_VARIABLES,
  pointComponentKey,
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

/**
 * 引っぱりの残差に掛ける重み(§0.a 追記 3、2026-09-05 の統括の決定。P4b タスク14)。
 *
 * 利用者が要素を引っぱっている間だけ、「引っぱっている点を目標の (u, v) へ寄せる」式 2 本を
 * 拘束の残差へ**継ぎ足す**。重みを小さくするのが要で、**拘束を先に満たしたうえで、残った
 * 自由度のぶんだけ目標へ寄る**という順序になる(硬い一時固定は、水平拘束のように「両端の
 * v が等しい」式を破れないぶん解なしを生むので採らない)。
 *
 * **1e-2 の根拠(2026-09-05 の実測)。** 計画書の「初期値 1e-3」からの調整で、決定の
 * 「重みは手触りで調整する」に従う。
 *
 * 釣り合いの向き(引っぱりが拘束の届かないところを指しているとき)に残る拘束の誤差は
 * およそ `重み² × 行き過ぎた距離`。反対に、目標へ寄る 1 歩の大きさは減衰 λ と `重み²` の比
 * `重み²/(重み² + λ)` で決まり、λ は `CONSTRAINT_INITIAL_DAMPING`(1e-6)のあたりに
 * 落ち着く。つまり重みは**大きいほど指に付いてきて、小さいほど拘束に忠実**という
 * 一本の綱引きになる。実測(始点を固定し長さを 10 に決めた線分の端点を、真上の
 * (0, 30) へ引く。正解は (0, 10)):
 *
 * | 重み | 反復 50 回で届いた先 | 長さの誤差 |
 * |---|---|---|
 * | 1e-3 | (8.36, 5.48) … **90° のうち 33° しか回らない**(指に付いてこない) | 5e-4mm |
 * | 3e-3 | (1.70, 9.86) … 80° | 2e-3mm |
 * | **1e-2** | **(0, 10.002)** … 届く | **2e-3mm** |
 * | 3e-2 | (0, 10.018) … 届く | 1.8e-2mm |
 *
 * 1e-3 では λ(1e-6)と `重み²`(1e-6)が同じ大きさになり、1 歩ごとに歩幅が半分に
 * 削られて反復の上限(50 回)を使い切っても目標へ届かない。1e-2 なら `重み²`(1e-4)が
 * λ の 100 倍で、削られずに付いてくる。そのとき残る拘束の誤差 2e-3mm は
 * `SKETCH_TOLERANCE_MM`(1e-6mm)より粗いが、**引っぱっている最中の見た目だけ**の話で、
 * 離した瞬間に引っぱりの式を外して解き直す(タスク14 の確定)ので文書には残らない。
 */
export const DRAG_PIN_WEIGHT = 1e-2;

/**
 * 引っぱっている点 1 つ。u と v の列、目標の (u, v)、そして重み付きの勾配を持つ。
 * 勾配は反復のあいだ変わらない(残差が列について線形)ので、1 度だけ作って使い回す。
 */
interface PinnedPoint {
  readonly pointKey: string;
  readonly uColumn: number;
  readonly vColumn: number;
  readonly target: readonly [number, number];
  readonly weight: number;
  readonly uGradient: ReadonlyMap<number, number>;
  readonly vGradient: ReadonlyMap<number, number>;
}

/**
 * 引っぱっている点の目標から、継ぎ足す残差のもとを作る。
 *
 * **動かせない点(式で書かれた座標・「固定」拘束・規則から導かれる点)は黙って落とす。**
 * 変数でない数へ式を立てても解が動かないだけで、断りは画面の側(タスク14 の `draggableAt`)が
 * 押した瞬間に出す。鍵は `ResolvedPoint.id` / `vertexKey` の規約で、別名は正本へ寄せる。
 */
function collectPinnedPoints(
  variableSet: VariableSet,
  pinned: ReadonlyMap<string, readonly [number, number]>,
  weight: number,
): readonly PinnedPoint[] {
  const points: PinnedPoint[] = [];
  for (const [pointKey, target] of pinned) {
    const canonical = canonicalPointKey(variableSet, pointKey);
    if (canonical === null) {
      continue;
    }
    const uColumn = variableSet.index.get(pointComponentKey(canonical, 'u'));
    const vColumn = variableSet.index.get(pointComponentKey(canonical, 'v'));
    if (uColumn === undefined || vColumn === undefined) {
      continue;
    }
    points.push({
      pointKey: canonical,
      uColumn,
      vColumn,
      target: [target[0], target[1]],
      weight,
      uGradient: new Map([[uColumn, weight]]),
      vGradient: new Map([[vColumn, weight]]),
    });
  }
  return points;
}


/**
 * 反復の細かい設定と、**引っぱりの口**(P4b タスク14)。
 *
 * `SolveOptions`(反復の上限・許容量・減衰の初期値)をそのまま広げた形にしてあるので、
 * 拘束だけを解く既存の呼び出しは何も変えずに通る。
 */
export interface ConstrainedSolveOptions extends SolveOptions {
  /**
   * 引っぱっている点の目標(点の鍵 → 作図面上の (u, v))。押している間だけ渡す。
   * 鍵は `ResolvedPoint.id` / `vertexKey` の規約(`line-1:end` など)。
   *
   * **診断(足りない・足しすぎ・矛盾)はこの口を見ない。** 診断が見るのは文書に保存された
   * 拘束だけなので、引っぱりが「矛盾する拘束」に数えられることはない(§0.a 追記 3)。
   */
  readonly pinned?: ReadonlyMap<string, readonly [number, number]>;
  /** 引っぱりの残差に掛ける重み。既定は `DRAG_PIN_WEIGHT`(手触りの調整用に開けてある)。 */
  readonly pinnedWeight?: number;
}

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
    if (uv === null) {
      return;
    }
    /*
      **基準に追従する点(相対・極で書かれた点)は、動かなかったなら差し込まない**
      (P4b タスク22b。`VariableSet.followsBase` の注釈)。差し込むと、基準が拘束で
      動いたのに追従しない点ができてしまう(水平+長さ 10 で終点が (7,0,0) → (10,0,0) へ
      動いても、その終点を基準にした点が元の位置に残る)。差し込まなければ ③ の解決が
      「基準 + Δ」で計算し直すので、従来どおり追従する。動いた点(引っぱった点・拘束で
      動いた点)はこれまでどおり差し込む。
    */
    const initial = pointValueAt(variableSet, variableSet.initial, variable.pointKey);
    if (
      variableSet.followsBase.has(variable.pointKey) &&
      initial !== null &&
      Math.abs(uv[0] - initial[0]) <= CONSTRAINT_TOLERANCE &&
      Math.abs(uv[1] - initial[1]) <= CONSTRAINT_TOLERANCE
    ) {
      return;
    }
    pointOverrides.set(variable.pointKey, planeToWorld(plane, uv[0], uv[1]));
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
  /** 拘束の式だけで見た収束。解かなかったときは null(引っぱりの式は数えない)。 */
  converged: boolean | null,
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
  } else if (converged === false) {
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
 * `CONSTRAINT_*`)で、診断の許容量も同じ値に揃える。**引っぱり**(P4b タスク14)も
 * ここから入る(`pinned`)。
 */
export function resolveConstrainedSketch(
  document: SketchDocument,
  options: SketchResolveOptions = {},
  solveOptions?: ConstrainedSolveOptions,
): ConstrainedSketch {
  // ① 拘束を無視した解決。ソルバーの初期値であり、解かないときの答えでもある。
  const base = resolveSketch(document, options);
  const constraints: readonly SketchConstraint[] = sketchConstraints(document);
  const pinned = solveOptions?.pinned;
  const dragging = pinned !== undefined && pinned.size > 0;
  if (constraints.length === 0 && !dragging) {
    return unsolved(base, [], null, null);
  }

  const lookup = options.workPlane ?? baseWorkPlane;
  const plane = sketchWorkPlane(document, lookup);
  if (plane === null) {
    // 作図面が無いスケッチ(3D スケッチ、FR-330)。拘束が 1 つでもあれば断りを出し、
    // 引っぱりだけなら黙って何もしない(引っぱれない理由は画面の側が押した瞬間に出す)。
    return unsolved(
      base,
      constraints.length === 0
        ? []
        : [sketchError(document.id, 'constraintUnsolved', CONSTRAINT_FREE_SKETCH_MESSAGE)],
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

  const pins = dragging
    ? collectPinnedPoints(variableSet, pinned, solveOptions?.pinnedWeight ?? DRAG_PIN_WEIGHT)
    : [];

  if (constraints.length === 0) {
    /*
      拘束が 1 つも無いスケッチを引っぱっているとき(タスク14 の検証表「拘束が 0 個の
      スケッチで点を引っぱる」)。連立を解いても、引っぱっている点以外には式が 1 本も
      立たないので答えは「その点を目標へ置く」だけになる。**解かずにそのまま置く**ことで、
      拘束を使わない文書の手触りを 1 ミリ秒も落とさない(§2.2「拘束が 0 個なら 1 段」)。
    */
    if (pins.length === 0) {
      return unsolved(base, [], null, variableSet);
    }
    const pointOverrides = new Map<string, Vec3>();
    for (const pin of pins) {
      pointOverrides.set(pin.pointKey, planeToWorld(plane, pin.target[0], pin.target[1]));
    }
    return {
      resolved: resolveSketch(document, { ...options, pointOverrides }),
      diagnosis: null,
      errors: [],
      solution: pointOverrides,
      radiusSolution: NO_RADII,
      variableSet,
      outcome: null,
    };
  }

  const evaluate = (x: readonly number[]): readonly LinearizedRow[] => {
    const rows = buildResiduals(constraints, variableSet, x);
    if (pins.length === 0) {
      return rows;
    }
    // 引っぱりの式は**拘束の後ろへ継ぎ足す**(拘束の行の並びを変えない。決定性)。
    const withPins: LinearizedRow[] = [...rows];
    for (const pin of pins) {
      withPins.push({
        value: pin.weight * (x[pin.uColumn] - pin.target[0]),
        gradient: pin.uGradient,
      });
      withPins.push({
        value: pin.weight * (x[pin.vColumn] - pin.target[1]),
        gradient: pin.vGradient,
      });
    }
    return withPins;
  };
  const outcome = solveLevenbergMarquardt(variableSet.initial, evaluate, solveOptions);

  /*
    診断(足りない・足しすぎ・矛盾)と断りは、**引っぱっている間は出さない**。理由は 2 つ。

    ①引っぱりは重み付きの釣り合いなので、目標が拘束の届かないところにあると拘束の式が
      きっちり 0 にはならない(実測: 20mm 行き過ぎた引っぱりで長さの誤差 2e-3mm、
      `DRAG_PIN_WEIGHT` の注釈)。これを「解けていない」と読むと、引っぱるたびに
      帯が赤くなる。文書の拘束は 1 つも変わっていないのだから、正しい診断は**離した後の
      再計算**(引っぱりの式が無い状態)で出せばよい。
    ②ヤコビアンの階数を毎コマ数えると、ドラッグの 1 コマ(16.6ms)に収まらなくなる
      (NFR-PF-1、§2.9)。

    引っぱっていないときは従来どおり。診断には**解いた後の x** を渡す(初期値のままだと、
    解けば消える残差を「矛盾」と読み違える。タスク7 の申し送り)。
  */
  const diagnosis =
    pins.length > 0
      ? null
      : diagnoseConstraints(constraints, variableSet, outcome.x, {
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
    errors:
      diagnosis === null ? [] : constraintErrors(document.id, diagnosis, outcome.converged),
    solution: pointOverrides,
    radiusSolution: radiusOverrides,
    variableSet,
    outcome,
  };
}
