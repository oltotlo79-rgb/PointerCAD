/**
 * 測定の判定と、カーネルを呼ばずに測れるものの計算(FR-1102、NFR-UX-1、NFR-UX-5、
 * 計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク30、§0.a-0.29/0.30、§2.10.2)。
 *
 * `packages/ui/src/sketch/constraintCommands.ts`(P4b タスク12)の
 * `constraintReadiness` / `applicableConstraintKinds` と同じ流儀に揃える。DOM にも three.js にも
 * ストアにも触れない純関数だけを置き、判断を Node の単体検査で固定する
 * (`docs/報告記録.md` 2026-09-02 23:09「操作の判断は純関数へ切り出して検査する」)。
 *
 * **押したら必ず何かが起きる。** 測れない組み合わせでも `ready: false` と日本語の理由が必ず返り、
 * 呼ぶ側(タスク31・32)はそれをそのまま帯へ出せる(NFR-UX-5「実行してから失敗させない」)。
 *
 * **必要な情報は既に届いているものから引く。** 面積・長さ・法線・軸・位置はカーネルが再計算の
 * ついでに返している一覧(`SubShapeBody.faces` / `.edges` / `.vertices`)に入っているので、
 * 測るためにカーネルへ問い合わせるのは §0.a-0.30 の 2 つ(2 つの部分形状の最短距離と質量特性)
 * だけにする(`docs/報告記録.md` 2026-09-04 04:30 の②と同じ考え方。Worker の往復を増やさない、
 * NFR-PF-4)。
 *
 * **この場は「何を測れるか」と「一覧から出せる値」だけを決める。** 画面への線と札はタスク31、
 * プロパティ欄・ツールバー・カーネルへの問い合わせはタスク32 の役目。
 */

import type { SubShapeRef, Vec3 } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';

import {
  parseSubShapeId,
  subShapeRefOf,
  type SelectionKind,
  type SolidEdgeEntry,
  type SolidFaceEntry,
  type SolidVertexEntry,
  type SubShapeBody,
} from './subShapeSelection.js';

/* ---------------------------------------------------------------------------
 * 測れる種類
 * ------------------------------------------------------------------------- */

/**
 * 測れるものの種類(§0.a-0.29)。
 *
 * 計画書の宣言にある `'none'` は入れていない。**測れないことは種類ではなく理由で表す**ほうが、
 * 「なぜ測れないか」を必ず日本語で言えるためで(NFR-UX-5)、`measureReadiness` は測れないとき
 * `kinds` を空にして `reason` / `message` を返す。代わりに `'massProperties'`(体積・質量・重心。
 * FR-1101)を足した。この 2 点は計画書との差として報告済み。
 */
export type MeasureKind =
  /** 2 点の距離。 */
  | 'pointDistance'
  /** 点と面の距離。 */
  | 'pointFaceDistance'
  /** 面と面の距離(平行な平面どうし、またはカーネルの最短距離)。 */
  | 'faceDistance'
  /** 辺と辺の最短距離(カーネルが要る)。 */
  | 'edgeDistance'
  /** 立体 2 つの最短距離(隙間。カーネルが要る)。§0.a-0.69、タスク32。 */
  | 'bodyDistance'
  /** 面と面のなす角。 */
  | 'faceAngle'
  /** 辺と辺のなす角。 */
  | 'edgeAngle'
  /** 辺の長さ。 */
  | 'edgeLength'
  /** 面の面積。 */
  | 'faceArea'
  /** 立体の体積。 */
  | 'bodyVolume'
  /** 立体の体積・質量・重心(FR-1101。カーネルが要る)。 */
  | 'massProperties';

/**
 * 種類の並び(一覧・プロパティ欄で使う既定の順)。
 *
 * **選んだものから決まる `kinds` の並びはこの順ではない。** 組み合わせごとに「利用者が
 * まず知りたいもの」を先頭に置く(向かい合う面なら距離、隣り合う面なら角度)ので、
 * `measureReadiness` は組み合わせの規則どおりの順で返す。この定数は種類を網羅して
 * 数え上げるとき(見出しの一覧、検査)に使う。
 */
export const MEASURE_KIND_ORDER: readonly MeasureKind[] = [
  'pointDistance',
  'pointFaceDistance',
  'faceDistance',
  'edgeDistance',
  'bodyDistance',
  'faceAngle',
  'edgeAngle',
  'edgeLength',
  'faceArea',
  'bodyVolume',
  'massProperties',
];

/**
 * 種類ごとの見出しの鍵(ja.json)。**文言は 1 か所だけ**にし、一覧・プロパティ欄・帯が
 * すべてここを引く(NFR-MA-5)。網羅する `Record` なので、種類を足したらここが型検査で落ちる。
 */
export const MEASURE_KIND_LABEL_KEYS: Readonly<Record<MeasureKind, MessageKey>> = {
  pointDistance: 'measure.kind.pointDistance',
  pointFaceDistance: 'measure.kind.pointFaceDistance',
  faceDistance: 'measure.kind.faceDistance',
  edgeDistance: 'measure.kind.edgeDistance',
  bodyDistance: 'measure.kind.bodyDistance',
  faceAngle: 'measure.kind.faceAngle',
  edgeAngle: 'measure.kind.edgeAngle',
  edgeLength: 'measure.kind.edgeLength',
  faceArea: 'measure.kind.faceArea',
  bodyVolume: 'measure.kind.bodyVolume',
  massProperties: 'measure.kind.massProperties',
};

/** 種類の見出しの鍵。 */
export function measureKindLabelKey(kind: MeasureKind): MessageKey {
  return MEASURE_KIND_LABEL_KEYS[kind];
}

/** 種類の見出し(日本語)。 */
export function measureKindLabel(kind: MeasureKind): string {
  return t(MEASURE_KIND_LABEL_KEYS[kind]);
}

/** 表示の単位。計画書 §2.10.2 の 4 種。 */
export type MeasureUnit = 'mm' | 'degree' | 'mm2' | 'mm3';

/** 種類ごとの単位。 */
const MEASURE_KIND_UNITS: Readonly<Record<MeasureKind, MeasureUnit>> = {
  pointDistance: 'mm',
  pointFaceDistance: 'mm',
  faceDistance: 'mm',
  edgeDistance: 'mm',
  bodyDistance: 'mm',
  faceAngle: 'degree',
  edgeAngle: 'degree',
  edgeLength: 'mm',
  faceArea: 'mm2',
  bodyVolume: 'mm3',
  massProperties: 'mm3',
};

/** その種類の値に付ける単位。 */
export function measureKindUnit(kind: MeasureKind): MeasureUnit {
  return MEASURE_KIND_UNITS[kind];
}

/**
 * 単位の表記の鍵(ja.json)。
 *
 * `numericInput.unit.mm` や `propertyPanel.unitCubicMillimeter` と字面は同じだが、鍵を分けてある。
 * 測定の表示だけを直したいときに、その場入力やプロパティ欄の単位まで一緒に変わってしまうのを
 * 避けるため(鍵の持ち主を混ぜない)。
 */
const MEASURE_UNIT_LABEL_KEYS: Readonly<Record<MeasureUnit, MessageKey>> = {
  mm: 'measure.unit.millimeter',
  degree: 'measure.unit.degree',
  mm2: 'measure.unit.squareMillimeter',
  mm3: 'measure.unit.cubicMillimeter',
};

/**
 * その種類を測るのにカーネル(Worker)が要るか(§0.a-0.30)。
 *
 * - 辺と辺の最短距離: 線分どうしの最短距離は端点の扱いが要るのでカーネルに任せる。
 * - 立体 2 つの最短距離(§0.a-0.69): 面と面の総当たりになるので形そのものへ聞く。
 * - 質量特性: 重心と慣性モーメントは一覧に入っていない。
 *
 * **偽でも `measureLocally` が null を返すことがある。** 平面でない面の距離(円筒面など)は
 * 一覧の重心と軸だけでは求まらないためで、呼ぶ側は「`measureLocally` が null ならカーネルへ」
 * を判定の正とする。この関数は「そもそも一覧から出せない種類」を先に分けるためのもの。
 */
export function needsKernel(kind: MeasureKind): boolean {
  return kind === 'edgeDistance' || kind === 'bodyDistance' || kind === 'massProperties';
}

/* ---------------------------------------------------------------------------
 * 断りの理由
 * ------------------------------------------------------------------------- */

/** 測れない理由。文言は `ja.json`(NFR-MA-5)、対応は `REJECTION_MESSAGE_KEYS` の 1 か所。 */
export type MeasureRejectionReason =
  /** 何も選んでいない。 */
  | 'nothingSelected'
  /** 3 つ以上選んでいる(測れるのは 2 つまで)。 */
  | 'tooMany'
  /** 1 つでは測れない(点を 1 つだけ選んだとき)。 */
  | 'needTwo'
  /** 立体でも面・辺・頂点でもないものを選んでいる(スケッチの要素など)。 */
  | 'unsupportedElement'
  /** 組み合わせが測定の対象にない(点と辺、面と辺、立体と何か)。 */
  | 'unsupportedPair'
  /** 選んだものが一覧に無い(形が変わって番号が動いた)。 */
  | 'missingTarget';

const REJECTION_MESSAGE_KEYS: Readonly<Record<MeasureRejectionReason, MessageKey>> = {
  nothingSelected: 'measureError.nothingSelected',
  tooMany: 'measureError.tooMany',
  needTwo: 'measureError.needTwo',
  unsupportedElement: 'measureError.unsupportedElement',
  unsupportedPair: 'measureError.unsupportedPair',
  missingTarget: 'measureError.missingTarget',
};

/** 断りの文言の鍵。帯の案内(タスク32)も同じ鍵を引く。 */
export function measureRejectionMessageKey(reason: MeasureRejectionReason): MessageKey {
  return REJECTION_MESSAGE_KEYS[reason];
}

/**
 * カーネルが測れなかったときの断りの鍵(§0.a-0.30)。
 *
 * 形がキャッシュに無いときは、呼ぶ側(タスク32)が**再計算の完了を待って自動で 1 回だけ
 * 測り直し**、それでも測れなければこの文言で断る。文言はカーネルが返す断り
 * (計画書 §2.10.1 の「もう一度お試しください。」)とそろえてあり、画面に出る日本語は
 * どちらの経路でも同じになる。
 */
export const MEASURE_FAILED_MESSAGE_KEY: MessageKey = 'measureError.failed';

/* ---------------------------------------------------------------------------
 * 測る相手
 * ------------------------------------------------------------------------- */

/**
 * 測るのに要るボディ。タスク20 の `SubShapeBody`(面・辺・頂点の一覧)に体積を足したもの。
 *
 * `@pointercad/model` の `SolidBody` はこの形をそのまま満たすので、呼び出し側(タスク31・32)は
 * 詰め替えずに渡せる。体積を別の型で足しているのは、`subShapeSelection.ts` の `SubShapeBody` が
 * 「部分形状を選ぶのに要るものだけ」を持つ型で、測定の都合で欄を増やす場所ではないため。
 */
export interface MeasureBody extends SubShapeBody {
  /** 体積(mm³)。 */
  readonly volume: number;
}

/**
 * 測る相手 1 つ。
 *
 * 指し方は既存のものに合わせる(部分形状は指紋つきの `SubShapeRef`、立体はそれを作った
 * フィーチャーの id)。model 側の橋渡し(タスク29 の `MeasureTarget`)が
 * `{ bodyFeatureId, subShape: SubShapeRef | null }` を受けるので、そのまま詰め替えられる。
 */
export interface MeasureTarget {
  /** そのボディを作ったフィーチャーの id(= ボディの id)。 */
  readonly bodyFeatureId: string;
  /** 選んだものの種類。立体そのものなら `'body'`。 */
  readonly kind: SelectionKind;
  /** 部分形状の参照(指紋つき)。立体そのものを選んだときは null。 */
  readonly ref: SubShapeRef | null;
  /** 一覧の通し番号。立体そのものを選んだときは null。 */
  readonly index: number | null;
  /** 元の要素 id。画面の強調(タスク31)がそのまま使える。 */
  readonly elementId: string;
}

/** 選んだものから決めた測定の下見。 */
export interface MeasureReadiness {
  readonly ready: boolean;
  /**
   * 測れる種類。測れないときは空。並びは組み合わせごとの規則の順で、
   * **先頭が既定**(向かい合う面なら距離、隣り合う面なら角度)。
   */
  readonly kinds: readonly MeasureKind[];
  /** 既定の種類(`kinds[0]`)。測れないときは null。 */
  readonly kind: MeasureKind | null;
  /** 測る相手(選んだ順)。測れないときは空。 */
  readonly targets: readonly MeasureTarget[];
  /** 測れない理由。測れるときは null。 */
  readonly reason: MeasureRejectionReason | null;
  /** 画面へそのまま出す日本語。測れるときは null。 */
  readonly message: string | null;
}

const NO_KINDS: readonly MeasureKind[] = [];
const NO_TARGETS: readonly MeasureTarget[] = [];

function notReady(reason: MeasureRejectionReason): MeasureReadiness {
  return {
    ready: false,
    kinds: NO_KINDS,
    kind: null,
    targets: NO_TARGETS,
    reason,
    message: t(REJECTION_MESSAGE_KEYS[reason]),
  };
}

function ready(
  kinds: readonly MeasureKind[],
  targets: readonly MeasureTarget[],
): MeasureReadiness {
  return { ready: true, kinds, kind: kinds[0] ?? null, targets, reason: null, message: null };
}

/* ---------------------------------------------------------------------------
 * 選択の読み取り
 * ------------------------------------------------------------------------- */

/**
 * 選んだもの 1 つを、種類ごとの素性つきで持つ(この場の中だけで使う)。
 *
 * ボディの型を型変数にしてあるのは、**「何を測れるか」の判定には体積が要らない**ため
 * (タスク32)。ツールバーのボタンの入り切り(`solidToolReadiness`)が渡してくるのは
 * 体積を持たない `SubShapeBody` の一覧なので、判定だけはそれで通るようにする。
 * 値を出す側(`measureLocally`)は体積を使うので `MeasureBody` のままにする。
 */
type ResolvedTarget<B extends SubShapeBody = MeasureBody> =
  | { readonly kind: 'body'; readonly target: MeasureTarget; readonly body: B }
  | { readonly kind: 'face'; readonly target: MeasureTarget; readonly face: SolidFaceEntry }
  | { readonly kind: 'edge'; readonly target: MeasureTarget; readonly edge: SolidEdgeEntry }
  | { readonly kind: 'vertex'; readonly target: MeasureTarget; readonly vertex: SolidVertexEntry };

/** 読み取れなかった理由。 */
type ResolveFailure = 'unsupportedElement' | 'missingTarget';

/**
 * 一覧から通し番号の合う 1 件を引く(`subShapeSelection.ts` の `entryAt` と同じ規則)。
 * カーネルは並び順と通し番号を一致させるので、まず同じ位置を見て、食い違ったときだけ探し直す。
 */
function entryAt<T extends { readonly index: number }>(
  entries: readonly T[],
  index: number,
): T | null {
  const direct = entries[index];
  if (direct !== undefined && direct.index === index) {
    return direct;
  }
  return entries.find((entry) => entry.index === index) ?? null;
}

/**
 * 要素 id 1 つを読み取る。
 * 立体そのものの id は `bodies` に載っているかで判定する(id の接頭辞では判定しない。
 * `docs/報告記録.md` 2026-09-03 13:05 の②)。
 */
function resolveTarget<B extends SubShapeBody>(
  bodies: readonly B[],
  elementId: string,
): ResolvedTarget<B> | ResolveFailure {
  const parsed = parseSubShapeId(elementId);
  if (parsed === null) {
    const body = bodies.find((candidate) => candidate.featureId === elementId);
    if (body === undefined) {
      // スケッチの要素・点列の 1 点・消えたフィーチャーなど。
      return 'unsupportedElement';
    }
    return {
      kind: 'body',
      body,
      target: { bodyFeatureId: body.featureId, kind: 'body', ref: null, index: null, elementId },
    };
  }
  const body = bodies.find((candidate) => candidate.featureId === parsed.bodyFeatureId);
  if (body === undefined) {
    return 'missingTarget';
  }
  const ref = subShapeRefOf(bodies, elementId);
  if (ref === null) {
    // 番号が一覧の外(形が変わって面・辺の数が減った)。
    return 'missingTarget';
  }
  const target: MeasureTarget = {
    bodyFeatureId: body.featureId,
    kind: parsed.kind,
    ref,
    index: parsed.index,
    elementId,
  };
  switch (parsed.kind) {
    case 'face': {
      const face = entryAt(body.faces, parsed.index);
      return face === null ? 'missingTarget' : { kind: 'face', target, face };
    }
    case 'edge': {
      const edge = entryAt(body.edges, parsed.index);
      return edge === null ? 'missingTarget' : { kind: 'edge', target, edge };
    }
    case 'vertex': {
      const vertex = entryAt(body.vertices, parsed.index);
      return vertex === null ? 'missingTarget' : { kind: 'vertex', target, vertex };
    }
  }
}

/* ---------------------------------------------------------------------------
 * 幾何の小道具
 * ------------------------------------------------------------------------- */

/**
 * 平行とみなす許容差。2 つの向きの外積の長さ(= sin θ、どちらも単位ベクトルのとき)で測る。
 * `acos` は 1 の近くで誤差が拡大するので内積では判定しない。1e-6 は約 5.7e-5 度にあたり、
 * カーネルが返す平面の法線(箱なら成分がそのまま ±1)には十分な余裕がある。
 */
const PARALLEL_TOLERANCE = 1e-6;

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossLength(a: Vec3, b: Vec3): number {
  return Math.hypot(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** 長さ 1 に揃える。長さが 0 のときは null(向きが決まらない)。 */
function unit(a: Vec3): Vec3 | null {
  const length = norm(a);
  return length === 0 ? null : [a[0] / length, a[1] / length, a[2] / length];
}

/**
 * 2 つの向きのなす角(度、0〜90)。裏表を区別しないので、逆向きどうしは 0 度になる
 * (面の表裏で角度が変わると利用者の期待から外れるため。計画書タスク30 の検証表)。
 *
 * `acos` ではなく `atan2(|a×b|, |a·b|)` を使う。`acos` は 0 度・180 度の近くで
 * 入力のわずかな誤差が角度の誤差へ大きく効くのに対し、`atan2` はどの角度でも精度が保てる。
 */
function angleDegreesBetween(a: Vec3, b: Vec3): number | null {
  if (norm(a) === 0 || norm(b) === 0) {
    return null;
  }
  return (Math.atan2(crossLength(a, b), Math.abs(dot(a, b))) * 180) / Math.PI;
}

/** 2 つの向きが平行(または逆向き)か。 */
function isParallel(a: Vec3, b: Vec3): boolean {
  const unitA = unit(a);
  const unitB = unit(b);
  if (unitA === null || unitB === null) {
    return false;
  }
  return crossLength(unitA, unitB) <= PARALLEL_TOLERANCE;
}

/** 平らな面(法線が求まっている平面)か。 */
function planeNormalOf(face: SolidFaceEntry): Vec3 | null {
  if (face.surfaceKind !== 'plane' || face.axis === null) {
    return null;
  }
  return unit(face.axis);
}

/** まっすぐな辺(向きが求まっている線分)か。 */
function lineDirectionOf(edge: SolidEdgeEntry): Vec3 | null {
  if (edge.curveKind !== 'line' || edge.axis === null) {
    return null;
  }
  return unit(edge.axis);
}

/* ---------------------------------------------------------------------------
 * 何を測れるか(§0.a-0.29)
 * ------------------------------------------------------------------------- */

/** 2 つ選んだときの規則。選んだ順は見ない(どちらを先に選んでも同じ結果)。 */
function kindsForPair(
  first: ResolvedTarget<SubShapeBody>,
  second: ResolvedTarget<SubShapeBody>,
): readonly MeasureKind[] {
  if (first.kind === 'body' && second.kind === 'body') {
    /*
      立体 2 つの隙間(§0.a-0.69)。カーネルの最短距離は形どうし全般で測れるので、
      面や辺と同じ 1 本の道でそのまま測れる(`measureLocally` は null を返す)。
    */
    return ['bodyDistance'];
  }
  if (first.kind === 'vertex' && second.kind === 'vertex') {
    return ['pointDistance'];
  }
  if (first.kind === 'face' && second.kind === 'face') {
    const normalA = planeNormalOf(first.face);
    const normalB = planeNormalOf(second.face);
    if (normalA === null || normalB === null) {
      // 円筒面などが混ざる組み合わせ。最短距離はカーネルに任せる(`measureLocally` は null)。
      return ['faceDistance'];
    }
    /*
      平面どうしの距離は「平行なときだけ」測る(計画書タスク30 の手順3)。交わる 2 平面の
      「距離」は 0 にしかならず、利用者が知りたいのは角度のため。
    */
    return isParallel(normalA, normalB) ? ['faceDistance', 'faceAngle'] : ['faceAngle'];
  }
  if (first.kind === 'edge' && second.kind === 'edge') {
    const directionA = lineDirectionOf(first.edge);
    const directionB = lineDirectionOf(second.edge);
    /*
      角度は「まっすぐな辺どうし」のときだけ。円・楕円の辺が持つ `axis` はその円が乗る面の
      法線であって辺の向きではないので、直線の向きと混ぜると意味の違う角度になる。
    */
    return directionA !== null && directionB !== null
      ? ['edgeAngle', 'edgeDistance']
      : ['edgeDistance'];
  }
  if (
    (first.kind === 'vertex' && second.kind === 'face') ||
    (first.kind === 'face' && second.kind === 'vertex')
  ) {
    return ['pointFaceDistance'];
  }
  // 点と辺、面と辺、立体と部分形状。§0.a-0.29 に規則が無いので測らない。
  return NO_KINDS;
}

/**
 * 選んでいるものから、何を測れるかを決める(§0.a-0.29、NFR-UX-1)。
 *
 * 規則: 頂点2=距離 / 面2=距離と角度 / 辺2=角度と最短距離 / 頂点+面=点と面の距離 /
 * 立体2=最短距離(§0.a-0.69) / 面1=面積 / 辺1=長さ / 立体1=体積と質量特性。
 * **選択の順序は見ない**(2 つ選ばれていれば十分)。
 *
 * 測れないときは `ready: false` と日本語の理由を返す。呼ぶ側は帯へそのまま出せる(NFR-UX-5)。
 *
 * **体積を持たない一覧(`SubShapeBody`)でも判定できる。** ツールバーのボタンの入り切りは
 * `solidToolReadiness` 経由でこの関数を呼び、そこに届く一覧に体積が無いため(タスク32)。
 */
export function measureReadiness(
  selection: readonly string[],
  bodies: readonly SubShapeBody[],
): MeasureReadiness {
  if (selection.length === 0) {
    return notReady('nothingSelected');
  }
  if (selection.length > 2) {
    return notReady('tooMany');
  }
  const resolved: ResolvedTarget<SubShapeBody>[] = [];
  for (const elementId of selection) {
    const outcome = resolveTarget(bodies, elementId);
    if (outcome === 'unsupportedElement' || outcome === 'missingTarget') {
      return notReady(outcome);
    }
    resolved.push(outcome);
  }
  const targets = resolved.map((item) => item.target);
  if (resolved.length === 1) {
    const only = resolved[0];
    switch (only.kind) {
      case 'face':
        return ready(['faceArea'], targets);
      case 'edge':
        return ready(['edgeLength'], targets);
      case 'body':
        // 体積は一覧から出せる。重心・慣性モーメントはカーネルが要る(§0.a-0.30、FR-1101)。
        return ready(['bodyVolume', 'massProperties'], targets);
      case 'vertex':
        // 点 1 つだけでは測るものが無い。2 つ目を選べば距離になる。
        return notReady('needTwo');
    }
  }
  const kinds = kindsForPair(resolved[0], resolved[1]);
  return kinds.length === 0 ? notReady('unsupportedPair') : ready(kinds, targets);
}

/**
 * いま選んでいるもので測れる種類の一覧(プロパティ欄の切り替えに使う)。
 * `constraintCommands.ts` の `applicableConstraintKinds` と同じ役目。
 */
export function measurableKinds(
  selection: readonly string[],
  bodies: readonly SubShapeBody[],
): readonly MeasureKind[] {
  return measureReadiness(selection, bodies).kinds;
}

/* ---------------------------------------------------------------------------
 * カーネルを呼ばずに測る(§2.10.2)
 * ------------------------------------------------------------------------- */

/** 一覧から出せた測定の結果。 */
export interface LocalMeasureResult {
  readonly kind: MeasureKind;
  readonly value: number;
  /** 表示の単位。 */
  readonly unit: MeasureUnit;
  /** 画面に線を引くための 2 点(引けないときは null)。 */
  readonly segment: readonly [Vec3, Vec3] | null;
}

function localResult(
  kind: MeasureKind,
  value: number,
  segment: readonly [Vec3, Vec3] | null,
): LocalMeasureResult | null {
  // 退化した形(長さ 0 の辺など)で NaN や Infinity が出たら、値を出さずに黙って断る。
  return Number.isFinite(value)
    ? { kind, value, unit: measureKindUnit(kind), segment }
    : null;
}

/** 相手のうち、種類が合う最初の 1 つを読み直す。 */
function resolvedOf(
  bodies: readonly MeasureBody[],
  targets: readonly MeasureTarget[],
): readonly ResolvedTarget[] {
  const resolved: ResolvedTarget[] = [];
  for (const target of targets) {
    const outcome = resolveTarget(bodies, target.elementId);
    if (outcome !== 'unsupportedElement' && outcome !== 'missingTarget') {
      resolved.push(outcome);
    }
  }
  return resolved;
}

function faceOf(resolved: readonly ResolvedTarget[], skip: number): SolidFaceEntry | null {
  let seen = 0;
  for (const item of resolved) {
    if (item.kind === 'face') {
      if (seen === skip) {
        return item.face;
      }
      seen += 1;
    }
  }
  return null;
}

function edgeOf(resolved: readonly ResolvedTarget[], skip: number): SolidEdgeEntry | null {
  let seen = 0;
  for (const item of resolved) {
    if (item.kind === 'edge') {
      if (seen === skip) {
        return item.edge;
      }
      seen += 1;
    }
  }
  return null;
}

function vertexOf(resolved: readonly ResolvedTarget[], skip: number): SolidVertexEntry | null {
  let seen = 0;
  for (const item of resolved) {
    if (item.kind === 'vertex') {
      if (seen === skip) {
        return item.vertex;
      }
      seen += 1;
    }
  }
  return null;
}

function bodyOf(resolved: readonly ResolvedTarget[]): MeasureBody | null {
  for (const item of resolved) {
    if (item.kind === 'body') {
      return item.body;
    }
  }
  return null;
}

/** 2 点間の距離。 */
function pointDistance(resolved: readonly ResolvedTarget[]): LocalMeasureResult | null {
  const first = vertexOf(resolved, 0);
  const second = vertexOf(resolved, 1);
  if (first === null || second === null) {
    return null;
  }
  const gap = subtract(second.position, first.position);
  return localResult('pointDistance', norm(gap), [first.position, second.position]);
}

/**
 * 点と平面の距離 `|(p − o)·n̂|`。線は点から平面へ下ろした足まで引く。
 * 平面でない面(円筒面など)はカーネルの最短距離に任せるので null。
 */
function pointFaceDistance(resolved: readonly ResolvedTarget[]): LocalMeasureResult | null {
  const vertex = vertexOf(resolved, 0);
  const face = faceOf(resolved, 0);
  if (vertex === null || face === null) {
    return null;
  }
  const normal = planeNormalOf(face);
  if (normal === null) {
    return null;
  }
  const signed = dot(subtract(vertex.position, face.centroid), normal);
  const foot: Vec3 = [
    vertex.position[0] - normal[0] * signed,
    vertex.position[1] - normal[1] * signed,
    vertex.position[2] - normal[2] * signed,
  ];
  return localResult('pointFaceDistance', Math.abs(signed), [vertex.position, foot]);
}

/**
 * 平行な平面どうしの距離。1 枚目の重心から法線ぶん進んだ点までを線にする
 * (2 枚目の重心を結ぶと斜めの線になり、測り方が距離と食い違って見えるため)。
 */
function faceDistance(resolved: readonly ResolvedTarget[]): LocalMeasureResult | null {
  const first = faceOf(resolved, 0);
  const second = faceOf(resolved, 1);
  if (first === null || second === null) {
    return null;
  }
  const normal = planeNormalOf(first);
  const other = planeNormalOf(second);
  if (normal === null || other === null || !isParallel(normal, other)) {
    return null;
  }
  const signed = dot(subtract(second.centroid, first.centroid), normal);
  const to: Vec3 = [
    first.centroid[0] + normal[0] * signed,
    first.centroid[1] + normal[1] * signed,
    first.centroid[2] + normal[2] * signed,
  ];
  return localResult('faceDistance', Math.abs(signed), [first.centroid, to]);
}

/** 2 平面のなす角(度)。 */
function faceAngle(resolved: readonly ResolvedTarget[]): LocalMeasureResult | null {
  const first = faceOf(resolved, 0);
  const second = faceOf(resolved, 1);
  if (first === null || second === null) {
    return null;
  }
  const normalA = planeNormalOf(first);
  const normalB = planeNormalOf(second);
  if (normalA === null || normalB === null) {
    return null;
  }
  const degrees = angleDegreesBetween(normalA, normalB);
  return degrees === null ? null : localResult('faceAngle', degrees, null);
}

/** 2 直線辺のなす角(度)。 */
function edgeAngle(resolved: readonly ResolvedTarget[]): LocalMeasureResult | null {
  const first = edgeOf(resolved, 0);
  const second = edgeOf(resolved, 1);
  if (first === null || second === null) {
    return null;
  }
  const directionA = lineDirectionOf(first);
  const directionB = lineDirectionOf(second);
  if (directionA === null || directionB === null) {
    return null;
  }
  const degrees = angleDegreesBetween(directionA, directionB);
  return degrees === null ? null : localResult('edgeAngle', degrees, null);
}

/** 辺の長さ。まっすぐな辺のときだけ端から端までの線を添える。 */
function edgeLength(resolved: readonly ResolvedTarget[]): LocalMeasureResult | null {
  const edge = edgeOf(resolved, 0);
  if (edge === null) {
    return null;
  }
  const segment: readonly [Vec3, Vec3] | null =
    edge.curveKind === 'line' ? [edge.start, edge.end] : null;
  return localResult('edgeLength', edge.length, segment);
}

/** 面の面積。 */
function faceArea(resolved: readonly ResolvedTarget[]): LocalMeasureResult | null {
  const face = faceOf(resolved, 0);
  return face === null ? null : localResult('faceArea', face.area, null);
}

/** 立体の体積。 */
function bodyVolume(resolved: readonly ResolvedTarget[]): LocalMeasureResult | null {
  const body = bodyOf(resolved);
  return body === null ? null : localResult('bodyVolume', body.volume, null);
}

/**
 * カーネルを呼ばずに測れるものを測る(§2.10.2)。
 *
 * 出せないときは null を返す。呼ぶ側(タスク32)はそのときだけカーネルへ問い合わせる。
 * null になるのは、①種類がそもそもカーネル向き(`needsKernel` が真)、②平面でない面の距離、
 * ③相手が一覧から消えた、④値が数にならない(退化した形)、のいずれか。
 */
export function measureLocally(
  kind: MeasureKind,
  targets: readonly MeasureTarget[],
  bodies: readonly MeasureBody[],
): LocalMeasureResult | null {
  const resolved = resolvedOf(bodies, targets);
  switch (kind) {
    case 'pointDistance':
      return pointDistance(resolved);
    case 'pointFaceDistance':
      return pointFaceDistance(resolved);
    case 'faceDistance':
      return faceDistance(resolved);
    case 'faceAngle':
      return faceAngle(resolved);
    case 'edgeAngle':
      return edgeAngle(resolved);
    case 'edgeLength':
      return edgeLength(resolved);
    case 'faceArea':
      return faceArea(resolved);
    case 'bodyVolume':
      return bodyVolume(resolved);
    case 'edgeDistance':
    case 'bodyDistance':
    case 'massProperties':
      // 最短距離(辺どうし・立体どうし)と質量特性はカーネルの役目(§0.a-0.30、§0.a-0.69)。
      return null;
  }
}

/* ---------------------------------------------------------------------------
 * 表示
 * ------------------------------------------------------------------------- */

/** 小数の桁数。長さも角度も面積も同じ桁で出し、欄ごとに丸め方が違う状態を作らない。 */
const MEASURE_FRACTION_DIGITS = 3;

/**
 * 測定の結果の表示(例: `37.417 mm`、`90.000 度`)。
 *
 * **`formatVolume`(`solidSummary.ts`)とは丸め方が違う。** あちらはプロパティ欄の体積を
 * 式エンジンの表示規則(有効数字 12 桁)で出すが、測定は「読み取る数字」なので小数 3 桁に
 * そろえる(計画書タスク30 の手順4)。1μm 単位まで読めれば十分で、桁が揺れると
 * 画面の札(タスク31)の幅が測るたびに変わる。
 */
export function formatMeasure(result: LocalMeasureResult): string {
  // −0 は「0」と書く(0.0004mm の距離を「-0.000」と出さない)。
  const rounded = result.value === 0 ? 0 : result.value;
  const digits = rounded.toFixed(MEASURE_FRACTION_DIGITS);
  return `${digits === '-0.000' ? '0.000' : digits} ${t(MEASURE_UNIT_LABEL_KEYS[result.unit])}`;
}
