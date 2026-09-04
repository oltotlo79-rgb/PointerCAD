/**
 * スケッチの角の丸め(フィレット)と面取り(FR-323、計画書 docs/plans/P4-スケッチ拡張.md
 * タスク23、§0.a-0.10・§0.a-0.20)。
 *
 * 利用者から見た振る舞いは 2 通りあり、**どちらの順でも同じ結果になる**(NFR-UX-1)。
 *
 * - **道具を先に選ぶ**: 「編集 ▾」でフィレット/面取りを選び、角(端点を共有する 2 本の
 *   線分の交わる所)へマウスを乗せると、丸めた形・面取りした形が薄く予告される。押すと
 *   その 2 本が選ばれ、半径(既定 5mm)/距離(既定 3mm)を聞く小さな欄が開く。Enter で確定。
 *   道具は選ばれたまま残るので、続けて別の角も丸められる。Esc で終わる。
 * - **2 本を先に選ぶ**: 選択の道具で角を作る 2 本の線分を選んでからフィレット/面取りを
 *   押すと、その場で同じ欄が開く。
 *
 * どちらの道でも、確定が読むのは「選択に入っている 2 本」の 1 通りだけになる。
 *
 * ## ここが持つもの / 持たないもの
 *
 * **形の計算は 1 つも持たない。** 接点・円弧の中心・角度を出す式は kernel の
 * `makeSketchFillet2d.ts` / `makeSketchChamfer2d.ts` が単一の正本を持ち(タスク19。OCCT を
 * 呼ばない閉じた式)、文書の書き換え(2 本を接点まで縮めて円弧/線分を 1 本足す)は model の
 * `cornerCommands.ts`(タスク18)が持つ。ここがするのは
 *
 * 1. マウスの位置から「どの角か」を決める(`cornerNear`)、
 * 2. 確定に使うのとまったく同じ式で予告の折れ線を作る(`cornerPreview`)、
 * 3. 選択と欄の値を model の `filletCorner` / `chamferCorner` の引数へ詰め替え、断りの鍵を
 *    画面の文言キー(ja.json)へ移し替える(`commitSketchFillet` / `commitSketchChamfer`)
 *
 * の 3 つだけである。**トリム・延長の予告(`trimPreview.ts`)が model の区間の決め方を写して
 * いるのとは対照的に、ここは写しを 1 行も持たない。** 角の形は「2 本の線分と半径」だけで
 * 決まり、文書を解き直さずに同じ関数(`sketchFilletGeometry` / `sketchChamferGeometry`)を
 * そのまま呼べるため(だから予告と確定が食い違いようがない)。
 *
 * DOM にもストアにも触れない純関数だけを置く。
 */

import type { ExpressionValue } from '@pointercad/expression';
import {
  chamferCorner,
  crossVec3,
  distanceVec3,
  dotVec3,
  filletCorner,
  isSamePoint,
  lengthVec3,
  normalizeVec3,
  sketchChamferGeometry,
  sketchFilletGeometry,
  subVec3,
  type ResolvedSegment,
  type ResolvedSketch,
  type SketchCornerErrorKey,
  type SketchCornerPlane,
  type SketchDocument,
  type SketchElementRef,
  type SketchResolveOptions,
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import {
  DEFAULT_SKETCH_CHAMFER_DISTANCE_MM,
  DEFAULT_SKETCH_FILLET_RADIUS_MM,
  type EditInputCommit,
} from './numericInput.js';
import { ARC_SEGMENTS_PER_TURN } from './sampleCurve.js';
import type { EditPreview } from './trimPreview.js';

/** 1 周(ラジアン)。円弧を折れ線へ割るときの分母。 */
const FULL_TURN = 2 * Math.PI;

/**
 * これ未満(ラジアン)の折れは角とみなさない。model の `cornerCommands.ts` の
 * `MIN_CORNER_ANGLE_RAD` と同じ値で、一直線・重なりをここでも先に外しておく
 * (予告が出た角がクリックで断られる、という食い違いを作らないため。NFR-UX-5)。
 */
const MIN_CORNER_ANGLE_RAD = 1e-6;

/** 角を作れる図形の種類。矩形・正多角形・長穴は model が辺へ分解してから丸める。 */
const CORNER_FEATURE_KINDS: readonly string[] = ['line', 'rectangle', 'polygon', 'slot'];

/** 角の丸め・面取りに使う 2 本の線分と、その 2 本が共有している端点。 */
export interface CornerHit {
  /** 1 本目の要素 id。矩形などの n 番目の辺なら `featureId#n`(model と同じ書き方)。 */
  readonly firstElementId: string;
  readonly secondElementId: string;
  /** 2 本が共有している端点(= 角)。 */
  readonly corner: Vec3;
  readonly first: ResolvedSegment;
  readonly second: ResolvedSegment;
}

/* ------------------------------------------------------------------ *
 * どの角を指しているか
 * ------------------------------------------------------------------ */

/** 角の材料になる線分 1 本と、その要素 id。 */
interface CornerSegment {
  readonly elementId: string;
  readonly segment: ResolvedSegment;
}

/**
 * 角の材料になる線分をすべて数え上げる(FR-323)。
 *
 * 対象は**線分そのもの**と、**矩形・正多角形・長穴の辺**に限る。オフセット・複写・投影の
 * 結果も `curvesByFeature` には並ぶが、model の `filletCorner` はそれらを
 * `unsupportedCurve` として断る(元のフィーチャーを書き換える道具なので、参照で
 * 追従している複製を直接は縮められない)。断られるものを予告に出さないよう、ここで
 * 文書の種類を見て先に外す(NFR-UX-5「実行してから失敗させない」)。
 */
export function cornerSegments(
  document: SketchDocument,
  resolved: ResolvedSketch,
): readonly CornerSegment[] {
  const found: CornerSegment[] = [];
  for (const feature of document.features) {
    if (!CORNER_FEATURE_KINDS.includes(feature.kind)) {
      continue;
    }
    const group = resolved.curvesByFeature.get(feature.id);
    if (group !== undefined) {
      group.forEach((curve, index) => {
        if (curve.kind === 'segment') {
          found.push({ elementId: `${feature.id}#${String(index)}`, segment: curve });
        }
      });
      continue;
    }
    const segment = resolved.segments.find((candidate) => candidate.featureId === feature.id);
    if (segment !== undefined) {
      found.push({ elementId: feature.id, segment });
    }
  }
  return found;
}

/** 2 本が共有している端点。共有していなければ null(model の `sharedEndpoint` と同じ 4 通り)。 */
function sharedCorner(first: ResolvedSegment, second: ResolvedSegment): Vec3 | null {
  for (const a of [first.to, first.from]) {
    for (const b of [second.from, second.to]) {
      if (isSamePoint(a, b)) {
        return a;
      }
    }
  }
  return null;
}

/** 角から見た、その線分の反対の端(動かさない側)。 */
function farEndOf(segment: ResolvedSegment, corner: Vec3): Vec3 {
  return isSamePoint(segment.from, corner) ? segment.to : segment.from;
}

/**
 * 2 本のなす角(ラジアン)。0 に近ければ重なっており、π に近ければ一直線で、どちらも
 * 丸める角が無い(model の `prepareCorner` と同じ判定)。
 */
function cornerAngle(first: ResolvedSegment, second: ResolvedSegment, corner: Vec3): number {
  const direction1 = normalizeVec3(subVec3(farEndOf(first, corner), corner));
  const direction2 = normalizeVec3(subVec3(farEndOf(second, corner), corner));
  return Math.atan2(
    lengthVec3(crossVec3(direction1, direction2)),
    dotVec3(direction1, direction2),
  );
}

/** 角として成り立つ 2 本かどうか(共有する端点があり、一直線でも重なりでもない)。 */
function cornerOf(first: CornerSegment, second: CornerSegment): Vec3 | null {
  const corner = sharedCorner(first.segment, second.segment);
  if (corner === null) {
    return null;
  }
  const angle = cornerAngle(first.segment, second.segment, corner);
  if (angle <= MIN_CORNER_ANGLE_RAD || Math.PI - angle <= MIN_CORNER_ANGLE_RAD) {
    return null;
  }
  return corner;
}

/**
 * マウスの位置にいちばん近い角(FR-323)。`maxDistance`(世界の mm)より遠い角は返さない。
 *
 * 端点が `maxDistance` の中に入っている線分だけを先に絞ってから組み合わせを見るので、
 * 要素が増えても総当たりにはならない(NFR-PF-1。マウスが動くたびに呼ばれる)。
 */
export function cornerNear(
  document: SketchDocument,
  resolved: ResolvedSketch,
  at: Vec3,
  maxDistance: number,
): CornerHit | null {
  const near = cornerSegments(document, resolved).filter(
    (candidate) =>
      Math.min(distanceVec3(at, candidate.segment.from), distanceVec3(at, candidate.segment.to)) <=
      maxDistance,
  );
  let best: CornerHit | null = null;
  let bestDistance = maxDistance;
  for (let i = 0; i < near.length; i += 1) {
    for (let j = i + 1; j < near.length; j += 1) {
      const corner = cornerOf(near[i], near[j]);
      if (corner === null) {
        continue;
      }
      const distance = distanceVec3(at, corner);
      if (distance > bestDistance) {
        continue;
      }
      bestDistance = distance;
      best = {
        firstElementId: near[i].elementId,
        secondElementId: near[j].elementId,
        corner,
        first: near[i].segment,
        second: near[j].segment,
      };
    }
  }
  return best;
}

/**
 * 選んでいる 2 つが角を作っているか(FR-323、NFR-UX-1 の「選んでから道具」の側)。
 * 作っていればその角を返す。ツールバーが「押した瞬間に欄を開いてよいか」の判断に使う。
 */
export function cornerFromSelection(
  document: SketchDocument,
  resolved: ResolvedSketch,
  selection: readonly string[],
): CornerHit | null {
  if (selection.length !== 2) {
    return null;
  }
  const segments = cornerSegments(document, resolved);
  const first = segments.find((candidate) => candidate.elementId === selection[0]);
  const second = segments.find((candidate) => candidate.elementId === selection[1]);
  if (first === undefined || second === undefined) {
    return null;
  }
  const corner = cornerOf(first, second);
  if (corner === null) {
    return null;
  }
  return {
    firstElementId: first.elementId,
    secondElementId: second.elementId,
    corner,
    first: first.segment,
    second: second.segment,
  };
}

/* ------------------------------------------------------------------ *
 * 予告(丸めたあと・面取りしたあとの形)
 * ------------------------------------------------------------------ */

/**
 * 丸めの円弧を置く面。作図面があればそれを使い、3D スケッチ(FR-330、作図面なし)なら
 * 角そのものから作る(2 本の線が張る平面は 1 つに決まる)。model の `cornerPlaneOf` が
 * 確定のときに作るのと同じ面で、**角度 0 の向き(axisU)まで同じ**にしてある。
 */
export function cornerPlaneOf(hit: CornerHit, plane: WorkPlane | null): SketchCornerPlane {
  if (plane !== null) {
    return { origin: plane.origin, normal: plane.normal, axisU: plane.axisU };
  }
  const direction1 = normalizeVec3(subVec3(farEndOf(hit.first, hit.corner), hit.corner));
  const direction2 = normalizeVec3(subVec3(farEndOf(hit.second, hit.corner), hit.corner));
  return {
    origin: hit.corner,
    normal: normalizeVec3(crossVec3(direction1, direction2)),
    axisU: direction1,
  };
}

/** 予告に出す形の指定。欄に入っている値をそのまま渡す。 */
export type CornerShape =
  | { readonly kind: 'fillet'; readonly radius: number }
  | { readonly kind: 'chamfer'; readonly distance1: number; readonly distance2: number };

/** 円弧を折れ線へ割る(角度は plane.axisU を 0 とし plane.normal まわりに正)。 */
function arcPolyline(
  plane: SketchCornerPlane,
  center: Vec3,
  radius: number,
  startAngle: number,
  endAngle: number,
): readonly Vec3[] {
  const axisV = crossVec3(plane.normal, plane.axisU);
  const sweep = Math.abs(endAngle - startAngle);
  const divisions = Math.max(1, Math.ceil((sweep / FULL_TURN) * ARC_SEGMENTS_PER_TURN));
  const points: Vec3[] = [];
  for (let index = 0; index <= divisions; index += 1) {
    const angle = startAngle + (endAngle - startAngle) * (index / divisions);
    const cos = Math.cos(angle) * radius;
    const sin = Math.sin(angle) * radius;
    points.push([
      center[0] + plane.axisU[0] * cos + axisV[0] * sin,
      center[1] + plane.axisU[1] * cos + axisV[1] * sin,
      center[2] + plane.axisU[2] * cos + axisV[2] * sin,
    ]);
  }
  return points;
}

/**
 * 角の丸め・面取りの予告(FR-323、NFR-UX-5「押す前に何が起きるかが見えている」)。
 *
 * 出すのは **「角へ戻る 2 本 + 新しい曲線」でできた閉じた折れ線**で、削り落とされる
 * 小さなくさびと、そこへ入る円弧/線分がひと目で読める。半径・距離が線に収まらないときは
 * 何も出さない(理由はクリックしたときに帯へ出る)。
 *
 * 形を出す式は確定と同じ `sketchFilletGeometry` / `sketchChamferGeometry` なので、
 * 予告と確定がずれることはない。
 */
export function cornerPreview(
  hit: CornerHit,
  plane: WorkPlane | null,
  shape: CornerShape,
): EditPreview | null {
  const cornerPlane = cornerPlaneOf(hit, plane);
  try {
    if (shape.kind === 'chamfer') {
      const geometry = sketchChamferGeometry(
        hit.first,
        hit.second,
        shape.distance1,
        shape.distance2,
      );
      return {
        kind: 'chamfer',
        points: [hit.corner, geometry.trimmed1, geometry.trimmed2, hit.corner],
      };
    }
    const geometry = sketchFilletGeometry(hit.first, hit.second, cornerPlane, shape.radius);
    const arc = arcPolyline(
      cornerPlane,
      geometry.arcCenter,
      geometry.arcRadius,
      geometry.arcStartAngle,
      geometry.arcEndAngle,
    );
    // 円弧の向き(始点がどちらの線の接点か)は角の並び順で入れ替わるので、
    // 1 本目の接点に近いほうを先頭にして 1 本の折れ線としてつなぐ。
    const ordered =
      distanceVec3(arc[0], geometry.trimmed1) <= distanceVec3(arc[arc.length - 1], geometry.trimmed1)
        ? arc
        : [...arc].reverse();
    return { kind: 'fillet', points: [hit.corner, ...ordered, hit.corner] };
  } catch {
    // 半径・距離が線に収まらない(kernel が投げる唯一の断り)。予告は出さない。
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 確定
 * ------------------------------------------------------------------ */

/**
 * model の断り 9 種と、画面に出す文言(ja.json)の対応。
 *
 * model 側(`cornerCommands.ts` の `SketchCornerErrorKey`)は日本語の文も一緒に返すが、
 * UI の文言はすべて `ja.json` に置く決まり(NFR-MA-5)なので、ここで鍵へ移し替える。
 * 種類が増えたらこの表が型検査で落ちるので、文言の足し忘れが起きない
 * (`editCommands.ts` の `TRIM_ERROR_KEYS` と同じ作り)。
 */
const CORNER_ERROR_KEYS: Readonly<Record<SketchCornerErrorKey, MessageKey>> = {
  missingElement: 'corner.error.missingElement',
  unsupportedCurve: 'corner.error.unsupportedCurve',
  sameElement: 'corner.error.sameElement',
  differentPlane: 'corner.error.differentPlane',
  noSharedEndpoint: 'corner.error.noSharedEndpoint',
  straightCorner: 'corner.error.straightCorner',
  invalidValue: 'corner.error.invalidValue',
  notOnPlane: 'corner.error.notOnPlane',
  tooLarge: 'corner.error.tooLarge',
};

/** 断りの鍵を画面の文言キーへ。 */
export function cornerErrorMessageKey(reason: SketchCornerErrorKey): MessageKey {
  return CORNER_ERROR_KEYS[reason];
}

export type CornerCommitOutcome =
  | {
      readonly ok: true;
      readonly document: SketchDocument;
      /** 足した円弧(丸め)または線分(面取り)。確定後はこれを選んでおく。 */
      readonly featureId: string;
      /**
       * 丸めた 2 本を境界に使っている面があったか(t18 の申し送り)。真なら
       * 「面の境界に足した曲線を入れ直してください」と案内する(FR-504、NFR-UX-7)。
       */
      readonly boundaryNeedsUpdate: boolean;
    }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 選択の 2 つを model の指定へ。2 つ選ばれていなければ null。 */
function elementsFrom(
  selection: readonly string[],
): { readonly firstElementId: string; readonly secondElementId: string } | null {
  return selection.length === 2
    ? { firstElementId: selection[0], secondElementId: selection[1] }
    : null;
}

/** 欄の値(式の評価値)。欄が無いときは既定値(NFR-UX-4「Enter 連打で意味のある結果」)。 */
function valueOf(field: ExpressionValue | undefined, fallback: number): number {
  return field?.value ?? fallback;
}

/**
 * 面の境界(`SketchFaceFeature.boundary`)が、いま丸める 2 本を使っているか。
 *
 * 使っていれば、丸めたあとの輪郭は「短くなった 2 本 + 足した曲線」になるので、面の境界へ
 * 足した曲線を入れ直さないと輪郭が閉じない(t18 の申し送り。model は面を書き換えない)。
 * 要素 id の `featureId#n` は、面の境界では `index` に分かれて入るので突き合わせる。
 */
export function facesUseCorner(
  document: SketchDocument,
  selection: readonly string[],
): boolean {
  const wanted = selection.map((elementId) => {
    const [featureId, index] = elementId.split('#');
    return { featureId, index: index === undefined ? undefined : Number(index) };
  });
  const uses = (reference: SketchElementRef): boolean =>
    wanted.some(
      (target) =>
        target.featureId === reference.featureId &&
        // 面が全周(index 省略)を指しているなら、その図形のどの辺でも当てはまる。
        (reference.index === undefined || target.index === undefined || reference.index === target.index),
    );
  return document.features.some(
    (feature) => feature.kind === 'face' && feature.boundary.some(uses),
  );
}

/**
 * 角を丸める(FR-323)。選んでいる 2 本と欄の半径を model の `filletCorner` へ渡すだけで、
 * 幾何の判断も文書の書き換えもここには無い。
 *
 * 矩形・正多角形・長穴の角を丸めると、model がその図形を線分・円弧へ**分解してから**
 * 丸める。分解・書き換え・追加はまとめて 1 つの新しい文書になるので、取り消し(Ctrl+Z)は
 * 1 回で分解前の図形へ戻る(FR-505)。
 */
export function commitSketchFillet(
  document: SketchDocument,
  selection: readonly string[],
  commit: EditInputCommit,
  options: SketchResolveOptions = {},
): CornerCommitOutcome {
  const elements = elementsFrom(selection);
  if (elements === null) {
    return { ok: false, reasonKey: 'corner.error.needTwoLines' };
  }
  const outcome = filletCorner(
    document,
    {
      ...elements,
      radius: valueOf(commit.values.cornerRadius, DEFAULT_SKETCH_FILLET_RADIUS_MM),
    },
    options,
  );
  if (!outcome.ok) {
    return { ok: false, reasonKey: CORNER_ERROR_KEYS[outcome.reason] };
  }
  return {
    ok: true,
    document: outcome.document,
    featureId: outcome.addedFeatureId,
    boundaryNeedsUpdate: facesUseCorner(document, selection),
  };
}

/**
 * 角を面取りする(FR-323)。「等距離」なら 2 本とも同じ距離だけ削り、「2つの距離」なら
 * 1 本目・2 本目を別々の距離だけ削る。欄の並びは決め方の選択肢で変わるので、2 つ目の欄が
 * 無いとき(等距離)は 1 つ目の値をそのまま使う。
 */
export function commitSketchChamfer(
  document: SketchDocument,
  selection: readonly string[],
  commit: EditInputCommit,
  options: SketchResolveOptions = {},
): CornerCommitOutcome {
  const elements = elementsFrom(selection);
  if (elements === null) {
    return { ok: false, reasonKey: 'corner.error.needTwoLines' };
  }
  const distance1 = valueOf(commit.values.cornerDistance1, DEFAULT_SKETCH_CHAMFER_DISTANCE_MM);
  const distance2 =
    commit.choices.chamferMode === 'twoDistances'
      ? valueOf(commit.values.cornerDistance2, distance1)
      : distance1;
  const outcome = chamferCorner(document, { ...elements, distance1, distance2 }, options);
  if (!outcome.ok) {
    return { ok: false, reasonKey: CORNER_ERROR_KEYS[outcome.reason] };
  }
  return {
    ok: true,
    document: outcome.document,
    featureId: outcome.addedFeatureId,
    boundaryNeedsUpdate: facesUseCorner(document, selection),
  };
}
