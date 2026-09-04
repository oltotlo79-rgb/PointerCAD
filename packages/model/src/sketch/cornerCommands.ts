/**
 * スケッチの角の丸め(フィレット)と面取り(FR-323、計画書 P4 §2.5・§0.a-0.10・
 * §0.a-0.20、タスク18)。
 *
 * 角を作る 2 本の線分を選び、
 * - **丸め**: 半径 r の円弧で丸める。2 本を接点まで縮め、円弧を 1 本足す。
 * - **面取り**: 角から各線に沿って距離 d1 / d2 だけ削り、その間を結ぶ線分を 1 本足す。
 *
 * ## 元のフィーチャーを書き換える
 *
 * 整形系なので履歴に新しい道具を積まず、**もとの線そのものを短くする**(統括の決定
 * §0.a-0.10)。書き換えるのは角を作っている側の端点だけで、反対側の端点の式は残る。
 * 書き換えた端点は確定したときの数値(絶対座標の数値リテラル)になる。理由はトリム・延長
 * (`trimExtend.ts` 冒頭)と同じで、接点は「相手の線」との関係で決まる値であり、参照の形で
 * 持たせると相手が履歴の後ろにいるときに前方参照になって解けないため。
 *
 * ## 複数の曲線を生む図形(矩形・正多角形・長穴)
 *
 * そのままでは 1 本ずつ短くできないので、先に線分・円弧の個別のフィーチャーへ分解してから
 * 丸める(`trimExtend.ts` の `explodeCompoundFeature` をそのまま使う)。分解・書き換え・
 * 追加をまとめて 1 つの新しい文書として返すので、取り消し(Undo)は 1 回で元へ戻る
 * (P2 の Undo は文書の差し替えを 1 段と数える、FR-505)。
 *
 * ## 形の計算そのものはカーネルの純関数(統括への報告事項)
 *
 * 接点・円弧の中心・角度を出す式は kernel の `makeSketchFillet2d.ts` /
 * `makeSketchChamfer2d.ts` が単一の正本を持つ(タスク19。OCCT を呼ばない純関数)。
 * ここは `kernelBridge.ts` の**同期の口**(`sketchFilletGeometry` /
 * `sketchChamferGeometry`)を通してそれを呼ぶ。経路と理由は同ファイルの注釈にある。
 * 断りの分け方は**このファイルで先に済ませる**ので、カーネルから飛んでくる `Error` は
 * 「半径・距離が線の長さに収まらない」1 通りだけになる(`refuseFromKernel`)。
 *
 * すべて純関数で、渡された文書を書き換えず新しい文書を返す。DOM には触れない。
 */

import { expressionValueFromNumber } from '@pointercad/expression';

import {
  sketchChamferGeometry,
  sketchFilletGeometry,
  type SketchChamferGeometry,
  type SketchCornerPlane,
  type SketchFilletGeometry,
} from '../kernelBridge.js';
import {
  absoluteCoordinate,
  appendFeature,
  nextFeatureId,
  nextFeatureName,
} from './createSketchDocument.js';
import { baseWorkPlane, isFreeWorkPlaneId, radiansToDegrees, type WorkPlane } from './planeMath.js';
import { resolveSketch, type SketchResolveOptions } from './resolveSketch.js';
import { explodeCompoundFeature, parseElementId, type TrimErrorKey } from './trimExtend.js';
import type {
  CoordinateInput,
  ResolvedSegment,
  ResolvedSketch,
  SketchArcFeature,
  SketchDocument,
  SketchFeature,
  SketchLineFeature,
} from './types.js';
import {
  crossVec3,
  dotVec3,
  isSamePoint,
  lengthVec3,
  normalizeVec3,
  SKETCH_TOLERANCE_MM,
  subVec3,
  type Vec3,
} from './vec3.js';

/**
 * 断る理由。画面の言い回し(ja.json)はこの鍵で選ぶ(タスク23)。
 * 文言もここで日本語のまま返すので、鍵を使わない側はそのまま出せる(FR-504、NFR-RE-1)。
 */
export type SketchCornerErrorKey =
  /** 指した要素が見つからない、またはまだ形が決まっていない。 */
  | 'missingElement'
  /** 線分どうしでない(円弧・楕円・スプライン・オフセットを含む角)。 */
  | 'unsupportedCurve'
  /** 同じ 1 本を 2 回指した。 */
  | 'sameElement'
  /** 2 本の作図面が違う。 */
  | 'differentPlane'
  /** 2 本が端点を共有していない(角になっていない)。 */
  | 'noSharedEndpoint'
  /** 一直線、または重なっていて角が無い。 */
  | 'straightCorner'
  /** 半径・距離が 0 以下、または数になっていない。 */
  | 'invalidValue'
  /** 角を作る線が作図面の上に乗っていない。 */
  | 'notOnPlane'
  /** 半径・距離が線の長さに収まらない。 */
  | 'tooLarge';

export type SketchCornerOutcome =
  | {
      readonly ok: true;
      readonly document: SketchDocument;
      /** 足した円弧(丸め)または線分(面取り)のフィーチャー id。 */
      readonly addedFeatureId: string;
      /** 端点を書き換えた 2 本のフィーチャー id(分解したときは分解後の id)。 */
      readonly trimmedFeatureIds: readonly [string, string];
    }
  | { readonly ok: false; readonly reason: SketchCornerErrorKey; readonly message: string };

/**
 * 角を作る 2 本の指定。`featureId`、または複数曲線フィーチャーの n 番目なら
 * `featureId#n`(トリム・延長と同じ書き方、`trimExtend.ts` の `parseElementId`)。
 */
export interface SketchCornerElements {
  readonly firstElementId: string;
  readonly secondElementId: string;
}

/** 角の丸め(FR-323)。 */
export interface SketchFilletRequest extends SketchCornerElements {
  /** 丸める半径(mm)。0 より大きい数。 */
  readonly radius: number;
}

/** 角の面取り(FR-323)。等距離の面取りなら 2 つに同じ値を入れる。 */
export interface SketchChamferRequest extends SketchCornerElements {
  /** 角から 1 本目の線に沿って削る距離(mm)。 */
  readonly distance1: number;
  /** 角から 2 本目の線に沿って削る距離(mm)。 */
  readonly distance2: number;
}

/** これ未満(ラジアン)の折れは角とみなさない(kernel の `sketchCorner.ts` と同じ考え方)。 */
const MIN_CORNER_ANGLE_RAD = 1e-6;

const UNSUPPORTED_MESSAGE = '丸め・面取りができるのは、2 本の線分が作る角だけです。';

function refuse(reason: SketchCornerErrorKey, message: string): SketchCornerOutcome {
  return { ok: false, reason, message };
}

/* ------------------------------------------------------------------ *
 * 対象の下ごしらえ(必要なら分解する)
 * ------------------------------------------------------------------ */

type PrepareOutcome =
  | {
      readonly ok: true;
      readonly document: SketchDocument;
      readonly featureIds: readonly [string, string];
    }
  | { readonly ok: false; readonly reason: SketchCornerErrorKey; readonly message: string };

/**
 * 分解が断った理由を、こちらの語彙へ写す。
 *
 * `explodeCompoundFeature` が返しうるのは「見つからない」と「分けられない種類」の
 * 2 つだけだが、戻り値の型はトリム・延長と共通の広い union(`TrimErrorKey`)なので、
 * 交点まわりの理由(`noIntersection` 等)を丸め・面取りの語彙へ持ち込まない。
 */
function explodeReason(reason: TrimErrorKey): SketchCornerErrorKey {
  return reason === 'unsupportedCurve' ? 'unsupportedCurve' : 'missingElement';
}

/** 1 フィーチャーが複数の曲線を生む図形(分解してから丸めるもの)か。 */
function isCompound(feature: SketchFeature): boolean {
  return feature.kind === 'rectangle' || feature.kind === 'polygon' || feature.kind === 'slot';
}

/**
 * 分解して新しくできたフィーチャーの id を、元の曲線の並び順で取り出す。
 *
 * `explodeCompoundFeature` は分解した破片を**元の図形があった位置へ順に差し込む**ので
 * (同関数の注釈)、「元の文書に無かった id」を文書の並び順に拾えば `featureId#n` の n と
 * 同じ順になる。分解の内部の作り(`explodeInto` の `createdIds`)は外へ出ていないため、
 * 差集合で数え直している。
 */
function createdIdsOf(before: SketchDocument, after: SketchDocument): readonly string[] {
  const known = new Set(before.features.map((feature) => feature.id));
  return after.features
    .filter((feature) => !known.has(feature.id))
    .map((feature) => feature.id);
}

/**
 * 分解する前に、指した 1 本が本当に線分かを確かめる。
 * 文書を変えずに断れるようにするため、分解より先に見る(NFR-UX-5)。
 */
function checkCompoundPick(
  resolved: ResolvedSketch,
  featureId: string,
  index: number | null,
): { readonly ok: false; readonly reason: SketchCornerErrorKey; readonly message: string } | null {
  const curves = resolved.curvesByFeature.get(featureId);
  if (curves === undefined || curves.length === 0) {
    return { ok: false, reason: 'missingElement', message: 'この図形はまだ形が決まっていません。' };
  }
  if (index === null) {
    return {
      ok: false,
      reason: 'unsupportedCurve',
      message: '図形のどの辺で角を作るかを 1 本ずつ選んでください。',
    };
  }
  const curve = index >= 0 && index < curves.length ? curves[index] : undefined;
  if (curve === undefined) {
    return { ok: false, reason: 'missingElement', message: 'その辺は見つかりません。' };
  }
  if (curve.kind !== 'segment') {
    return { ok: false, reason: 'unsupportedCurve', message: UNSUPPORTED_MESSAGE };
  }
  return null;
}

/**
 * 指された 2 つの要素を「線分フィーチャー 2 つ」にする。矩形・正多角形・長穴を
 * 指されたら、その場で分解してから選び直す。2 つが同じ図形の別の辺のときは
 * **1 回だけ分解する**(2 回分解すると 1 回目の id が消えて 2 回目が迷子になるため)。
 */
function prepareLines(
  document: SketchDocument,
  elements: SketchCornerElements,
  options: SketchResolveOptions,
): PrepareOutcome {
  const first = parseElementId(elements.firstElementId);
  const second = parseElementId(elements.secondElementId);
  const featureA = document.features.find((feature) => feature.id === first.featureId);
  const featureB = document.features.find((feature) => feature.id === second.featureId);
  if (featureA === undefined) {
    return {
      ok: false,
      reason: 'missingElement',
      message: `指した線が見つかりません: ${first.featureId}`,
    };
  }
  if (featureB === undefined) {
    return {
      ok: false,
      reason: 'missingElement',
      message: `指した線が見つかりません: ${second.featureId}`,
    };
  }

  // 同じ図形の同じ 1 本を 2 回指した場合。1 本では角にならない。
  if (first.featureId === second.featureId && first.index === second.index) {
    return { ok: false, reason: 'sameElement', message: '別々の 2 本の線を選んでください。' };
  }

  const resolved = resolveSketch(document, options);

  if (first.featureId === second.featureId) {
    // 同じ複数曲線フィーチャーの 2 辺(矩形の角など)。1 回の分解で両方を取り出す。
    if (!isCompound(featureA)) {
      return { ok: false, reason: 'sameElement', message: '別々の 2 本の線を選んでください。' };
    }
    const badA = checkCompoundPick(resolved, first.featureId, first.index);
    if (badA !== null) {
      return badA;
    }
    const badB = checkCompoundPick(resolved, second.featureId, second.index);
    if (badB !== null) {
      return badB;
    }
    const exploded = explodeCompoundFeature(document, first.featureId, options);
    if (!exploded.ok) {
      return { ok: false, reason: explodeReason(exploded.reason), message: exploded.message };
    }
    const created = createdIdsOf(document, exploded.document);
    const idA = created[first.index ?? -1];
    const idB = created[second.index ?? -1];
    if (idA === undefined || idB === undefined) {
      return { ok: false, reason: 'missingElement', message: 'その辺は見つかりません。' };
    }
    return { ok: true, document: exploded.document, featureIds: [idA, idB] };
  }

  // 別々のフィーチャー。片方ずつ、必要なら分解する。
  const stepA = prepareOne(document, resolved, featureA, first.index, options);
  if (!stepA.ok) {
    return stepA;
  }
  // 1 つ目を分解して文書が変わったので、2 つ目は新しい文書の上で解き直す。
  const middle = stepA.document;
  const featureB2 = middle.features.find((feature) => feature.id === second.featureId);
  if (featureB2 === undefined) {
    return {
      ok: false,
      reason: 'missingElement',
      message: `指した線が見つかりません: ${second.featureId}`,
    };
  }
  const stepB = prepareOne(
    middle,
    resolveSketch(middle, options),
    featureB2,
    second.index,
    options,
  );
  if (!stepB.ok) {
    return stepB;
  }
  return { ok: true, document: stepB.document, featureIds: [stepA.featureId, stepB.featureId] };
}

type PrepareOneOutcome =
  | { readonly ok: true; readonly document: SketchDocument; readonly featureId: string }
  | { readonly ok: false; readonly reason: SketchCornerErrorKey; readonly message: string };

/** 1 つの指定を線分フィーチャーへ直す(複数曲線フィーチャーなら分解する)。 */
function prepareOne(
  document: SketchDocument,
  resolved: ResolvedSketch,
  feature: SketchFeature,
  index: number | null,
  options: SketchResolveOptions,
): PrepareOneOutcome {
  if (!isCompound(feature)) {
    if (feature.kind !== 'line') {
      return { ok: false, reason: 'unsupportedCurve', message: UNSUPPORTED_MESSAGE };
    }
    return { ok: true, document, featureId: feature.id };
  }
  const bad = checkCompoundPick(resolved, feature.id, index);
  if (bad !== null) {
    return bad;
  }
  const exploded = explodeCompoundFeature(document, feature.id, options);
  if (!exploded.ok) {
    return { ok: false, reason: explodeReason(exploded.reason), message: exploded.message };
  }
  const created = createdIdsOf(document, exploded.document);
  const id = created[index ?? -1];
  if (id === undefined) {
    return { ok: false, reason: 'missingElement', message: 'その辺は見つかりません。' };
  }
  return { ok: true, document: exploded.document, featureId: id };
}

/* ------------------------------------------------------------------ *
 * 角の取り出し
 * ------------------------------------------------------------------ */

/** 下ごしらえが済み、角として成り立つことまで確かめた状態。 */
interface PreparedCorner {
  readonly document: SketchDocument;
  readonly feature1: SketchLineFeature;
  readonly feature2: SketchLineFeature;
  readonly segment1: ResolvedSegment;
  readonly segment2: ResolvedSegment;
  /** 2 本が共有している端点。 */
  readonly corner: Vec3;
  /** 角から見た 1 本目の反対の端(動かさない側)。 */
  readonly far1: Vec3;
  readonly far2: Vec3;
  /** 作図面。3D スケッチ(FR-330)なら null。 */
  readonly plane: WorkPlane | null;
}

type CornerOutcome =
  | { readonly ok: true; readonly corner: PreparedCorner }
  | { readonly ok: false; readonly reason: SketchCornerErrorKey; readonly message: string };

/** 線分フィーチャーとその解決結果を id で引く。 */
function lineOf(
  document: SketchDocument,
  resolved: ResolvedSketch,
  featureId: string,
): { readonly feature: SketchLineFeature; readonly segment: ResolvedSegment } | null {
  const feature = document.features.find((other) => other.id === featureId);
  if (feature === undefined || feature.kind !== 'line') {
    return null;
  }
  const segment = resolved.segments.find((curve) => curve.featureId === featureId);
  if (segment === undefined) {
    return null;
  }
  return { feature, segment };
}

/**
 * 2 本の線分が共有している端点と、そこから見たそれぞれの反対の端を探す。
 *
 * 4 通り(to-from / to-to / from-from / from-to)を順に調べ、最初に見つかった組を採る。
 * 線分の向き(from と to のどちらが先か)は利用者の描いた順で決まり、角の意味には
 * 関わらない。**kernel の `sketchCorner.ts` の `findSharedEndpoint` と同じ順に調べる**
 * ので、こちらで決めた「動かす端点」とカーネルが返す接点の対応がずれない。
 */
function sharedEndpoint(
  segment1: ResolvedSegment,
  segment2: ResolvedSegment,
): { readonly corner: Vec3; readonly far1: Vec3; readonly far2: Vec3 } | null {
  const ends1: readonly (readonly [Vec3, Vec3])[] = [
    [segment1.to, segment1.from],
    [segment1.from, segment1.to],
  ];
  const ends2: readonly (readonly [Vec3, Vec3])[] = [
    [segment2.from, segment2.to],
    [segment2.to, segment2.from],
  ];
  for (const [shared1, far1] of ends1) {
    for (const [shared2, far2] of ends2) {
      if (isSamePoint(shared1, shared2)) {
        return { corner: shared1, far1, far2 };
      }
    }
  }
  return null;
}

/** 角の 3 点が作図面の上に乗っているか(浮いていると円弧が線に接しない)。 */
function isOnPlane(plane: WorkPlane, points: readonly Vec3[]): boolean {
  return points.every(
    (point) => Math.abs(dotVec3(subVec3(point, plane.origin), plane.normal)) <= SKETCH_TOLERANCE_MM,
  );
}

/**
 * 指された 2 つを、角として使える形まで持っていく。
 * 途中で断ったときは文書を変えない(NFR-UX-5「実行してから失敗させない」)。
 */
function prepareCorner(
  document: SketchDocument,
  elements: SketchCornerElements,
  options: SketchResolveOptions,
): CornerOutcome {
  const prepared = prepareLines(document, elements, options);
  if (!prepared.ok) {
    return prepared;
  }
  const next = prepared.document;
  const resolved = resolveSketch(next, options);
  const line1 = lineOf(next, resolved, prepared.featureIds[0]);
  const line2 = lineOf(next, resolved, prepared.featureIds[1]);
  if (line1 === null || line2 === null) {
    return { ok: false, reason: 'missingElement', message: 'この線はまだ形が決まっていません。' };
  }
  if (line1.feature.planeId !== line2.feature.planeId) {
    return {
      ok: false,
      reason: 'differentPlane',
      message: '作図面が違う 2 本では角を作れません。',
    };
  }

  const shared = sharedEndpoint(line1.segment, line2.segment);
  if (shared === null) {
    return {
      ok: false,
      reason: 'noSharedEndpoint',
      message: '2 本の線が端点でつながっていません。角を作っている 2 本を選んでください。',
    };
  }

  // なす角。0 に近ければ 2 本が重なっており、π に近ければ一直線で、
  // どちらも接点が数値誤差に埋もれて意味を持たない(kernel の sketchCorner.ts と同じ判定)。
  const direction1 = normalizeVec3(subVec3(shared.far1, shared.corner));
  const direction2 = normalizeVec3(subVec3(shared.far2, shared.corner));
  const angle = Math.atan2(
    lengthVec3(crossVec3(direction1, direction2)),
    dotVec3(direction1, direction2),
  );
  if (angle <= MIN_CORNER_ANGLE_RAD || Math.PI - angle <= MIN_CORNER_ANGLE_RAD) {
    return {
      ok: false,
      reason: 'straightCorner',
      message: '2 本が一直線または重なっているため、丸める角がありません。',
    };
  }

  const planeId = line1.feature.planeId;
  const free = isFreeWorkPlaneId(planeId);
  const lookupPlane = options.workPlane ?? baseWorkPlane;
  const plane = free ? null : lookupPlane(planeId);
  if (!free && plane === null) {
    return {
      ok: false,
      reason: 'missingElement',
      message: `作図面が見つかりません: ${planeId}`,
    };
  }

  return {
    ok: true,
    corner: {
      document: next,
      feature1: line1.feature,
      feature2: line2.feature,
      segment1: line1.segment,
      segment2: line2.segment,
      corner: shared.corner,
      far1: shared.far1,
      far2: shared.far2,
      plane,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 書き換えと追加
 * ------------------------------------------------------------------ */

/** 相対・極座標で「直前の点」を基準にしているか(始点を動かすと終点も動く形)。 */
function dependsOnPrevious(input: CoordinateInput): boolean {
  return input.mode !== 'absolute' && input.base.kind === 'previous';
}

/**
 * 角の側の端点を、接点の数値へ書き換える。
 *
 * 始点を書き換えるときだけ、終点が「直前の点」から測っていないかを見る。線分の終点は
 * 始点を直前の点として解かれる(`resolveSketch.ts` の line の節、FR-307 の連続描画)ので、
 * 始点を動かすと**動かさないはずの終点まで一緒に動いてしまう**。その場合だけ終点も
 * 確定した数値へ固定する(形を変えないための最小限の固定)。
 */
function trimmedLine(
  feature: SketchLineFeature,
  segment: ResolvedSegment,
  corner: Vec3,
  moved: Vec3,
): SketchLineFeature {
  const at = absoluteCoordinate(moved[0], moved[1], moved[2]);
  if (isSamePoint(segment.from, corner)) {
    const to = dependsOnPrevious(feature.to)
      ? absoluteCoordinate(segment.to[0], segment.to[1], segment.to[2])
      : feature.to;
    return { ...feature, from: at, to };
  }
  return { ...feature, to: at };
}

/**
 * 足す曲線の構築線フラグ。**両方が構築線のときだけ構築線にする。**
 * 片方でも実体の線なら、丸めた角も実体でないと輪郭が途切れるため(FR-320)。
 */
function addedConstruction(feature1: SketchLineFeature, feature2: SketchLineFeature): boolean {
  return feature1.construction && feature2.construction;
}

/** 2 本を書き換えた文書を作る。 */
function applyTrims(
  prepared: PreparedCorner,
  moved1: Vec3,
  moved2: Vec3,
): SketchDocument {
  const next1 = trimmedLine(prepared.feature1, prepared.segment1, prepared.corner, moved1);
  const next2 = trimmedLine(prepared.feature2, prepared.segment2, prepared.corner, moved2);
  return {
    ...prepared.document,
    features: prepared.document.features.map((feature) => {
      if (feature.id === next1.id) {
        return next1;
      }
      if (feature.id === next2.id) {
        return next2;
      }
      return feature;
    }),
  };
}

/**
 * カーネルの純関数が投げた `Error` を断りへ直す。
 *
 * 角として成り立つこと・半径が正であること・作図面に乗っていることは、ここへ来る前に
 * すべて確かめてある(`prepareCorner` と各コマンドの冒頭)。だから残るのは
 * 「半径・距離が線の長さに収まらない」だけで、文言はカーネルのものをそのまま見せる。
 */
function refuseFromKernel(error: unknown): SketchCornerOutcome {
  const message =
    error instanceof Error
      ? error.message
      : '丸め・面取りの大きさが線に収まりません。小さくしてください。';
  return refuse('tooLarge', message);
}

/* ------------------------------------------------------------------ *
 * 丸め(フィレット)
 * ------------------------------------------------------------------ */

/**
 * 丸めの円弧を置く面。作図面があればそれを使い、3D スケッチ(FR-330)なら
 * 角そのものから作る(2 本の線が張る平面は 1 つに決まる)。
 */
function cornerPlaneOf(prepared: PreparedCorner): SketchCornerPlane {
  if (prepared.plane !== null) {
    return {
      origin: prepared.plane.origin,
      normal: prepared.plane.normal,
      axisU: prepared.plane.axisU,
    };
  }
  const direction1 = normalizeVec3(subVec3(prepared.far1, prepared.corner));
  const direction2 = normalizeVec3(subVec3(prepared.far2, prepared.corner));
  return {
    origin: prepared.corner,
    normal: normalizeVec3(crossVec3(direction1, direction2)),
    axisU: direction1,
  };
}

/**
 * 角を半径 r の円弧で丸める(FR-323)。
 *
 * 2 本の線を接点まで縮め、その間を埋める円弧を履歴の末尾へ足す。直角の角を半径 5 で
 * 丸めれば、接点は角から 5mm、円弧の中心は角から 5√2 mm の位置に来る。
 */
export function filletCorner(
  document: SketchDocument,
  request: SketchFilletRequest,
  options: SketchResolveOptions = {},
): SketchCornerOutcome {
  if (!Number.isFinite(request.radius) || request.radius <= 0) {
    return refuse('invalidValue', '丸める半径は 0 より大きい数にしてください。');
  }
  const outcome = prepareCorner(document, request, options);
  if (!outcome.ok) {
    return refuse(outcome.reason, outcome.message);
  }
  const prepared = outcome.corner;
  const plane = cornerPlaneOf(prepared);
  if (prepared.plane !== null) {
    // 作図面から浮いた線どうしの角は、円弧を作図面の上に置くと線に接しない。
    if (!isOnPlane(prepared.plane, [prepared.corner, prepared.far1, prepared.far2])) {
      return refuse(
        'notOnPlane',
        '角を作る線が作図面の上に乗っていないため、丸められません。',
      );
    }
  }

  let geometry: SketchFilletGeometry;
  try {
    geometry = sketchFilletGeometry(
      prepared.segment1,
      prepared.segment2,
      plane,
      request.radius,
    );
  } catch (error) {
    return refuseFromKernel(error);
  }

  const trimmed = applyTrims(prepared, geometry.trimmed1, geometry.trimmed2);
  const arc: SketchArcFeature = {
    id: nextFeatureId(trimmed, 'arc'),
    name: nextFeatureName(trimmed, 'arc'),
    planeId: prepared.feature1.planeId,
    kind: 'arc',
    center: absoluteCoordinate(
      geometry.arcCenter[0],
      geometry.arcCenter[1],
      geometry.arcCenter[2],
    ),
    radius: expressionValueFromNumber(geometry.arcRadius),
    startAngle: expressionValueFromNumber(radiansToDegrees(geometry.arcStartAngle)),
    endAngle: expressionValueFromNumber(radiansToDegrees(geometry.arcEndAngle)),
    construction: addedConstruction(prepared.feature1, prepared.feature2),
  };
  // 3D スケッチ(作図面なし)の円弧は、自分で向きを持たないと解けない(FR-330、タスク10)。
  const withOrientation: SketchArcFeature =
    prepared.plane === null
      ? {
          ...arc,
          freeOrientation: {
            normal: absoluteCoordinate(plane.normal[0], plane.normal[1], plane.normal[2]),
            xAxis: absoluteCoordinate(plane.axisU[0], plane.axisU[1], plane.axisU[2]),
          },
        }
      : arc;

  return {
    ok: true,
    document: appendFeature(trimmed, withOrientation),
    addedFeatureId: withOrientation.id,
    trimmedFeatureIds: [prepared.feature1.id, prepared.feature2.id],
  };
}

/* ------------------------------------------------------------------ *
 * 面取り
 * ------------------------------------------------------------------ */

/**
 * 角を距離 d1 / d2 で斜めに切る(FR-323)。
 *
 * 2 本の線を角から距離のぶんだけ縮め、その 2 点を結ぶ線分を履歴の末尾へ足す。
 * 直角の角を距離 3 の等距離で面取りすれば、面取りの線の長さは 3·√2 になる。
 * 作図面を使わないので、3D スケッチ(FR-330)の角でもそのまま働く。
 */
export function chamferCorner(
  document: SketchDocument,
  request: SketchChamferRequest,
  options: SketchResolveOptions = {},
): SketchCornerOutcome {
  if (
    !Number.isFinite(request.distance1) ||
    request.distance1 <= 0 ||
    !Number.isFinite(request.distance2) ||
    request.distance2 <= 0
  ) {
    return refuse('invalidValue', '面取りの距離は 0 より大きい数にしてください。');
  }
  const outcome = prepareCorner(document, request, options);
  if (!outcome.ok) {
    return refuse(outcome.reason, outcome.message);
  }
  const prepared = outcome.corner;

  let geometry: SketchChamferGeometry;
  try {
    geometry = sketchChamferGeometry(
      prepared.segment1,
      prepared.segment2,
      request.distance1,
      request.distance2,
    );
  } catch (error) {
    return refuseFromKernel(error);
  }

  const trimmed = applyTrims(prepared, geometry.trimmed1, geometry.trimmed2);
  const line: SketchLineFeature = {
    id: nextFeatureId(trimmed, 'line'),
    name: nextFeatureName(trimmed, 'line'),
    planeId: prepared.feature1.planeId,
    kind: 'line',
    from: absoluteCoordinate(
      geometry.trimmed1[0],
      geometry.trimmed1[1],
      geometry.trimmed1[2],
    ),
    to: absoluteCoordinate(geometry.trimmed2[0], geometry.trimmed2[1], geometry.trimmed2[2]),
    construction: addedConstruction(prepared.feature1, prepared.feature2),
  };

  return {
    ok: true,
    document: appendFeature(trimmed, line),
    addedFeatureId: line.id,
    trimmedFeatureIds: [prepared.feature1.id, prepared.feature2.id],
  };
}
