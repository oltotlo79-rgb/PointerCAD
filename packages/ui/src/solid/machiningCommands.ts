/**
 * 選択から加工フィーチャー(穴・ねじ穴・R 面取り・C 面取り・直線/円形パターン)を作る純関数
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク25、§0.a-0.9〜0.21)。
 *
 * `packages/ui/src/solid/solidCommands.ts`(P2 タスク18)と同じ流儀に揃える。ストアにも DOM にも
 * 触れない純関数だけを置き、操作の判断を Node の単体検査で固定できるようにする
 * (`docs/報告記録.md` 2026-09-02 23:09 の教訓)。文書は不変で、確定できないときは元の文書を
 * そのまま返す(FR-504、NFR-UX-5)。
 *
 * **ばね(`commitSpring`)はここに置かない。** ばねは対象を消費しない「作る」フィーチャーで
 * 加工ではない(§0.a-0.36)。タスク25b が `solidCommands.ts` へ足す。
 *
 * **要素の種類の判定は id の接頭辞ではなく文書・一覧への所属で行う**
 * (`docs/報告記録.md` 2026-09-03 13:05 の②)。部分形状も同じで、`bodies`(カーネルが返した
 * 立体の一覧)に載っているかで判定する。`solidCommands.ts` の `faceRefById` と同じ書き方を使う。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  appendSolid,
  DEFAULT_CHAMFER_ANGLE_DEGREES,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_CIRCULAR_PATTERN_COUNT,
  DEFAULT_FILLET_RADIUS_MM,
  DEFAULT_HOLE_DEPTH_MM,
  DEFAULT_HOLE_DIAMETER_MM,
  DEFAULT_PATTERN_COUNT,
  DEFAULT_PATTERN_SPACING_MM,
  DEFAULT_THREAD_DESIGNATION,
  dedupeSubShapeRefs,
  findMetricThread,
  findSolid,
  isPatternSource,
  isSamePoint,
  liveBodyIds,
  MAX_PATTERN_COUNT,
  metricThreadPitch,
  nextSolidId,
  nextSolidName,
  threadMinorDiameter,
  type ChamferFeature,
  type ChamferSize,
  type FilletFeature,
  type HoleDepth,
  type HoleFeature,
  type PartDocument,
  type PatternDirection,
  type PatternFeature,
  type PatternPlacement,
  type SketchFeature,
  type SketchPointRef,
  type SubShapeRef,
  type ThreadHoleFeature,
  type ThreadRepresentation,
  type ThreadSeries,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import type { SolidInputCommit } from '../sketch/numericInput.js';

import { findSketchFeatureAt } from './sketchRefs.js';
import type { SolidCommandOutcome, SolidToolReadiness } from './solidCommands.js';
import {
  commonBodyIdOf,
  parseSubShapeId,
  selectedBodyIds,
  selectedSubShapeRefs,
  subShapeElementId,
  subShapeRefOf,
  type SubShapeBody,
} from './subShapeSelection.js';

/**
 * 加工の道具(§2.11 のツールバー「加工」区画の 6 個)。
 * `SolidToolId`(numericInput.ts)から「対象のボディを 1 つ加工する・パターンで並べる」
 * 6 種類だけに絞った型。押し出し・回転・縫合・ばねは対象を消費しない別枠(§0.a-0.36)なので
 * `machiningToolReadiness` の対象にしない。
 *
 * 計画書タスク25 の宣言は `machiningToolReadiness(context, tool: SolidToolId)` だが、
 * `SolidToolId` は加工でない道具(押し出し・回転・縫合・ばね)も含むため、switch を
 * 網羅すると「押せない」以外に書きようのない枝が残る。ここでは実装を正とし、専用の
 * 絞り込んだ型を使う(判断に迷った点として報告する)。
 */
export type MachiningToolId =
  | 'hole'
  | 'threadHole'
  | 'fillet'
  | 'chamfer'
  | 'linearPattern'
  | 'circularPattern';

/** 加工のコマンドが必要とする文脈(計画書タスク25)。 */
export interface MachiningContext {
  readonly document: PartDocument;
  /**
   * カーネルが返した立体の一覧。指紋を作るのに要る。
   *
   * 計画書の宣言は `readonly SolidBody[]`(`@pointercad/model` の型)だが、`SolidBody` に
   * 面・辺・頂点の一覧が届くのはタスク10(kernel)・タスク17(model)の後で、このタスクの
   * 着手時点ではまだ届いていない(タスク20 の `subShapeSelection.ts` の同じ注記を参照)。
   * そこでタスク20 が定めた `SubShapeBody`(部分形状を選ぶのに要るものだけを持つボディ)を使う。
   * タスク17 が `SolidBody` へ同じ形の欄を足したら、この欄の型をそちらへ差し替えるだけでよい。
   */
  readonly bodies: readonly SubShapeBody[];
  /** 選択(順序つき)。部分形状の id も入る。 */
  readonly selection: readonly string[];
}

/** 押せる。 */
const READY: SolidToolReadiness = { ready: true, reasonKey: null };

/** 穴の直径の既定値。model の DEFAULT_HOLE_DIAMETER_MM を式へ直したもの。 */
export const DEFAULT_HOLE_DIAMETER: ExpressionValue = expressionValueFromNumber(
  DEFAULT_HOLE_DIAMETER_MM,
);
/** 止まり穴の深さ・ねじ部の長さの既定値(§2.11 の表。どちらも 10mm)。 */
export const DEFAULT_HOLE_DEPTH: ExpressionValue = expressionValueFromNumber(DEFAULT_HOLE_DEPTH_MM);
export const DEFAULT_THREAD_LENGTH: ExpressionValue = expressionValueFromNumber(
  DEFAULT_HOLE_DEPTH_MM,
);
/** R 面取りの半径の既定値。 */
export const DEFAULT_FILLET_RADIUS: ExpressionValue = expressionValueFromNumber(
  DEFAULT_FILLET_RADIUS_MM,
);
/** C 面取りの距離・角度の既定値(距離2 も等距離の既定と同じ値を使う、§2.11)。 */
export const DEFAULT_CHAMFER_DISTANCE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_CHAMFER_DISTANCE_MM,
);
export const DEFAULT_CHAMFER_ANGLE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_CHAMFER_ANGLE_DEGREES,
);
/** 直線パターンの間隔・個数の既定値。向きの既定は X(§0.a-0.21)。 */
export const DEFAULT_PATTERN_SPACING: ExpressionValue = expressionValueFromNumber(
  DEFAULT_PATTERN_SPACING_MM,
);
export const DEFAULT_PATTERN_COUNT_VALUE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_PATTERN_COUNT,
);
export const DEFAULT_LINEAR_PATTERN_DIRECTION: PatternDirection = { kind: 'world', axis: 'x' };
/** 円形パターンの角度・個数の既定値。軸の既定は Z(§0.a-0.21)。 */
export const DEFAULT_CIRCULAR_PATTERN_ANGLE: ExpressionValue = expressionValueFromNumber(360);
export const DEFAULT_CIRCULAR_PATTERN_COUNT_VALUE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_CIRCULAR_PATTERN_COUNT,
);
export const DEFAULT_CIRCULAR_PATTERN_AXIS: PatternDirection = { kind: 'world', axis: 'z' };
/**
 * 穴・ねじ穴の傾き角・方位角の既定値(0 = 面に垂直)。§0.a-0.10 の決定により、その場入力には
 * 出てこない(プロパティでだけ編集する)ので、その場入力からの確定(`commitMachiningInput`)では
 * 常にこの既定値を使う。プロパティからの再編集はタスク27 の担当。
 */
export const DEFAULT_TILT_ANGLE: ExpressionValue = expressionValueFromNumber(0);
export const DEFAULT_TILT_AZIMUTH: ExpressionValue = expressionValueFromNumber(0);

/**
 * 加工の対象になる立体の id を決める(§0.a-0.6)。
 *
 * 選択中の部分形状(面・辺・頂点)が**すべて同じ立体に属していれば**その立体、
 * 部分形状の選択が無ければ**直に選ばれている立体が 1 つだけのときに限り**その立体。
 * どちらも決まらなければ null(NFR-UX-5 の理由は呼び出し側が具体的な鍵で出す)。
 */
export function machiningTargetOf(context: MachiningContext): string | null {
  const subShapeBody = commonBodyIdOf(context.selection);
  if (subShapeBody !== null) {
    return subShapeBody;
  }
  const bodyIds = selectedBodyIds(context.selection, liveBodyIds(context.document));
  return bodyIds.length === 1 ? bodyIds[0] : null;
}

/** 選択から面フィーチャーの参照を拾った結果。 */
type MachiningFaceOutcome =
  | { readonly ok: true; readonly ref: SubShapeRef; readonly targetFeatureId: string }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * 穴・ねじ穴の対象の面を選択から決める。
 *
 * 面が 1 つも選ばれていなければ `noFace`。面はあるが `machiningTargetOf` が単一の立体を
 * 決められない(複数の立体の面が混ざっている)ときは `faceNotOnTarget`
 * (「面が加工する立体のものでない」の具体的な言い方として、この場合に使う)。
 */
function resolveMachiningFace(context: MachiningContext): MachiningFaceOutcome {
  const faces = selectedSubShapeRefs(context.bodies, context.selection, 'face');
  if (faces.length === 0) {
    return { ok: false, reasonKey: 'machiningError.noFace' };
  }
  const target = machiningTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'machiningError.faceNotOnTarget' };
  }
  // target が非 null のときは machiningTargetOf の作りにより選択中の部分形状が
  // すべて同じ立体に属することが保証されているので、必ず見つかる。
  const ref = faces.find((face) => face.bodyFeatureId === target) ?? faces[0];
  return { ok: true, ref, targetFeatureId: target };
}

/**
 * 選択からスケッチの点・点列フィーチャーを中心点として拾う(§0.a-0.9)。選んだ順を保ち、
 * 同じフィーチャーを 2 度選んでも 1 回だけ数える。点列は featureIdOf が 1 点の選択
 * (`point-1#3`)からもフィーチャー id(`point-1`)を返すので、1 点だけ選んでも点列全体を
 * 指したことになる(展開は resolvePart が行う、§0.a-0.9)。
 */
const CENTER_POINT_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['point', 'pointArray']);

function selectedCenterPoints(
  document: PartDocument,
  selection: readonly string[],
): readonly SketchPointRef[] {
  const refs: SketchPointRef[] = [];
  const seen = new Set<string>();
  for (const elementId of selection) {
    const featureId = featureIdOf(elementId);
    if (seen.has(featureId)) {
      continue;
    }
    // 押し出しの面と同じく、**編集中のスケッチを先に**見る(P4 仕上げ (g)、`sketchRefs.ts`)。
    // 文書の並び順に前から探すと、スケッチ 2 の `point-1` を選んだつもりでスケッチ 1 の
    // `point-1` が穴の中心になる。
    const found = findSketchFeatureAt(document, elementId, CENTER_POINT_KINDS);
    if (found !== undefined) {
      refs.push({ sketchId: found.sketchId, pointFeatureId: found.featureId });
      seen.add(featureId);
    }
  }
  return refs;
}

/**
 * 選択中の頂点を「その頂点に集まる辺」へ展開する(§0.a-0.17 の追記どおり、確定時=ここで行う)。
 *
 * 展開は `SubShapeBody.edges` の `start` / `end`(端点の座標)と `SubShapeBody.vertices` の
 * `position` を `isSamePoint`(model のスケッチ許容誤差)で突き合わせて行う。ボディが
 * 見つからない・頂点の番号が範囲外・その位置に触れる辺が 1 本もない場合、その頂点は
 * 静かに読み飛ばす(`selectedSubShapeRefs` と同じ方針: 展開できない頂点を理由に全体を
 * 断るより、他の選択で加工できるほうが利用者の意図に近い)。**その結果として targets が
 * 空になったときは `commitFillet` / `commitChamfer` が `noEdge` で断るので、
 * 「展開に要る情報が無ければ理由を出して断る」という決定は満たされる。**
 */
function expandVertexTargets(context: MachiningContext): readonly SubShapeRef[] {
  const expanded: SubShapeRef[] = [];
  for (const elementId of context.selection) {
    const parsed = parseSubShapeId(elementId);
    if (parsed === null || parsed.kind !== 'vertex') {
      continue;
    }
    const body = context.bodies.find((candidate) => candidate.featureId === parsed.bodyFeatureId);
    const vertex = body?.vertices.find((entry) => entry.index === parsed.index);
    if (body === undefined || vertex === undefined) {
      continue;
    }
    for (const edge of body.edges) {
      if (isSamePoint(edge.start, vertex.position) || isSamePoint(edge.end, vertex.position)) {
        const ref = subShapeRefOf(context.bodies, subShapeElementId(body.featureId, 'edge', edge.index));
        if (ref !== null) {
          expanded.push(ref);
        }
      }
    }
  }
  return expanded;
}

/** 番号の昇順に並べる。まずボディ、次に通し番号(§2.7/cacheKey.ts の決定性の要求に揃える)。 */
function sortSubShapeRefs(refs: readonly SubShapeRef[]): readonly SubShapeRef[] {
  return [...refs].sort((a, b) => {
    if (a.bodyFeatureId !== b.bodyFeatureId) {
      return a.bodyFeatureId < b.bodyFeatureId ? -1 : 1;
    }
    return a.index - b.index;
  });
}

/**
 * R/C 面取りの対象(辺)を選択から集める。直に選んだ辺と、選んだ頂点を展開した辺を合わせ、
 * 重複を除いて(`dedupeSubShapeRefs`、先に出たほうを残す)番号の昇順に並べる
 * (targets の並びが選ぶ順で変わると鍵が余計に変わってしまうため、cacheKey.ts の決定性の
 * 要求をここでも先取りして満たす)。
 */
function gatherFilletTargets(context: MachiningContext): readonly SubShapeRef[] {
  const direct = selectedSubShapeRefs(context.bodies, context.selection, 'edge');
  const expanded = expandVertexTargets(context);
  return sortSubShapeRefs(dedupeSubShapeRefs([...direct, ...expanded]));
}

/** パターンの対象(穴・ねじ穴のフィーチャー)を選択から決めた結果。 */
type PatternSourceOutcome =
  | { readonly ok: true; readonly sourceFeatureId: string }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * パターンで繰り返す穴・ねじ穴を選択から決める(§0.a-0.20)。パターンの道具は
 * `selectionKind` が `'body'` のままなので(タスク21 の `SELECTION_KIND_FOR_TOOL`)、
 * 立体そのもの(= その穴・ねじ穴フィーチャーの id)を選ぶ。
 */
function selectedPatternSource(
  document: PartDocument,
  selection: readonly string[],
): PatternSourceOutcome {
  const bodyIds = selectedBodyIds(selection, liveBodyIds(document));
  if (bodyIds.length === 0) {
    return { ok: false, reasonKey: 'machiningError.noPatternSource' };
  }
  const sourceFeatureId = bodyIds[0];
  const feature = findSolid(document, sourceFeatureId);
  if (feature === undefined || !isPatternSource(feature)) {
    return { ok: false, reasonKey: 'machiningError.sourceNotHole' };
  }
  return { ok: true, sourceFeatureId };
}

/**
 * 穴を 1 つ作る(FR-405)。面が選ばれていなければ `noFace`、面は複数の立体にまたがっていれば
 * `faceNotOnTarget`、中心にする点が無ければ `noCenterPoint`。
 *
 * 傾き角・方位角はその場入力に出てこない(§0.a-0.10)。ここでは呼び出し側が渡した値を
 * そのまま使う。プロパティからの再編集(タスク27)もこの欄をそのまま更新すればよい。
 */
export function commitHole(
  context: MachiningContext,
  params: {
    readonly diameter: ExpressionValue;
    readonly depth: HoleDepth;
    readonly tiltAngle: ExpressionValue;
    readonly tiltAzimuth: ExpressionValue;
  },
): SolidCommandOutcome {
  const face = resolveMachiningFace(context);
  if (!face.ok) {
    return { ok: false, reasonKey: face.reasonKey };
  }
  const centers = selectedCenterPoints(context.document, context.selection);
  if (centers.length === 0) {
    return { ok: false, reasonKey: 'machiningError.noCenterPoint' };
  }
  const id = nextSolidId(context.document, 'hole');
  const feature: HoleFeature = {
    id,
    name: nextSolidName(context.document, 'hole'),
    suppressed: false,
    kind: 'hole',
    targetFeatureId: face.targetFeatureId,
    face: face.ref,
    centers,
    diameter: params.diameter,
    depth: params.depth,
    tiltAngle: params.tiltAngle,
    tiltAzimuth: params.tiltAzimuth,
  };
  return { ok: true, document: appendSolid(context.document, feature), featureId: id };
}

/**
 * ねじ穴を 1 つ作る(FR-406)。断り方は穴と同じ(`noFace` / `faceNotOnTarget` / `noCenterPoint`)。
 * ピッチと下穴径は規格表(`findMetricThread` + `threadMinorDiameter`、タスク11)から作り、
 * `expressionValueFromNumber` で式にする。利用者はプロパティで上書きできる(FR-202)。
 */
export function commitThreadHole(
  context: MachiningContext,
  params: {
    readonly designation: string;
    readonly series: ThreadSeries;
    readonly depth: HoleDepth;
    readonly threadLength: ExpressionValue;
    readonly representation: ThreadRepresentation;
    readonly tiltAngle: ExpressionValue;
    readonly tiltAzimuth: ExpressionValue;
  },
): SolidCommandOutcome {
  const face = resolveMachiningFace(context);
  if (!face.ok) {
    return { ok: false, reasonKey: face.reasonKey };
  }
  const centers = selectedCenterPoints(context.document, context.selection);
  if (centers.length === 0) {
    return { ok: false, reasonKey: 'machiningError.noCenterPoint' };
  }
  // 呼びが規格表に無い(想定外の値が渡された)ときは既定の呼びへ後退する。
  // DEFAULT_THREAD_DESIGNATION('M6')は表に必ずあるので fallback は必ず見つかる
  // (`as` / 非 null 断定を使わず、実行時のガードで TypeScript の型を絞る)。
  const fallback = findMetricThread(DEFAULT_THREAD_DESIGNATION);
  if (fallback === undefined) {
    throw new Error('DEFAULT_THREAD_DESIGNATION が METRIC_THREADS の表にありません。');
  }
  const size = findMetricThread(params.designation) ?? fallback;
  const pitch = metricThreadPitch(size, params.series);
  const drillDiameter = threadMinorDiameter(size.diameter, pitch);
  const id = nextSolidId(context.document, 'threadHole');
  const feature: ThreadHoleFeature = {
    id,
    name: nextSolidName(context.document, 'threadHole'),
    suppressed: false,
    kind: 'threadHole',
    targetFeatureId: face.targetFeatureId,
    face: face.ref,
    centers,
    designation: size.designation,
    series: params.series,
    pitch: expressionValueFromNumber(pitch),
    drillDiameter: expressionValueFromNumber(drillDiameter),
    depth: params.depth,
    threadLength: params.threadLength,
    representation: params.representation,
    tiltAngle: params.tiltAngle,
    tiltAzimuth: params.tiltAzimuth,
  };
  return { ok: true, document: appendSolid(context.document, feature), featureId: id };
}

/**
 * R 面取りを 1 つ作る(FR-407)。辺・頂点が 1 つも選ばれていなければ `noEdge`。
 * 頂点は集まる辺へ展開して保存する(§0.a-0.17)。展開した辺が複数の立体にまたがるとき
 * (辺の選択どうしが違う立体に属するとき)は `noTargetBody` で断る。
 */
export function commitFillet(
  context: MachiningContext,
  params: { readonly radius: ExpressionValue },
): SolidCommandOutcome {
  const targets = gatherFilletTargets(context);
  if (targets.length === 0) {
    return { ok: false, reasonKey: 'machiningError.noEdge' };
  }
  const target = machiningTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'machiningError.noTargetBody' };
  }
  const id = nextSolidId(context.document, 'fillet');
  const feature: FilletFeature = {
    id,
    name: nextSolidName(context.document, 'fillet'),
    suppressed: false,
    kind: 'fillet',
    targetFeatureId: target,
    targets,
    radius: params.radius,
  };
  return { ok: true, document: appendSolid(context.document, feature), featureId: id };
}

/**
 * C 面取りを 1 つ作る(FR-408)。断り方は R 面取りと同じ(`noEdge` / `noTargetBody`)。
 * 基準面の入替え(`swapReferenceFace`)は作成時には聞かず、既定 false で作り
 * プロパティで編集する(§0.a-0.18)。
 */
export function commitChamfer(
  context: MachiningContext,
  params: { readonly size: ChamferSize },
): SolidCommandOutcome {
  const targets = gatherFilletTargets(context);
  if (targets.length === 0) {
    return { ok: false, reasonKey: 'machiningError.noEdge' };
  }
  const target = machiningTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'machiningError.noTargetBody' };
  }
  const id = nextSolidId(context.document, 'chamfer');
  const feature: ChamferFeature = {
    id,
    name: nextSolidName(context.document, 'chamfer'),
    suppressed: false,
    kind: 'chamfer',
    targetFeatureId: target,
    targets,
    size: params.size,
    swapReferenceFace: false,
  };
  return { ok: true, document: appendSolid(context.document, feature), featureId: id };
}

/**
 * パターンの個数と「両側へ」の組み合わせを、確定前に断れるかだけ検査する
 * (NFR-UX-5「実行してから失敗させない」、計画書タスク29、§2.7 の過去の失敗
 * 「両側へ+偶数個は成立しない」)。範囲・文言は `resolvePart.ts` の `resolvePatternCount` /
 * `resolvePatternTransforms` と揃える(model 側の判断を書き写すだけで、新しい規則は作らない。
 * `resolvePart` は解決のたびに同じ検査をもう一度行うので、ここでの事前検査を通っても
 * 二重の安全網になるだけで壊れない)。
 */
function invalidPatternPlacementReasonKey(placement: PatternPlacement): MessageKey | null {
  if (placement.kind === 'points') {
    // 点集合(FR-425、P5 タスク43)は個数の欄を持たず、置き場所は点の数そのもの。
    // 事前に断る規則はまだ無い(道具はタスク50、解決はタスク46)。
    return null;
  }
  const count = placement.count.value;
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 2 || count > MAX_PATTERN_COUNT) {
    return 'machiningError.invalidPatternCount';
  }
  if (placement.kind === 'linear' && placement.symmetric && count % 2 === 0) {
    return 'machiningError.patternSymmetricNeedsOdd';
  }
  return null;
}

/**
 * パターンを 1 つ作る(FR-411、FR-412、§0.a-0.20)。繰り返す穴・ねじ穴が選ばれていなければ
 * `noPatternSource`、選ばれていても穴・ねじ穴でなければ `sourceNotHole`。
 *
 * 個数(`placement.count`)が 2〜`MAX_PATTERN_COUNT` の整数か、「両側へ」+偶数個でないかを
 * ここで先に検査して断る(計画書タスク29、NFR-UX-5)。`resolvePart`(§2.7)も解決のたびに
 * 同じ検査を行うが、それは保存済みの文書(手入力やファイル読み込み)に対する事後の安全網で、
 * ここでの事前検査とは目的が異なるため両方に置く(重複ではない)。
 */
export function commitPattern(
  context: MachiningContext,
  params: { readonly placement: PatternPlacement },
): SolidCommandOutcome {
  const source = selectedPatternSource(context.document, context.selection);
  if (!source.ok) {
    return { ok: false, reasonKey: source.reasonKey };
  }
  const invalidPlacementReasonKey = invalidPatternPlacementReasonKey(params.placement);
  if (invalidPlacementReasonKey !== null) {
    return { ok: false, reasonKey: invalidPlacementReasonKey };
  }
  const labelKey = params.placement.kind === 'linear' ? 'linearPattern' : 'circularPattern';
  const id = nextSolidId(context.document, labelKey);
  const feature: PatternFeature = {
    id,
    name: nextSolidName(context.document, labelKey),
    suppressed: false,
    kind: 'pattern',
    sourceFeatureId: source.sourceFeatureId,
    placement: params.placement,
  };
  return { ok: true, document: appendSolid(context.document, feature), featureId: id };
}

/**
 * その場入力の確定結果(タスク24 の `SolidInputCommit`)から加工を 1 つ作る。
 * 押し出し・回転・縫合・ばねはここでは扱わない(それぞれ `solidCommands.ts` /
 * タスク25b の担当)。`SolidInputCommit.tool` は `SolidToolId`(加工でない道具も含む)を
 * 使っているため、switch を網羅させるために「まだ使えない」を返す枝を残す
 * (`solidCommands.ts` の既存の枝と同じ文言 `solidError.notYetAvailable`)。
 */
export function commitMachiningInput(
  context: MachiningContext,
  commit: SolidInputCommit,
): SolidCommandOutcome {
  switch (commit.tool) {
    case 'hole': {
      const depth: HoleDepth =
        commit.flags.through === true
          ? { kind: 'through' }
          : { kind: 'blind', depth: commit.values.depth ?? DEFAULT_HOLE_DEPTH };
      return commitHole(context, {
        diameter: commit.values.diameter ?? DEFAULT_HOLE_DIAMETER,
        depth,
        tiltAngle: DEFAULT_TILT_ANGLE,
        tiltAzimuth: DEFAULT_TILT_AZIMUTH,
      });
    }
    case 'threadHole': {
      const depth: HoleDepth =
        commit.flags.through === true
          ? { kind: 'through' }
          : { kind: 'blind', depth: commit.values.depth ?? DEFAULT_HOLE_DEPTH };
      return commitThreadHole(context, {
        designation: commit.threadDesignation ?? DEFAULT_THREAD_DESIGNATION,
        series: commit.threadSeries ?? 'coarse',
        depth,
        threadLength: commit.values.threadLength ?? DEFAULT_THREAD_LENGTH,
        representation: commit.flags.modeledThread === true ? 'modeled' : 'simplified',
        tiltAngle: DEFAULT_TILT_ANGLE,
        tiltAzimuth: DEFAULT_TILT_AZIMUTH,
      });
    }
    case 'fillet':
      return commitFillet(context, { radius: commit.values.radius ?? DEFAULT_FILLET_RADIUS });
    case 'chamfer': {
      const mode = commit.chamferMode ?? 'equal';
      let size: ChamferSize;
      switch (mode) {
        case 'equal':
          size = {
            kind: 'equal',
            distance: commit.values.chamferDistance ?? DEFAULT_CHAMFER_DISTANCE,
          };
          break;
        case 'twoDistances':
          size = {
            kind: 'twoDistances',
            distance1: commit.values.chamferDistance ?? DEFAULT_CHAMFER_DISTANCE,
            distance2: commit.values.chamferDistance2 ?? DEFAULT_CHAMFER_DISTANCE,
          };
          break;
        case 'distanceAngle':
          size = {
            kind: 'distanceAngle',
            distance: commit.values.chamferDistance ?? DEFAULT_CHAMFER_DISTANCE,
            angle: commit.values.chamferAngle ?? DEFAULT_CHAMFER_ANGLE,
          };
          break;
      }
      return commitChamfer(context, { size });
    }
    case 'linearPattern': {
      const direction: PatternDirection = commit.axis ?? DEFAULT_LINEAR_PATTERN_DIRECTION;
      return commitPattern(context, {
        placement: {
          kind: 'linear',
          direction,
          spacing: commit.values.spacing ?? DEFAULT_PATTERN_SPACING,
          count: commit.values.count ?? DEFAULT_PATTERN_COUNT_VALUE,
          symmetric: commit.flags.patternSymmetric ?? false,
        },
      });
    }
    case 'circularPattern': {
      const axis: PatternDirection = commit.axis ?? DEFAULT_CIRCULAR_PATTERN_AXIS;
      return commitPattern(context, {
        placement: {
          kind: 'circular',
          axis,
          angle: commit.values.angle ?? DEFAULT_CIRCULAR_PATTERN_ANGLE,
          count: commit.values.count ?? DEFAULT_CIRCULAR_PATTERN_COUNT_VALUE,
          fullCircle: commit.flags.fullCircle ?? true,
        },
      });
    }
    case 'extrude':
    case 'revolve':
    case 'sew':
    case 'spring':
    case 'sphere':
    case 'box':
    case 'cylinder':
    case 'cone':
    case 'torus':
      /*
        加工でない道具(押し出し・回転・縫合)とばねはここでは作らない
        (それぞれ solidCommands.ts / タスク25b の担当)。**基本形状5種**(FR-429、
        P5 タスク18)も加工ではない(対象を消費しない「作る」フィーチャー、§0.a-0.19)ので
        `primitiveCommands.ts` の `commitPrimitive` の担当で、振り分けは
        `solidCommands.ts` の `commitSolidInput` が行う。ここは switch を網羅するための枝。
      */
      return { ok: false, reasonKey: 'solidError.notYetAvailable' };
  }
}

/**
 * その道具がいま押せるか(NFR-UX-5)。`solidToolReadiness`(solidCommands.ts)と同じ形で返す。
 * 判定は実際に作るときと同じ関数(`resolveMachiningFace` / `gatherFilletTargets` /
 * `machiningTargetOf` / `selectedPatternSource`)を使うので、「押せるのに断られる」
 * 「押せないのに作れる」が起きない。
 */
export function machiningToolReadiness(
  context: MachiningContext,
  tool: MachiningToolId,
): SolidToolReadiness {
  switch (tool) {
    case 'hole':
    case 'threadHole': {
      const face = resolveMachiningFace(context);
      if (!face.ok) {
        return { ready: false, reasonKey: face.reasonKey };
      }
      const centers = selectedCenterPoints(context.document, context.selection);
      return centers.length === 0
        ? { ready: false, reasonKey: 'machiningError.noCenterPoint' }
        : READY;
    }
    case 'fillet':
    case 'chamfer': {
      const targets = gatherFilletTargets(context);
      if (targets.length === 0) {
        return { ready: false, reasonKey: 'machiningError.noEdge' };
      }
      const target = machiningTargetOf(context);
      return target === null ? { ready: false, reasonKey: 'machiningError.noTargetBody' } : READY;
    }
    case 'linearPattern':
    case 'circularPattern': {
      const source = selectedPatternSource(context.document, context.selection);
      return source.ok ? READY : { ready: false, reasonKey: source.reasonKey };
    }
  }
}
