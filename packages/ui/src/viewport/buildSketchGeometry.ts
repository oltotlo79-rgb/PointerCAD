/**
 * 解決済みスケッチを描画用の並びへ組み立てる(計画書 docs/plans/P1-式とスケッチ.md タスク20 手順1)。
 *
 * 対応要件: FR-105(表示スタイル)、FR-310(面の色)、NFR-PF-1(60fps)。
 *
 * three.js にも DOM にも触れない純関数だけを置く。組み立てた結果は
 * `createSketchLayer.ts` が受け取り、要素数が変わらなければ並びの中身だけを差し替える。
 * 強調(ホバー・選択)は色を後から塗り分けるのではなく、**別の並び**へ入れて分ける。
 * 頂点ごとの色を持たせるより並びが単純になり、変化したときの差し替えも小さくて済む。
 */

import type {
  ResolvedFace,
  ResolvedSketch,
  SketchFaceMesh,
  SketchMesh,
} from '@pointercad/model';

import { sampleCurve, toLineSegmentPositions } from '../sketch/sampleCurve.js';

/** 強調の度合い。選択が最も強く、ホバーはその手前(FR-106)。 */
export type SketchEmphasis = 'none' | 'hovered' | 'selected';

/** 強調の度合いごとに分けた位置の並び。three.js では別の材質で描く。 */
export interface EmphasisBuffers {
  readonly none: Float32Array;
  readonly hovered: Float32Array;
  readonly selected: Float32Array;
}

export type SketchDrawKind = 'point' | 'curve' | 'face';

/** 要素 id と描画の対応表の 1 行。当たった要素の見た目を後から追えるようにする。 */
export interface SketchDrawEntry {
  /** 点列の中の 1 点なら `featureId#n`、それ以外は featureId と同じ(pickMath.ts と揃える)。 */
  readonly elementId: string;
  readonly featureId: string;
  readonly kind: SketchDrawKind;
  readonly emphasis: SketchEmphasis;
  /** 入っている並び(kind と emphasis で決まる)の中での開始位置。数値の個数で数える。 */
  readonly offset: number;
  /** 占める数値の個数。縁を別に描かない面は 0。 */
  readonly length: number;
  /** 面の三角形が届いていれば `faces` の何番目か。届いていなければ null。 */
  readonly meshIndex: number | null;
}

/** 面 1 枚の三角形。カーネルが返した形に強調の度合いを添えたもの(FR-310)。 */
export interface SketchFaceDraw {
  readonly featureId: string;
  /** "#rrggbb"。面ごとに違う色を持てる(FR-310)。 */
  readonly color: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly emphasis: SketchEmphasis;
}

/** ホバーと選択(ストアの `hoveredElementId` / `selection` をそのまま渡す)。 */
export interface SketchHighlight {
  readonly hoveredElementId: string | null;
  readonly selection: readonly string[];
}

export interface SketchGeometryBundle {
  /** 点。1 点あたり 3 個。 */
  readonly points: EmphasisBuffers;
  /** 線・円弧。線分 1 本あたり 6 個(円弧は折れ線に分ける)。 */
  readonly curves: EmphasisBuffers;
  /** 面の縁。線分 1 本あたり 6 個。 */
  readonly faceOutlines: EmphasisBuffers;
  /** 三角形が届いている面だけ。届いていない面は縁だけを見せる。 */
  readonly faces: readonly SketchFaceDraw[];
  /** 要素 id → 描画の場所。並びは 点 → 線・円弧 → 面 の順。 */
  readonly index: ReadonlyMap<string, SketchDrawEntry>;
}

export const NO_HIGHLIGHT: SketchHighlight = { hoveredElementId: null, selection: [] };

/** 何も無いスケッチ。起動直後と、片付けたあとの初期値に使う。 */
export const EMPTY_RESOLVED_SKETCH: ResolvedSketch = {
  points: [],
  segments: [],
  arcs: [],
  ellipses: [],
  splines: [],
  pendingOffsets: [],
  curvesByFeature: new Map(),
  faces: [],
  errors: [],
};

/** 組み立て途中の並び。強調の度合いごとに 1 本ずつ持つ。 */
interface Sink {
  readonly none: number[];
  readonly hovered: number[];
  readonly selected: number[];
}

interface Placement {
  readonly offset: number;
  readonly length: number;
}

function createSink(): Sink {
  return { none: [], hovered: [], selected: [] };
}

/** 並びの末尾へ足し、どこへ入ったかを返す。値の数が多くなるので展開(...)では渡さない。 */
function pushInto(sink: Sink, emphasis: SketchEmphasis, values: readonly number[]): Placement {
  const target = sink[emphasis];
  const offset = target.length;
  for (const value of values) {
    target.push(value);
  }
  return { offset, length: values.length };
}

function toBuffers(sink: Sink): EmphasisBuffers {
  return {
    none: new Float32Array(sink.none),
    hovered: new Float32Array(sink.hovered),
    selected: new Float32Array(sink.selected),
  };
}

/**
 * 要素 1 つの強調の度合いを決める。選択がホバーより強い。
 * 点列の 1 点(`pa1#0`)は、点列そのもの(`pa1`)が選ばれているときも強調する。
 * ツリーやプロパティからはフィーチャー単位で選ぶため(FR-501)。
 */
export function emphasisOf(
  elementId: string,
  featureId: string,
  highlight: SketchHighlight,
  selection: ReadonlySet<string>,
): SketchEmphasis {
  if (selection.has(elementId) || selection.has(featureId)) {
    return 'selected';
  }
  const hovered = highlight.hoveredElementId;
  if (hovered !== null && (hovered === elementId || hovered === featureId)) {
    return 'hovered';
  }
  return 'none';
}

/**
 * 面の縁を線分の並びにする。
 *
 * 面の境界が線・円弧のフィーチャー(FR-309)なら、その線は既に「線・円弧」として
 * 描いているので縁は引かない。同じ位置に色違いの線を 2 本重ねると、視点によって
 * どちらが手前になるかが入れ替わって色がちらつくため。
 * 点だけで張った面(境界の線がフィーチャーとして存在しない)だけを縁として引く。
 *
 * カーネルの結果があるときはその境界(線分1本あたり6要素の並び、
 * docs/報告記録.md 2026-09-02 21:03)を使い、まだ届いていなければ
 * 解決済みの曲線から引く。計算の間だけ輪郭が消えるのを避けるため。
 */
function faceOutlineValues(
  face: ResolvedFace,
  faceMesh: SketchFaceMesh | undefined,
  drawnCurveFeatureIds: ReadonlySet<string>,
): number[] {
  const own = face.curves.filter((curve) => !drawnCurveFeatureIds.has(curve.featureId));
  if (own.length === 0) {
    return [];
  }
  if (faceMesh !== undefined) {
    return Array.from(faceMesh.boundaryPositions);
  }
  // 解決済みの面の曲線は既に閉じた輪になっている(resolveSketch が確かめている)ので、
  // 最後から最初へ引き直さない。曲線ごとに線分へ分けるだけでよい。
  const values: number[] = [];
  for (const curve of own) {
    for (const value of toLineSegmentPositions(sampleCurve(curve))) {
      values.push(value);
    }
  }
  return values;
}

/**
 * 解決済みスケッチとカーネルの面から、描画用の並び一式を組み立てる。
 *
 * 変化したときにだけ呼ぶ(毎フレーム呼ばない、NFR-PF-1)。
 */
export function buildSketchGeometry(
  sketch: ResolvedSketch,
  mesh: SketchMesh | null,
  highlight: SketchHighlight = NO_HIGHLIGHT,
): SketchGeometryBundle {
  const selection = new Set(highlight.selection);
  const points = createSink();
  const curves = createSink();
  const faceOutlines = createSink();
  const index = new Map<string, SketchDrawEntry>();

  for (const point of sketch.points) {
    const emphasis = emphasisOf(point.id, point.featureId, highlight, selection);
    const placement = pushInto(points, emphasis, point.position);
    index.set(point.id, {
      elementId: point.id,
      featureId: point.featureId,
      kind: 'point',
      emphasis,
      offset: placement.offset,
      length: placement.length,
      meshIndex: null,
    });
  }

  const drawnCurveFeatureIds = new Set<string>();
  // 楕円(FR-318)とスプライン(FR-317)も線として描く(P4 タスク12)。`sampleCurve` が
  // どの種類も折れ線へ直すので、ここは 4 種を並べるだけでよい。矩形・正多角形・長穴は
  // 1 フィーチャーが複数の線分・円弧を生むが、どれも `featureId` が同じなので
  // 同じ強調・同じ引き当てで 1 つの図形としてまとまる(§0.a-0.8)。
  for (const curve of [
    ...sketch.segments,
    ...sketch.arcs,
    ...sketch.ellipses,
    ...sketch.splines,
  ]) {
    const emphasis = emphasisOf(curve.featureId, curve.featureId, highlight, selection);
    const placement = pushInto(curves, emphasis, toLineSegmentPositions(sampleCurve(curve)));
    drawnCurveFeatureIds.add(curve.featureId);
    index.set(curve.featureId, {
      elementId: curve.featureId,
      featureId: curve.featureId,
      kind: 'curve',
      emphasis,
      offset: placement.offset,
      length: placement.length,
      meshIndex: null,
    });
  }

  const meshByFeature = new Map<string, SketchFaceMesh>();
  for (const faceMesh of mesh?.faces ?? []) {
    meshByFeature.set(faceMesh.featureId, faceMesh);
  }

  const faces: SketchFaceDraw[] = [];
  for (const face of sketch.faces) {
    const emphasis = emphasisOf(face.featureId, face.featureId, highlight, selection);
    const faceMesh = meshByFeature.get(face.featureId);
    const placement = pushInto(
      faceOutlines,
      emphasis,
      faceOutlineValues(face, faceMesh, drawnCurveFeatureIds),
    );
    let meshIndex: number | null = null;
    if (faceMesh !== undefined) {
      meshIndex = faces.length;
      faces.push({
        featureId: face.featureId,
        color: faceMesh.color,
        positions: faceMesh.positions,
        normals: faceMesh.normals,
        indices: faceMesh.indices,
        emphasis,
      });
    }
    index.set(face.featureId, {
      elementId: face.featureId,
      featureId: face.featureId,
      kind: 'face',
      emphasis,
      offset: placement.offset,
      length: placement.length,
      meshIndex,
    });
  }

  return {
    points: toBuffers(points),
    curves: toBuffers(curves),
    faceOutlines: toBuffers(faceOutlines),
    faces,
    index,
  };
}
