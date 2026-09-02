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
  appendFeature,
  DEFAULT_FACE_COLOR,
  nextFeatureId,
  nextFeatureName,
  type CoordinateInput,
  type PointReference,
  type ResolvedSketch,
  type SketchDocument,
  type SketchElementRef,
  type WorkPlaneId,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type { NumericInputCommit } from './numericInput.js';

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
  /** 「続けてかく」が入かどうか(FR-307)。切なら次の基準を持ち越さない。 */
  readonly chaining: boolean;
  /** 線分の始点・円弧の中心・点列の基準として先に決めた座標。まだ無ければ null。 */
  readonly pendingStart: CoordinateInput | null;
}

export interface CommitOutcome {
  readonly document: SketchDocument;
  /** 次の段階へ持ち越す座標。持ち越すものが無ければ null。 */
  readonly pendingStart: CoordinateInput | null;
}

/**
 * 決定された 1 段階を履歴へ反映する。
 *
 * 2 段階でひと組の道具(線分・円弧・点列)は、前半では履歴を変えずに `pendingStart` へ
 * 覚えるだけにする。後半で前半の値が無いときは、壊れた形を黙って作らずに何もしない。
 * どの段階の次に何を聞くかは `nextNumericInput`(numericInput.ts)の担当。
 */
export function commitSketchInput(
  commit: NumericInputCommit,
  context: CommitContext,
): CommitOutcome {
  return commit.kind === 'coordinate'
    ? commitCoordinate(commit.step, commit.coordinate, context)
    : commitShape(commit.step, commit.values, context);
}

/** 座標を 1 点決めた段階(点・線分の始点と終点・円弧の中心・点列の基準点)。 */
function commitCoordinate(
  step: NumericInputCommit['step'],
  coordinate: CoordinateInput,
  context: CommitContext,
): CommitOutcome {
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
        // 終点の基準は自分の始点。resolveSketch が線分の終点をそう解決する。
        to: rebase(coordinate, { kind: 'previous' }),
      });
      return { document: next, pendingStart: chaining ? continueFrom(id) : null };
    }

    case 'arcShape':
    case 'pointArrayShape':
      // 座標ではなく欄の値を聞く段階。ここへは来ない。
      return { document, pendingStart };
  }
}

/** 座標ではなく欄の値を決めた段階(円弧の形・点列の並べ方)。 */
function commitShape(
  step: NumericInputCommit['step'],
  values: readonly ExpressionValue[],
  context: CommitContext,
): CommitOutcome {
  const { document, planeId, pendingStart } = context;

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
      });
      return { document: next, pendingStart: null };
    }

    case 'pointArrayShape': {
      if (pendingStart === null || values.length < 3) {
        return { document, pendingStart: null };
      }
      // 欄の並びは「角度・間隔・個数」(numericInput.ts の SHAPE_FIELDS)。
      const next = appendFeature(document, {
        id: nextFeatureId(document, 'pointArray'),
        name: nextFeatureName(document, 'pointArray'),
        planeId,
        kind: 'pointArray',
        base: pendingStart,
        azimuth: values[0],
        spacing: values[1],
        count: values[2],
      });
      return { document: next, pendingStart: null };
    }

    case 'point':
    case 'lineStart':
    case 'lineEnd':
    case 'arcCenter':
    case 'pointArrayBase':
      // 座標を聞く段階。ここへは来ない。
      return { document, pendingStart };
  }
}

/** 面の境界に選ばれた要素の種類。 */
export type BoundaryElementKind = 'point' | 'curve' | 'unknown';

/**
 * 選んだ要素が点なのか線・円弧なのかを見分ける(§0.a-0.13)。
 * 点列の n 番目は解決済みの点の id(`featureId#n`)でそのまま引ける。
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
    resolved.arcs.some((arc) => arc.featureId === elementId)
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
