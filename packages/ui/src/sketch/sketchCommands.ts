/**
 * その場数値入力で決まった値を、スケッチの履歴へ積む形へ直す
 * (計画書 docs/plans/P1-式とスケッチ.md タスク21 手順2)。
 *
 * 対応要件: FR-301〜309(点・線分・円弧・点列・面を作る)、FR-307(続けてかく)。
 *
 * ここは DOM にもストアにも触れない純関数だけを置く。履歴の差し替えは呼び出し側
 * (`AppShell` と `attachSketchInteraction`)が行い、この層は「同じ入力からは必ず
 * 同じ履歴ができる」ことだけを受け持つ。副作用が無いので Node の単体検査で固定できる。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  DEFAULT_FACE_COLOR,
  isFreeWorkPlaneId,
  nextFeatureId,
  nextFeatureName,
  type CoordinateInput,
  type FreeArcOrientation,
  type PointReference,
  type ResolvedSketch,
  type SketchDocument,
  type SketchElementRef,
  type SubShapeRef,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type { NumericInputCommit, NumericInputState } from './numericInput.js';
import {
  commitShapeInput,
  EMPTY_SHAPE_DRAFT,
  type ShapeCommitOutcome,
  type ShapeDraft,
} from './shapeCommands.js';

const ZERO: ExpressionValue = expressionValueFromNumber(0);

/**
 * 「その要素の終わりの端から続ける」ことを表す座標(FR-307)。
 *
 * 直前の点を指す `{ kind: 'previous' }` ではなく、作ったばかりの要素を名指しする。
 * 名指しなら、後から間に別の要素を入れても続きの線がずれない(FR-311、FR-502 の土台)。
 */
export function continueFrom(featureId: string): CoordinateInput {
  return {
    mode: 'relative',
    base: { kind: 'vertex', featureId, vertex: 'end' },
    dx: ZERO,
    dy: ZERO,
    dz: ZERO,
  };
}

/**
 * 「立体の頂点(部分形状)の位置」を表す座標(FR-330、タスク10・14)。
 *
 * `continueFrom` と同じ「基準を名指しして、ずれ 0 で置く」形にしてある(計画書タスク14 の
 * 推奨どおり `CoordinateInput` のモードを増やさない)。基準が指すのは選んだ瞬間の指紋なので、
 * 立体の形が変わっても指紋で選び直され、点がその頂点に付いて動く(FR-311、FR-502)。
 */
export function subShapeCoordinate(ref: SubShapeRef): CoordinateInput {
  return {
    mode: 'relative',
    base: { kind: 'subShape', ref },
    dx: ZERO,
    dy: ZERO,
    dz: ZERO,
  };
}

/**
 * 立体の頂点を押して 3D スケッチの点を 1 つ作る(FR-330、計画書タスク14)。
 *
 * 数値を打つ経路(`commitSketchInput` の `point` の段)と並ぶ、もう 1 つの点の作り方。
 * 押した瞬間に決まるので、その場数値入力のポップアップは開かない。
 */
export function commitSubShapePoint(
  document: SketchDocument,
  planeId: WorkPlaneId,
  ref: SubShapeRef,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'point'),
    name: nextFeatureName(document, 'point'),
    planeId,
    kind: 'point',
    at: subShapeCoordinate(ref),
  });
}

/**
 * 3D スケッチの円弧の向き(FR-330、タスク10 の `freeOrientation`)を、押していた面から作る。
 *
 * 作図面が無いので、円弧が乗る平面と角度 0 の向きを円弧自身が持つ必要がある。3D スケッチで
 * 中心を押したときの面(`freeSketch.ts` の `freeClickPlane`。画面に正対する面)をそのまま
 * 使うので、**押した場所に見えているとおりの向き**で円弧ができる。
 * 向きを後から変えるのはプロパティ欄の役目(タスク33)。
 */
export function freeArcOrientationOf(plane: WorkPlane): FreeArcOrientation {
  return {
    normal: absoluteCoordinate(plane.normal[0], plane.normal[1], plane.normal[2]),
    xAxis: absoluteCoordinate(plane.axisU[0], plane.axisU[1], plane.axisU[2]),
  };
}

/** 相対・極の基準だけを差し替える。絶対座標は基準を持たないのでそのまま返す。 */
function rebase(coordinate: CoordinateInput, base: PointReference): CoordinateInput {
  if (coordinate.mode === 'relative') {
    return { ...coordinate, base };
  }
  if (coordinate.mode === 'polar') {
    return { ...coordinate, base };
  }
  return coordinate;
}

/**
 * 線分の終点の基準を「直前の点」(= 自分の始点)へそろえる(FR-307)。
 *
 * ただし基準が**別のものを名指ししている**ときは、その名指しをそのまま残す。3D スケッチで
 * 立体の頂点を押して終点を決めると基準は `subShape`(その頂点)になり(FR-330、タスク14)、
 * これを「直前の点からのずれ 0」へ置き換えると終点が始点と同じ場所になって、
 * 長さ 0 の線分ができてしまう(2026-09-04 の撮影で実際に「線分の長さが 0 です。」が出た)。
 */
function rebaseLineEnd(coordinate: CoordinateInput): CoordinateInput {
  if (coordinate.mode !== 'absolute' && coordinate.base.kind !== 'previous') {
    return coordinate;
  }
  return rebase(coordinate, { kind: 'previous' });
}

/** 選択中の要素 id を、面の境界の参照へ直す(点列の n 番目は `featureId#n`)。 */
export function toElementRef(elementId: string): SketchElementRef {
  const separator = elementId.indexOf('#');
  if (separator < 0) {
    return { featureId: elementId };
  }
  return {
    featureId: elementId.slice(0, separator),
    index: Number(elementId.slice(separator + 1)),
  };
}

export interface CommitContext {
  readonly document: SketchDocument;
  /** 作るフィーチャーの作図面。極座標の角度と円弧の向きの基準になる。 */
  readonly planeId: WorkPlaneId;
  /**
   * `planeId` を解いた面(FR-328、タスク13・14)。任意の作業平面は部品文書を見ないと
   * 決まらないので、解くのは呼び出し側(`commitToStore.ts` の `drawingPlane`)にする。
   * 3D スケッチ(`planeId` が `FREE_WORK_PLANE_ID`)のときは、押した場所の面が入る。
   */
  readonly plane: WorkPlane;
  /** 「続けてかく」が入かどうか(FR-307)。切なら次の基準を持ち越さない。 */
  readonly chaining: boolean;
  /** 線分の始点・円弧の中心・点列の基準として先に決めた座標。まだ無ければ null。 */
  readonly pendingStart: CoordinateInput | null;
  /**
   * P4 の新しい図形の途中経過(タスク12)。矩形・長穴・楕円・スプラインのように
   * 点や欄の値を段をまたいで積む道具が使う。渡さなければ空の下書きから始める。
   */
  readonly shapeDraft?: ShapeDraft;
  /**
   * 確定した段のポップアップの状態。P4 の新しい図形が欄の値を名前で引くのに要る
   * (`valueByFieldKey`)。P1 の段(線分・円弧・点列の直線状)は欄の並びで読むので要らない。
   */
  readonly input?: NumericInputState;
}

export interface CommitOutcome {
  readonly document: SketchDocument;
  /** 次の段階へ持ち越す座標。持ち越すものが無ければ null。 */
  readonly pendingStart: CoordinateInput | null;
  /** 次の段階へ持ち越す新しい図形の途中経過(タスク12)。 */
  readonly shapeDraft: ShapeDraft;
  /** 図形を作れなかった理由(NFR-UX-5)。断っていなければ null。 */
  readonly rejection: string | null;
}

/** P1 の道具の 1 段の結果。新しい図形の下書きは動かさないので 2 つで足りる。 */
interface BasicCommitOutcome {
  readonly document: SketchDocument;
  readonly pendingStart: CoordinateInput | null;
}

/**
 * P4 の新しい図形(FR-314〜318、FR-326、FR-327)が受け持つ段。
 * 一覧を表で持つのは、段が増えたときにここを直し忘れると型検査で落ちるようにするため
 * (`numericInput.ts` の `COORDINATE_STEPS` と同じ作り)。
 * 点列(`pointArrayShape`)は並べ方で分かれるので、ここではなく `isShapeStep` が見る。
 */
const SHAPE_STEPS: Readonly<Partial<Record<NumericInputCommit['step'], true>>> = {
  circleCenter: true,
  circleRadius: true,
  twoPointArcStart: true,
  twoPointArcEnd: true,
  twoPointArcRadius: true,
  threePointArcStart: true,
  threePointArcEnd: true,
  threePointArcVia: true,
  rectangleCorner1: true,
  rectangleCorner2: true,
  polygonCenter: true,
  polygonShape: true,
  slotCenter1: true,
  slotCenter2: true,
  slotShape: true,
  ellipseCenter: true,
  ellipseShape: true,
  ellipseAngles: true,
  ellipseArcAngles: true,
  splinePoint: true,
  splineShape: true,
  pointArrayGridColumns: true,
};

/** その段を `shapeCommands.ts`(タスク12)へ渡すか。 */
function isShapeStep(commit: NumericInputCommit): boolean {
  if (commit.step === 'pointArrayShape') {
    // 点列は並べ方で分かれる。直線状は P1 のまま、円周・格子は新しい図形の側が受け持つ。
    const layout = commit.choices.pointArrayLayout;
    return layout === 'circular' || layout === 'grid';
  }
  return SHAPE_STEPS[commit.step] === true;
}

function fromShapeOutcome(outcome: ShapeCommitOutcome): CommitOutcome {
  return {
    document: outcome.document,
    pendingStart: outcome.pendingStart,
    shapeDraft: outcome.draft,
    rejection: outcome.rejection,
  };
}

/**
 * 決定された 1 段階を履歴へ反映する。
 *
 * 2 段階でひと組の道具(線分・円弧・点列)は、前半では履歴を変えずに `pendingStart` へ
 * 覚えるだけにする。後半で前半の値が無いときは、壊れた形を黙って作らずに何もしない。
 * どの段階の次に何を聞くかは `nextNumericInput`(numericInput.ts)の担当。
 *
 * P4 で足した新しい図形(FR-314〜318、FR-326、FR-327)の段は `shapeCommands.ts` が
 * 受け持つ。点を 2 つ以上置く道具や、欄の値を段をまたいで持ち越す道具があり、
 * `pendingStart`(座標 1 つ)では足りないため(タスク12)。
 */
export function commitSketchInput(
  commit: NumericInputCommit,
  context: CommitContext,
): CommitOutcome {
  const shapeDraft = context.shapeDraft ?? EMPTY_SHAPE_DRAFT;
  if (isShapeStep(commit)) {
    return fromShapeOutcome(
      commitShapeInput(commit, {
        document: context.document,
        planeId: context.planeId,
        plane: context.plane,
        pendingStart: context.pendingStart,
        draft: shapeDraft,
        input: context.input ?? null,
      }),
    );
  }
  const outcome =
    commit.kind === 'coordinate'
      ? commitCoordinate(commit.step, commit.coordinate, context)
      : commitShape(commit.step, commit.values, context);
  return { ...outcome, shapeDraft, rejection: null };
}

/** 座標を 1 点決めた段階(点・線分の始点と終点・円弧の中心・点列の基準点)。 */
function commitCoordinate(
  step: NumericInputCommit['step'],
  coordinate: CoordinateInput,
  context: CommitContext,
): BasicCommitOutcome {
  const { document, planeId, chaining, pendingStart } = context;

  switch (step) {
    case 'point': {
      const next = appendFeature(document, {
        id: nextFeatureId(document, 'point'),
        name: nextFeatureName(document, 'point'),
        planeId,
        kind: 'point',
        at: coordinate,
      });
      return { document: next, pendingStart: null };
    }

    case 'lineStart':
    case 'arcCenter':
    case 'pointArrayBase':
      // 前半は履歴を変えず、後半で使う座標だけを覚える。
      return { document, pendingStart: coordinate };

    case 'lineEnd': {
      if (pendingStart === null) {
        return { document, pendingStart: null };
      }
      const id = nextFeatureId(document, 'line');
      const next = appendFeature(document, {
        id,
        name: nextFeatureName(document, 'line'),
        planeId,
        kind: 'line',
        from: pendingStart,
        // 終点の基準は自分の始点。resolveSketch が線分の終点をそう解決する
        // (名指しの基準があるときはそちらを残す。`rebaseLineEnd` の注釈)。
        to: rebaseLineEnd(coordinate),
        // 構築線(FR-320)を作る道具はタスク11・12 の範囲。ここでは既定の false を積む。
        construction: false,
      });
      return { document: next, pendingStart: chaining ? continueFrom(id) : null };
    }

    case 'circleCenter':
    case 'twoPointArcStart':
    case 'twoPointArcEnd':
    case 'threePointArcStart':
    case 'threePointArcEnd':
    case 'threePointArcVia':
    case 'rectangleCorner1':
    case 'rectangleCorner2':
    case 'polygonCenter':
    case 'slotCenter1':
    case 'slotCenter2':
    case 'ellipseCenter':
    case 'splinePoint':
      // P4 の新しい図形(FR-314〜318、FR-326、FR-330)。commitSketchInput が
      // shapeCommands.ts へ先に渡すのでここへは来ないが、段の網羅を型検査で保つために枝を残す。
      return { document, pendingStart };

    case 'arcShape':
    case 'pointArrayShape':
    case 'pointArrayGridColumns':
    case 'circleRadius':
    case 'twoPointArcRadius':
    case 'polygonShape':
    case 'slotShape':
    case 'ellipseShape':
    case 'ellipseAngles':
    case 'ellipseArcAngles':
    case 'splineShape':
      // 座標ではなく欄の値を聞く段階。ここへは来ない。
      return { document, pendingStart };
  }
}

/** 座標ではなく欄の値を決めた段階(円弧の形・点列の直線状の並べ方)。 */
function commitShape(
  step: NumericInputCommit['step'],
  values: readonly ExpressionValue[],
  context: CommitContext,
): BasicCommitOutcome {
  const { document, planeId, plane, pendingStart } = context;

  switch (step) {
    case 'arcShape': {
      if (pendingStart === null || values.length < 3) {
        return { document, pendingStart: null };
      }
      // 欄の並びは「半径・開始角・終了角」(numericInput.ts の SHAPE_FIELDS)。
      const next = appendFeature(document, {
        id: nextFeatureId(document, 'arc'),
        name: nextFeatureName(document, 'arc'),
        planeId,
        kind: 'arc',
        center: pendingStart,
        radius: values[0],
        startAngle: values[1],
        endAngle: values[2],
        // 構築線(FR-320)を作る道具はタスク11・12 の範囲。ここでは既定の false を積む。
        construction: false,
        // 3D スケッチ(FR-330)では作図面から向きを借りられないので、押していた面から作る
        // (タスク10 の `freeOrientation`。作図面があるときは model が無視するので付けない)。
        ...(isFreeWorkPlaneId(planeId) ? { freeOrientation: freeArcOrientationOf(plane) } : {}),
      });
      return { document: next, pendingStart: null };
    }

    case 'pointArrayShape': {
      if (pendingStart === null || values.length < 3) {
        return { document, pendingStart: null };
      }
      // 欄の並びは「角度・間隔・個数」(numericInput.ts の SHAPE_FIELDS)。
      // 円周上・格子状(FR-327)は shapeCommands.ts が受け持つ(isShapeStep が振り分ける)。
      const next = appendFeature(document, {
        id: nextFeatureId(document, 'pointArray'),
        name: nextFeatureName(document, 'pointArray'),
        planeId,
        kind: 'pointArray',
        layout: {
          kind: 'linear',
          base: pendingStart,
          azimuth: values[0],
          spacing: values[1],
          count: values[2],
        },
      });
      return { document: next, pendingStart: null };
    }

    case 'pointArrayGridColumns':
    case 'circleRadius':
    case 'twoPointArcRadius':
    case 'polygonShape':
    case 'slotShape':
    case 'ellipseShape':
    case 'ellipseAngles':
    case 'ellipseArcAngles':
    case 'splineShape':
      // P4 の新しい図形(FR-314〜318、FR-326、FR-327)。commitSketchInput が
      // shapeCommands.ts へ先に渡すのでここへは来ないが、段の網羅のために枝は残す。
      return { document, pendingStart };

    case 'point':
    case 'lineStart':
    case 'lineEnd':
    case 'arcCenter':
    case 'pointArrayBase':
    case 'circleCenter':
    case 'twoPointArcStart':
    case 'twoPointArcEnd':
    case 'threePointArcStart':
    case 'threePointArcEnd':
    case 'threePointArcVia':
    case 'rectangleCorner1':
    case 'rectangleCorner2':
    case 'polygonCenter':
    case 'slotCenter1':
    case 'slotCenter2':
    case 'ellipseCenter':
    case 'splinePoint':
      // 座標を聞く段階。ここへは来ない。
      return { document, pendingStart };
  }
}

/** 面の境界に選ばれた要素の種類。 */
export type BoundaryElementKind = 'point' | 'curve' | 'unknown';

/**
 * 選んだ要素が点なのか曲線なのかを見分ける(§0.a-0.13)。
 * 点列の n 番目は解決済みの点の id(`featureId#n`)でそのまま引ける。
 *
 * P4 タスク12 で楕円(`ellipses`)とスプライン(`splines`)も曲線として数えるようにした。
 * 矩形・正多角形・長穴は 1 フィーチャーが複数の線分・円弧を生むが、どの曲線も
 * `featureId` はそのフィーチャーの id なので、`segments` / `arcs` の走査でそのまま当たる
 * (`resolveFace` が index 省略で全周を展開する、§0.a-0.8)。
 */
export function boundaryElementKind(
  resolved: ResolvedSketch,
  elementId: string,
): BoundaryElementKind {
  if (resolved.points.some((point) => point.id === elementId)) {
    return 'point';
  }
  if (
    resolved.segments.some((segment) => segment.featureId === elementId) ||
    resolved.arcs.some((arc) => arc.featureId === elementId) ||
    resolved.ellipses.some((ellipse) => ellipse.featureId === elementId) ||
    resolved.splines.some((spline) => spline.featureId === elementId)
  ) {
    return 'curve';
  }
  return 'unknown';
}

export type FaceCommitOutcome =
  | { readonly ok: true; readonly document: SketchDocument }
  /** 断った理由。文言は ja.json から引く(NFR-MA-5、NFR-UX-5)。 */
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 点だけで面を張るのに要る最小の個数。 */
const MIN_FACE_POINTS = 3;

/**
 * 選んだ要素から面を作る(FR-309、FR-310)。選んだ順がそのまま境界の順になる。
 *
 * 点だけ、または線・円弧だけを並べる(§0.a-0.13)。混ざっていたら履歴を変えずに
 * 理由を返し、壊れたフィーチャーを積まない。閉じているかどうかの判定は
 * `resolveSketch` の担当なので、ここでは種類と個数だけを見る。
 */
export function commitFace(
  document: SketchDocument,
  resolved: ResolvedSketch,
  planeId: WorkPlaneId,
  selection: readonly string[],
  color: string = DEFAULT_FACE_COLOR,
): FaceCommitOutcome {
  if (selection.length === 0) {
    return { ok: false, reasonKey: 'face.error.emptySelection' };
  }

  const kinds = selection.map((elementId) => boundaryElementKind(resolved, elementId));
  if (kinds.includes('unknown')) {
    return { ok: false, reasonKey: 'face.error.unsupportedElement' };
  }
  if (kinds.includes('point') && kinds.includes('curve')) {
    return { ok: false, reasonKey: 'face.error.mixedBoundary' };
  }
  if (kinds[0] === 'point' && selection.length < MIN_FACE_POINTS) {
    return { ok: false, reasonKey: 'face.error.tooFewPoints' };
  }

  return {
    ok: true,
    document: appendFeature(document, {
      id: nextFeatureId(document, 'face'),
      name: nextFeatureName(document, 'face'),
      planeId,
      kind: 'face',
      boundary: selection.map((elementId) => toElementRef(elementId)),
      color,
    }),
  };
}
