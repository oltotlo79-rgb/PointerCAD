/**
 * ミラー・複写・直線配列・円形配列(FR-324、計画書 docs/plans/P4-スケッチ拡張.md タスク24)を、
 * その場数値入力の確定からスケッチの履歴へ積む純関数。
 *
 * `editCommands.ts` の `commitOffset` と同じ「選択から作る」構図(P3 の `commitFace` の流儀)に
 * そろえる。DOM にもストアにも触れず、文書は不変で、作れないときは元の文書をそのまま返して
 * 理由キーだけを返す(FR-504、NFR-UX-5)。
 *
 * ## 4 つの道具はどれも 1 種類のフィーチャー
 *
 * model(タスク20)の `SketchCopyFeature` は `placement` の種類(mirror / translate /
 * linearArray / circularArray)だけが違う 1 種類のフィーチャーで、**もとの要素を id で参照する**。
 * だからツリーに増える行は 1 つ(「複製N」)、取り消し(Ctrl+Z)も 1 回、そして
 * **もとを動かせば複製も動く**(FR-311・FR-502)。ここでするのは「選択 → `source`」
 * 「段の値 → `placement`」の詰め替えだけで、鏡映・回転・平行移動の計算は 1 つも持たない
 * (`packages/model/src/sketch/copyMath.ts`)。
 *
 * ## 点と曲線が混ざった選択は断る(自動で 2 つに分けない)
 *
 * model は点と曲線が混じった `source` を `mixedBoundary` で断る。ui で「点だけ」「線だけ」の
 * 2 フィーチャーへ自動で分ける案を検討したが、**分けない**ことにした。理由は 3 つ。
 *   ① ツリーに 1 行・取り消し 1 回という約束(統括の指示、FR-505)が崩れる。
 *   ② 片方だけ作れたときに「半分できた」状態が残り、何が起きたのかを帯の 1 文で説明できない。
 *   ③ NFR-UX-5「実行してから失敗させない」に沿うなら、混ざった時点で**押す前に**断るのが筋。
 * そのため `copySourceFromSelection` が混在を見つけ、道具を押した瞬間に帯へ理由を出す。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  appendFeature,
  isBaseWorkPlaneId,
  MAX_COPY_COUNT,
  MIN_COPY_COUNT,
  nextFeatureId,
  nextFeatureName,
  type BaseWorkPlaneId,
  type CoordinateInput,
  type CopyPlacement,
  type ResolvedSketch,
  type SketchDocument,
  type SketchElementRef,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import {
  DEFAULT_ARRAY_ANGLE_DEGREES,
  DEFAULT_ARRAY_DIRECTION_DEGREES,
  DEFAULT_ARRAY_SPACING_MM,
  DEFAULT_CIRCULAR_ARRAY_COUNT,
  DEFAULT_COPY_DELTA_MM,
  DEFAULT_LINEAR_ARRAY_COUNT,
  type EditInputCommit,
  type MirrorAxisOptions,
} from './numericInput.js';
import { boundaryElementKind, toElementRef } from './sketchCommands.js';

export type CopyCommitOutcome =
  | { readonly ok: true; readonly document: SketchDocument; readonly featureId: string }
  /** 断った理由。文言は ja.json から引く(NFR-MA-5、NFR-UX-5)。 */
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * ツールバーのボタンが押せる条件(`editCommands.ts` の `EditToolReadiness` と同じ形)。
 * 型を輸入しないのは、`editCommands.ts` がこのファイルを輸入するため
 * (型だけの相互輸入は消えるが、読み手に循環を疑わせないよう形を写した)。
 */
export interface CopyToolReadiness {
  readonly ready: boolean;
  readonly reasonKey: MessageKey | null;
}

type CopySourceOutcome =
  | { readonly ok: true; readonly source: readonly SketchElementRef[] }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * 選んだ要素を複製のもと(`SketchCopyFeature.source`)へ直す。選んだ順がそのまま並びになる。
 *
 * 点だけ、または曲線だけ(§0.a-0.13 の面の境界と同じ約束)。混ざっていたら断る
 * (このファイル冒頭の判断)。面は複製の対象にしないので `unknown` と同じ扱いで断る。
 */
export function copySourceFromSelection(
  resolved: ResolvedSketch,
  selection: readonly string[],
): CopySourceOutcome {
  if (selection.length === 0) {
    return { ok: false, reasonKey: 'copy.error.emptySelection' };
  }
  let points = 0;
  let curves = 0;
  for (const elementId of selection) {
    const kind = boundaryElementKind(resolved, elementId);
    if (kind === 'point') {
      points += 1;
    } else if (kind === 'curve') {
      curves += 1;
    } else {
      return { ok: false, reasonKey: 'copy.error.unsupportedElement' };
    }
  }
  if (points > 0 && curves > 0) {
    return { ok: false, reasonKey: 'copy.error.mixedSelection' };
  }
  return { ok: true, source: selection.map((elementId) => toElementRef(elementId)) };
}

/**
 * 複製系の道具が押せる条件(NFR-UX-5「実行前に赤表示+理由提示」)。
 * `commitMirror` などと同じ判定を、道具を押す前に見せる。
 *
 * 鏡にするものが 1 つも無いとき(任意平面の上で線分も選んでいないとき)の断りは、
 * 作図面を知っている `Toolbar.tsx` が `mirrorAxisAvailability` を使って別に出す。
 */
export function copyToolReadiness(
  resolved: ResolvedSketch,
  selection: readonly string[],
): CopyToolReadiness {
  const source = copySourceFromSelection(resolved, selection);
  return source.ok ? { ready: true, reasonKey: null } : { ready: false, reasonKey: source.reasonKey };
}

/* ------------------------------------------------------------------ *
 * ミラー(FR-324)
 * ------------------------------------------------------------------ */

/**
 * 「作図面の横軸/縦軸で折り返す」を、model の `MirrorBasis`(平面)へ直すための表。
 *
 * 軸で折り返すというのは、**その軸を含み作図面に垂直な平面**で折り返すこと。基準の 3 面では
 * その平面もまた基準の 3 面のどれかになるので、平面の id だけで表せる。
 *   XY 面(第1軸 X・第2軸 Y): X 軸で折り返す = XZ 面、Y 軸で折り返す = YZ 面
 *   XZ 面(第1軸 X・第2軸 Z): X 軸で折り返す = XY 面、Z 軸で折り返す = YZ 面
 *   YZ 面(第1軸 Y・第2軸 Z): Y 軸で折り返す = XY 面、Z 軸で折り返す = XZ 面
 * いずれも「折り返す平面の法線 = もう一方の軸」になっていることで確かめられる。
 */
const MIRROR_PLANE_IDS: Readonly<
  Record<BaseWorkPlaneId, { readonly u: BaseWorkPlaneId; readonly v: BaseWorkPlaneId }>
> = {
  xy: { u: 'xz', v: 'yz' },
  xz: { u: 'xy', v: 'yz' },
  yz: { u: 'xy', v: 'xz' },
};

/**
 * 作図面の第1軸(`u`)・第2軸(`v`)で折り返すときの、鏡になる平面の id。
 * 基準の 3 面以外(任意の作業平面・3D スケッチ)では表せないので null を返す。
 */
export function mirrorPlaneIdFor(planeId: WorkPlaneId, axis: 'u' | 'v'): BaseWorkPlaneId | null {
  return isBaseWorkPlaneId(planeId) ? MIRROR_PLANE_IDS[planeId][axis] : null;
}

/**
 * 選択の中から、鏡にできる線分を 1 本選ぶ(**最後に選んだもの**)。無ければ null。
 *
 * 「図形を選んでから、最後に鏡にする線をクリックする」順が自然なので最後の 1 本を採る
 * (NFR-UX-1)。矩形などの複数曲線フィーチャーと、その n 番目を指した参照は軸にしない。
 * 1 本の線分としてまっすぐな向きが決まるものだけに限るため(model も線分だけを受け付ける)。
 */
export function mirrorAxisFromSelection(
  resolved: ResolvedSketch,
  selection: readonly string[],
): string | null {
  for (let index = selection.length - 1; index >= 0; index -= 1) {
    const elementId = selection[index];
    if (isSingleSegment(resolved, elementId)) {
      return elementId;
    }
  }
  return null;
}

function isSingleSegment(resolved: ResolvedSketch, elementId: string): boolean {
  const reference = toElementRef(elementId);
  if (reference.index !== undefined) {
    return false;
  }
  if (resolved.curvesByFeature.has(reference.featureId)) {
    return false;
  }
  return resolved.segments.some((segment) => segment.featureId === reference.featureId);
}

/**
 * ミラーの「鏡にするもの」の選択肢に何を並べられるか(NFR-UX-5)。
 * 作図面の軸は基準の 3 面のときだけ、選んだ線は選択に線分があるときだけ出す。
 */
export function mirrorAxisAvailability(
  planeId: WorkPlaneId,
  resolved: ResolvedSketch,
  selection: readonly string[],
): MirrorAxisOptions {
  return {
    planeAxes: isBaseWorkPlaneId(planeId),
    selectedLine: mirrorAxisFromSelection(resolved, selection) !== null,
  };
}

/**
 * 選んだ要素を鏡像複写する(FR-324)。もとは残り、複製が 1 つできる。
 *
 * 「選んだ線」で折り返すときは、**その線は複製のもとから外す**(鏡そのものを複製しても
 * 同じ位置に重なるだけで意味が無いため)。外した結果もとが空になったら断る。
 */
export function commitMirror(
  document: SketchDocument,
  resolved: ResolvedSketch,
  planeId: WorkPlaneId,
  selection: readonly string[],
  commit: EditInputCommit,
): CopyCommitOutcome {
  if (commit.choices.mirrorBasis === 'line') {
    const axisId = mirrorAxisFromSelection(resolved, selection);
    if (axisId === null) {
      return { ok: false, reasonKey: 'mirror.error.noLine' };
    }
    const source = copySourceFromSelection(
      resolved,
      selection.filter((elementId) => elementId !== axisId),
    );
    if (!source.ok) {
      return source;
    }
    return appendCopy(document, planeId, source.source, commit, {
      kind: 'mirror',
      basis: { kind: 'axis', axis: toElementRef(axisId) },
    });
  }
  const mirrorPlaneId = mirrorPlaneIdFor(planeId, commit.choices.mirrorBasis === 'axisV' ? 'v' : 'u');
  if (mirrorPlaneId === null) {
    return { ok: false, reasonKey: 'mirror.error.noPlaneAxis' };
  }
  const source = copySourceFromSelection(resolved, selection);
  if (!source.ok) {
    return source;
  }
  return appendCopy(document, planeId, source.source, commit, {
    kind: 'mirror',
    basis: { kind: 'plane', planeId: mirrorPlaneId },
  });
}

/* ------------------------------------------------------------------ *
 * 複写(平行移動、FR-324)
 * ------------------------------------------------------------------ */

/** 単位ベクトルの成分を「1 か 0 か」で見分ける許容差。基準の 3 面はちょうど 1 と 0 になる。 */
const AXIS_COMPONENT_TOLERANCE = 1e-9;

/**
 * 作図面の 2 軸ぶんの移動量から、ワールドの 1 成分を組み立てる。
 *
 * 基準の 3 面(XY・XZ・YZ)の軸はどれもワールドの軸そのものなので、係数は必ず 1 か 0 になり、
 * **入力した式がそのまま残る**(FR-202「式は文字列のまま保存」)。任意の作業平面のように
 * 斜めを向いた軸では式のままでは表せないので、そのときだけ評価値から数を作る。
 */
function axisComponent(
  coefficientU: number,
  alongU: ExpressionValue,
  coefficientV: number,
  alongV: ExpressionValue,
): ExpressionValue {
  const zeroU = Math.abs(coefficientU) < AXIS_COMPONENT_TOLERANCE;
  const zeroV = Math.abs(coefficientV) < AXIS_COMPONENT_TOLERANCE;
  if (Math.abs(coefficientU - 1) < AXIS_COMPONENT_TOLERANCE && zeroV) {
    return alongU;
  }
  if (Math.abs(coefficientV - 1) < AXIS_COMPONENT_TOLERANCE && zeroU) {
    return alongV;
  }
  return expressionValueFromNumber(coefficientU * alongU.value + coefficientV * alongV.value);
}

/**
 * 作図面の中の移動量(第1軸へ `alongU`、第2軸へ `alongV`)を、原点から見た向きベクトルの
 * 座標指定へ直す(model の `CopyPlacement.translate.delta` の約束)。
 *
 * 作図面の中で聞くのは、XZ 面にかいた図形を「ΔY」で動かすと作図面から浮いてしまうため
 * (2 次元のスケッチが平面から外れると面が張れなくなる)。
 */
export function planeDeltaCoordinate(
  plane: WorkPlane,
  alongU: ExpressionValue,
  alongV: ExpressionValue,
): CoordinateInput {
  return {
    mode: 'absolute',
    x: axisComponent(plane.axisU[0], alongU, plane.axisV[0], alongV),
    y: axisComponent(plane.axisU[1], alongU, plane.axisV[1], alongV),
    z: axisComponent(plane.axisU[2], alongU, plane.axisV[2], alongV),
  };
}

/**
 * 選んだ要素を指定した移動量で複写する(FR-324)。もとは残り、複製が 1 つできる。
 *
 * 3D スケッチ(作図面なし)では 3 つ目の欄(ΔZ)が出るので、そのときはワールドの成分を
 * そのまま使う。作図面があるときは 2 つの欄を作図面の 2 軸へ写す(`planeDeltaCoordinate`)。
 */
export function commitCopy(
  document: SketchDocument,
  resolved: ResolvedSketch,
  planeId: WorkPlaneId,
  plane: WorkPlane,
  selection: readonly string[],
  commit: EditInputCommit,
): CopyCommitOutcome {
  const source = copySourceFromSelection(resolved, selection);
  if (!source.ok) {
    return source;
  }
  const alongU = commit.values.dx ?? expressionValueFromNumber(DEFAULT_COPY_DELTA_MM);
  const alongV = commit.values.dy ?? expressionValueFromNumber(0);
  const alongNormal = commit.values.dz;
  const delta: CoordinateInput =
    alongNormal === undefined
      ? planeDeltaCoordinate(plane, alongU, alongV)
      : { mode: 'absolute', x: alongU, y: alongV, z: alongNormal };
  return appendCopy(document, planeId, source.source, commit, { kind: 'translate', delta });
}

/* ------------------------------------------------------------------ *
 * 直線配列・円形配列(FR-324)
 * ------------------------------------------------------------------ */

/**
 * 角度(度)を、原点から見た**長さ 1 の向き**の座標指定へ直す。
 *
 * 角度は作図面の第1軸から第2軸へ向かう向きが正(`resolveCoordinate` の極座標と同じ約束)。
 * 極座標で持たせるので、入力した角度の式がそのまま残る(FR-202)。
 */
export function directionFromAngle(angleDegrees: ExpressionValue): CoordinateInput {
  return {
    mode: 'polar',
    base: { kind: 'origin' },
    distance: expressionValueFromNumber(1),
    azimuth: angleDegrees,
    elevation: expressionValueFromNumber(0),
  };
}

/**
 * 並べる個数(もとを含めた総数)が使えるかどうか(NFR-UX-5)。
 * 欄そのものにも 2〜100 の範囲を付けてあるので、ここは「欄を通り抜けたとき」の二重の守り。
 */
export function copyCountRejection(count: number): MessageKey | null {
  if (
    !Number.isFinite(count) ||
    !Number.isInteger(count) ||
    count < MIN_COPY_COUNT ||
    count > MAX_COPY_COUNT
  ) {
    return 'copy.error.count';
  }
  return null;
}

/** 選んだ要素を、指定した向きへ等間隔に並べる(FR-324)。複製は `個数 − 1` 個。 */
export function commitLinearArray(
  document: SketchDocument,
  resolved: ResolvedSketch,
  planeId: WorkPlaneId,
  selection: readonly string[],
  commit: EditInputCommit,
): CopyCommitOutcome {
  const source = copySourceFromSelection(resolved, selection);
  if (!source.ok) {
    return source;
  }
  const count = commit.values.count ?? expressionValueFromNumber(DEFAULT_LINEAR_ARRAY_COUNT);
  const rejection = copyCountRejection(count.value);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  return appendCopy(document, planeId, source.source, commit, {
    kind: 'linearArray',
    direction: directionFromAngle(
      commit.values.angle ?? expressionValueFromNumber(DEFAULT_ARRAY_DIRECTION_DEGREES),
    ),
    spacing: commit.values.spacing ?? expressionValueFromNumber(DEFAULT_ARRAY_SPACING_MM),
    count,
  });
}

/** 中心を省いたときの既定(原点)。Enter 連打だけでも意味のある結果になる(NFR-UX-4)。 */
function originCoordinate(): CoordinateInput {
  const zero = expressionValueFromNumber(0);
  return { mode: 'absolute', x: zero, y: zero, z: zero };
}

/**
 * 選んだ要素を、中心のまわりに等間隔に並べる(FR-324)。複製は `個数 − 1` 個。
 * 回す軸は作図面の法線なので、作図面のあるスケッチでだけ作れる(model の解決が断る)。
 */
export function commitCircularArray(
  document: SketchDocument,
  resolved: ResolvedSketch,
  planeId: WorkPlaneId,
  selection: readonly string[],
  commit: EditInputCommit,
): CopyCommitOutcome {
  const source = copySourceFromSelection(resolved, selection);
  if (!source.ok) {
    return source;
  }
  const count = commit.values.count ?? expressionValueFromNumber(DEFAULT_CIRCULAR_ARRAY_COUNT);
  const rejection = copyCountRejection(count.value);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  return appendCopy(document, planeId, source.source, commit, {
    kind: 'circularArray',
    center: commit.coordinate ?? originCoordinate(),
    angle: commit.values.angle ?? expressionValueFromNumber(DEFAULT_ARRAY_ANGLE_DEGREES),
    count,
    // つまみを持たない確定(検査から直に組み立てたもの)は全周として扱う(既定は入)。
    fullCircle: commit.flags.fullCircle ?? true,
  });
}

/* ------------------------------------------------------------------ *
 * 共通
 * ------------------------------------------------------------------ */

/** 複製フィーチャーを履歴の末尾へ積む。名前は「複製N」(model の `KIND_LABELS`)。 */
function appendCopy(
  document: SketchDocument,
  planeId: WorkPlaneId,
  source: readonly SketchElementRef[],
  commit: EditInputCommit,
  placement: CopyPlacement,
): CopyCommitOutcome {
  const featureId = nextFeatureId(document, 'copy');
  return {
    ok: true,
    featureId,
    document: appendFeature(document, {
      id: featureId,
      name: nextFeatureName(document, 'copy'),
      planeId,
      kind: 'copy',
      source,
      placement,
      construction: commit.flags.construction ?? false,
    }),
  };
}
