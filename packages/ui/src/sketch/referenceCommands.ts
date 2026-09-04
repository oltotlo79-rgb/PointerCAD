/**
 * 基準ジオメトリ(任意の作業平面 FR-328、基準軸・基準点・座標系 FR-329)を、その場数値入力の
 * 確定から部品文書の履歴へ積む純関数(計画書 docs/plans/P4-スケッチ拡張.md タスク13)。
 *
 * `sketchCommands.ts` / `shapeCommands.ts` と同じ流儀にそろえる。DOM にもストアにも触れず、
 * 文書は不変で、作れないときは元の文書をそのまま返して断る理由だけを添える
 * (FR-504、NFR-UX-5)。段の遷移と欄の中身は `numericInput.ts`(タスク13)が決め、
 * ここは「決まった値を履歴の形へ直す」ことだけを受け持つ。
 *
 * **積む先はスケッチではなく部品文書の `references`**(model 側タスク9 の判断)。既存の面から
 * 離した平面のように、立体を見ないと決まらない決め方があり、スケッチ 1 本は立体を知らないため。
 *
 * **座標で入れた点は基準点フィーチャーとして先に積む。** 平面・軸・座標系が点を指す型
 * (`PointReference`)には「その場の座標」を入れる欄が無く、文書の中の点を名指しする形しか
 * 無いため(model の `PlaneSpec` / `ReferenceAxisDefinition`)。1 回の確定で点と平面をまとめて
 * 積むので、Undo は 1 回で元へ戻る(NFR-UX-3)。
 */

import {
  appendReference,
  baseWorkPlane,
  createReferenceResolver,
  DEFAULT_WORK_PLANE_ID,
  isBaseWorkPlaneId,
  nextReferenceId,
  nextReferenceName,
  resolveSketch,
  WORK_PLANES,
  type AxisSpec,
  type CoordinateInput,
  type PartDocument,
  type PlaneSpec,
  type PointReference,
  type ReferenceAxisDefinition,
  type ReferenceFeature,
  type ReferencePointDefinition,
  type ReferenceResolver,
  type ResolvedReferences,
  type ResolvedSketch,
  type SubShapeRef,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';

import { selectedSubShapeRefs, type SubShapeBody } from '../solid/subShapeSelection.js';
import {
  REFERENCE_AXIS_VALUE_PREFIX,
  type ReferenceAxisOption,
  type ReferenceCommitChoices,
  type ReferenceInputCommit,
} from './numericInput.js';

/* ---------------------------------------------------------------------------
 * 文書から引く(一覧・解決)
 * ------------------------------------------------------------------------- */

/** ツールバーの作図面の一覧へ並べる、文書にある作業平面(FR-328)。 */
export interface WorkPlaneEntry {
  readonly id: WorkPlaneId;
  /** ツリーに出るのと同じ名前。 */
  readonly name: string;
  readonly visible: boolean;
}

/** 文書にある作業平面を履歴の順に返す。基準の 3 面は含まない(ツールバー側が先に並べる)。 */
export function workPlaneEntries(document: PartDocument): readonly WorkPlaneEntry[] {
  const entries: WorkPlaneEntry[] = [];
  for (const feature of document.references) {
    if (feature.kind === 'referencePlane') {
      entries.push({ id: feature.id, name: feature.name, visible: feature.visible });
    }
  }
  return entries;
}

/** 軸の選択肢へ並べる、文書にある基準軸(FR-329)。 */
export function referenceAxisOptionsOf(document: PartDocument): readonly ReferenceAxisOption[] {
  const options: ReferenceAxisOption[] = [];
  for (const feature of document.references) {
    if (feature.kind === 'referenceAxis') {
      options.push({ id: feature.id, name: feature.name });
    }
  }
  return options;
}

/**
 * 画面側で基準ジオメトリを解く(FR-328、FR-329)。
 *
 * 解き方は model の `resolvePart` と同じ「頼まれたときに解いて覚える」形にそろえる
 * (`resolveSketchesAndReferences`)。スケッチは作図面として作業平面を指せて、その作業平面は
 * スケッチの点を基準にできるので、どちらを先に解くかを決められないため。解いている最中の
 * スケッチをもう一度頼まれたら null を返し、基準ジオメトリ側が循環として断る。
 *
 * 立体の面・辺・頂点は保存された指紋の位置・向きをそのまま使う(`deps.subShape` を渡さない)。
 * 画面側はカーネルの選び直しの結果を持っていないため。指紋は選んだ瞬間の値なので、
 * 上流の立体を大きく変えた直後は再計算の結果(`partErrors`)のほうが正しい。
 */
export function resolveReferencesOf(document: PartDocument): ResolvedReferences {
  return createUiReferenceResolver(document).resolveAll();
}

/**
 * 作図面 id から実際の平面を引く(FR-328)。基準の 3 面はその場で返し、それ以外は
 * 文書の作業平面を解く。解けなければ既定の XY へ落とす(画面が固まらないようにするため。
 * 解けない理由は再計算の失敗として帯に出る、FR-504)。
 */
export function resolveWorkPlaneOf(document: PartDocument, planeId: WorkPlaneId): WorkPlane {
  const base = baseWorkPlane(planeId);
  if (base !== null) {
    return base;
  }
  return createUiReferenceResolver(document).workPlane(planeId) ?? WORK_PLANES[DEFAULT_WORK_PLANE_ID];
}

/**
 * 画面側の解決器を 1 つ作る。スケッチは頼まれた順に解いて覚え、解いている最中のものを
 * もう一度頼まれたら null を返す(`resolvePart` の `resolveSketchesAndReferences` と同じ形)。
 */
function createUiReferenceResolver(document: PartDocument): ReferenceResolver {
  const resolved = new Map<string, ResolvedSketch>();
  const resolving = new Set<string>();
  const resolver: ReferenceResolver = createReferenceResolver(document, {
    sketch: (sketchId) => {
      const remembered = resolved.get(sketchId);
      if (remembered !== undefined) {
        return remembered;
      }
      if (resolving.has(sketchId)) {
        return null;
      }
      const found = document.sketches.find((sketch) => sketch.id === sketchId);
      if (found === undefined) {
        return null;
      }
      resolving.add(sketchId);
      const outcome = resolveSketch(found, {
        workPlane: (planeId) => resolver.workPlane(planeId),
      });
      resolving.delete(sketchId);
      resolved.set(sketchId, outcome);
      return outcome;
    },
  });
  return resolver;
}

/* ---------------------------------------------------------------------------
 * 1 つを履歴へ積む
 * ------------------------------------------------------------------------- */

/** 積んだ結果。作れた id を返すので、作業平面はそのまま作図面として選べる。 */
export interface ReferenceAppendOutcome {
  readonly document: PartDocument;
  readonly featureId: string;
}

function append(
  document: PartDocument,
  build: (id: string, name: string) => ReferenceFeature,
  kind: ReferenceFeature['kind'],
): ReferenceAppendOutcome {
  const id = nextReferenceId(document, kind);
  const name = nextReferenceName(document, kind);
  return { document: appendReference(document, build(id, name)), featureId: id };
}

/** 任意の作業平面を 1 枚作る(FR-328)。id はそのまま作図面の id になる。 */
export function commitWorkPlane(
  document: PartDocument,
  plane: PlaneSpec,
  visible = true,
): ReferenceAppendOutcome {
  return append(
    document,
    (id, name) => ({ id, name, visible, kind: 'referencePlane', plane }),
    'referencePlane',
  );
}

/** 基準軸を 1 本作る(FR-329)。 */
export function commitReferenceAxis(
  document: PartDocument,
  definition: ReferenceAxisDefinition,
  visible = true,
): ReferenceAppendOutcome {
  return append(
    document,
    (id, name) => ({ id, name, visible, kind: 'referenceAxis', definition }),
    'referenceAxis',
  );
}

/** 基準点を 1 つ作る(FR-329)。 */
export function commitReferencePoint(
  document: PartDocument,
  definition: ReferencePointDefinition,
  visible = true,
): ReferenceAppendOutcome {
  return append(
    document,
    (id, name) => ({ id, name, visible, kind: 'referencePoint', definition }),
    'referencePoint',
  );
}

/** 基準座標系を 1 つ作る(FR-329)。第 3 軸(Z)は解決のときに X × Y から導く。 */
export function commitCoordinateSystem(
  document: PartDocument,
  origin: PointReference,
  xAxis: AxisSpec,
  yAxis: AxisSpec,
  visible = true,
): ReferenceAppendOutcome {
  return append(
    document,
    (id, name) => ({ id, name, visible, kind: 'referenceCoordinateSystem', origin, xAxis, yAxis }),
    'referenceCoordinateSystem',
  );
}

/**
 * 置いた座標を基準点として履歴へ積み、平面・軸・座標系から名指しできる参照にする。
 *
 * 相対・極の基準(`{ kind: 'previous' }`)は部品文書では解けない(model 側タスク9 の申し送り)ので、
 * 1 点目は原点、2 点目以降は 1 つ前に積んだ基準点へ付け替える。こうすると「1 点目から
 * どれだけずらすか」で 2 点目・3 点目を入れられる(FR-302、FR-307 と同じ入れ心地)。
 *
 * 平面・軸・座標系を決めるためだけの点は画面に出さない(`visible: false`)。図形をかくのに
 * 使う点ではないので、出すと作図の邪魔になるため。
 */
export function appendCoordinatePoints(
  document: PartDocument,
  coordinates: readonly CoordinateInput[],
  visible = false,
): { readonly document: PartDocument; readonly points: readonly PointReference[] } {
  let current = document;
  const points: PointReference[] = [];
  let previous: PointReference = { kind: 'origin' };
  for (const coordinate of coordinates) {
    const outcome = commitReferencePoint(
      current,
      { kind: 'coordinate', at: rebasePrevious(coordinate, previous) },
      visible,
    );
    current = outcome.document;
    previous = { kind: 'point', pointId: outcome.featureId };
    points.push(previous);
  }
  return { document: current, points };
}

/** 「直前の点」を指す基準だけを差し替える。絶対座標は基準を持たないのでそのまま返す。 */
function rebasePrevious(coordinate: CoordinateInput, base: PointReference): CoordinateInput {
  if (coordinate.mode === 'relative') {
    return coordinate.base.kind === 'previous' ? { ...coordinate, base } : coordinate;
  }
  if (coordinate.mode === 'polar') {
    return coordinate.base.kind === 'previous' ? { ...coordinate, base } : coordinate;
  }
  return coordinate;
}

/* ---------------------------------------------------------------------------
 * 段の確定を下書きと履歴へ反映する
 * ------------------------------------------------------------------------- */

/**
 * 基準ジオメトリの途中経過(タスク13)。置いた点と、これまでの段で選んだ決め方を積む。
 * 道具を変える・ポップアップを閉じると空へ戻る(取りかけを持ち越さない、NFR-UX-3)。
 */
export interface ReferenceDraft {
  readonly points: readonly CoordinateInput[];
  readonly choices: ReferenceCommitChoices;
}

export const EMPTY_REFERENCE_DRAFT: ReferenceDraft = { points: [], choices: {} };

export interface ReferenceCommitContext {
  readonly document: PartDocument;
  /** いまの作図面。オフセットと傾けのもとになる(FR-328)。 */
  readonly planeId: WorkPlaneId;
  /** 面・辺・頂点を選ぶのに要るボディの一覧(`Toolbar.tsx` の `subShapeBodiesOf` の結果)。 */
  readonly bodies: readonly SubShapeBody[];
  readonly selection: readonly string[];
  readonly draft: ReferenceDraft;
}

export interface ReferenceCommitOutcome {
  readonly document: PartDocument;
  readonly draft: ReferenceDraft;
  /** 作れなかった理由(NFR-UX-5)。作れた・まだ途中のときは null。 */
  readonly rejection: string | null;
  /** 作った基準ジオメトリの id。まだ何も作っていなければ null。 */
  readonly featureId: string | null;
  /** 作ったのが作業平面のときだけ、その id。作図面としてすぐ選べるようにするため。 */
  readonly createdPlaneId: WorkPlaneId | null;
}

/* 断りの文。選んでいるものが足りないときは、次にすることが分かる書き方にする(NFR-UX-5)。 */
const NEED_STRAIGHT_EDGE = 'まっすぐな辺を 1 本選んでから決定してください。';
const NEED_FLAT_FACE = '平らな面を 1 つ選んでから決定してください。';
const NEED_TWO_FLAT_FACES = '平らな面を 2 つ選んでから決定してください。';
const NEED_VERTEX = '頂点を 1 つ選んでから決定してください。';
const NEED_EDGE = '辺を 1 本選んでから決定してください。';
const LOST_POINTS = '前の段で入れた点が残っていません。もう一度はじめから入れてください。';
const LOST_VALUES = '値が足りません。もう一度入れてください。';
const UNKNOWN_AXIS = '軸が選ばれていません。軸を選んでから決定してください。';

/**
 * 基準ジオメトリの 1 段を下書き・履歴へ反映する(FR-328、FR-329)。
 *
 * 途中の段は履歴を変えずに下書きへ積み、平面・軸・点・座標系が決まる最後の段でだけ履歴へ足す。
 * 断るときは作りかけを履歴に残さず、理由だけを返す(FR-504)。
 */
export function commitReferenceInput(
  commit: ReferenceInputCommit,
  context: ReferenceCommitContext,
): ReferenceCommitOutcome {
  const draft: ReferenceDraft = {
    ...context.draft,
    choices: mergeChoices(context.draft.choices, commit.choices),
  };
  const next: ReferenceCommitContext = { ...context, draft };
  switch (commit.step) {
    case 'referencePlanePoint1':
    case 'referencePlaneBasePoint':
    case 'referenceAxisStart':
    case 'referenceCsOrigin':
      // 1 点目。前の取りかけは持ち越さず、ここから作り直す(NFR-UX-3)。
      return pending(next, { points: takePoint(commit, []) });

    case 'referencePlanePoint2':
      return pending(next, { points: takePoint(commit, draft.points) });

    case 'referencePlanePoint3':
      return buildThreePointPlane(commit, next);

    case 'referencePlaneOffset':
      return buildOffsetPlane(commit, next);

    case 'referencePlaneTilt':
      return buildTiltedPlane(commit, next);

    case 'referencePlaneThrough':
      return buildPlaneThroughPoint(commit, next);

    case 'referenceAxisKind':
      return buildAxisFromKind(next);

    case 'referenceAxisEnd':
      return buildTwoPointAxis(commit, next);

    case 'referencePointKind':
      return buildPointFromKind(next);

    case 'referencePointAt':
      return buildCoordinatePoint(commit, next);

    case 'referenceCsAxes':
      return buildCoordinateSystem(next);
  }
}

/** 3 点を通る平面(FR-328)。3 点は基準点として先に積み、平面はそれを名指しする。 */
function buildThreePointPlane(
  commit: ReferenceInputCommit,
  context: ReferenceCommitContext,
): ReferenceCommitOutcome {
  const placed = takePoint(commit, context.draft.points);
  const first = placed[0];
  const second = placed[1];
  const third = placed[2];
  if (first === undefined || second === undefined || third === undefined) {
    return rejected(context, LOST_POINTS);
  }
  const points = appendCoordinatePoints(context.document, [first, second, third]);
  const p1 = points.points[0];
  const p2 = points.points[1];
  const p3 = points.points[2];
  if (p1 === undefined || p2 === undefined || p3 === undefined) {
    return rejected(context, LOST_POINTS);
  }
  return planeCreated(
    commitWorkPlane(points.document, { kind: 'threePoints', p1, p2, p3 }),
  );
}

/** 面・基準面から離した平面(FR-328)。「選んだ面」のときは平らな面が要る。 */
function buildOffsetPlane(
  commit: ReferenceInputCommit,
  context: ReferenceCommitContext,
): ReferenceCommitOutcome {
  const offset = commit.values.offset;
  if (offset === undefined) {
    return rejected(context, LOST_VALUES);
  }
  const base = context.draft.choices.planeBase ?? 'current';
  if (base === 'face') {
    const face = flatFace(context);
    if (face === null) {
      return rejected(context, NEED_FLAT_FACE);
    }
    return planeCreated(commitWorkPlane(context.document, { kind: 'face', face, offset }));
  }
  const planeId = isBaseWorkPlaneId(base) ? base : context.planeId;
  return planeCreated(
    commitWorkPlane(context.document, { kind: 'workPlane', planeId, offset }),
  );
}

/** いまの作図面を軸のまわりに傾けた平面(FR-328)。 */
function buildTiltedPlane(
  commit: ReferenceInputCommit,
  context: ReferenceCommitContext,
): ReferenceCommitOutcome {
  const angle = commit.values.angle;
  if (angle === undefined) {
    return rejected(context, LOST_VALUES);
  }
  const axis = parseAxisSpec(context.draft.choices.axis);
  if (axis === null) {
    return rejected(context, UNKNOWN_AXIS);
  }
  return planeCreated(
    commitWorkPlane(context.document, { kind: 'tilted', base: context.planeId, axis, angle }),
  );
}

/** 1 点を通り、辺・面・軸を基準にした平面(FR-328)。 */
function buildPlaneThroughPoint(
  commit: ReferenceInputCommit,
  context: ReferenceCommitContext,
): ReferenceCommitOutcome {
  const placed = context.draft.points[0];
  if (placed === undefined) {
    return rejected(context, LOST_POINTS);
  }
  const spec = planeSpecThroughPoint(commit, context);
  if (typeof spec === 'string') {
    return rejected(context, spec);
  }
  const points = appendCoordinatePoints(context.document, [placed]);
  const point = points.points[0];
  if (point === undefined) {
    return rejected(context, LOST_POINTS);
  }
  return planeCreated(commitWorkPlane(points.document, spec(point)));
}

/**
 * 「点を通る平面」の決め方から `PlaneSpec` の組み立て方を選ぶ。断るときは理由の文を返す。
 * 点そのものは呼び出し側が積んでから渡す(断るときに点だけを積み残さないため)。
 */
function planeSpecThroughPoint(
  commit: ReferenceInputCommit,
  context: ReferenceCommitContext,
): ((point: PointReference) => PlaneSpec) | string {
  const mode = context.draft.choices.throughMode ?? 'perpendicularEdge';
  if (mode === 'parallelFace') {
    const face = flatFace(context);
    return face === null
      ? NEED_FLAT_FACE
      : (point) => ({ kind: 'pointAndParallelFace', point, face });
  }
  if (mode === 'axis') {
    const axis = parseAxisSpec(context.draft.choices.axis);
    if (axis === null) {
      return UNKNOWN_AXIS;
    }
    const tilt = commit.values.tilt;
    const azimuth = commit.values.azimuth;
    if (tilt === undefined || azimuth === undefined) {
      return LOST_VALUES;
    }
    return (point) => ({ kind: 'pointAndAxis', point, axis, tilt, azimuth });
  }
  const edge = straightEdge(context);
  if (edge === null) {
    return NEED_STRAIGHT_EDGE;
  }
  const edgeMode = mode === 'containingEdge' ? 'containing' : 'perpendicular';
  return (point) => ({ kind: 'pointAndEdge', point, edge, mode: edgeMode });
}

/** 基準軸の決め方の段(FR-329)。2 点で決めるときは点を聞きに進むので、ここでは作らない。 */
function buildAxisFromKind(context: ReferenceCommitContext): ReferenceCommitOutcome {
  const kind = context.draft.choices.axisKind ?? 'twoPoints';
  if (kind === 'twoPoints') {
    return pending(context, { points: [] });
  }
  if (kind === 'edge') {
    const edge = straightEdge(context);
    return edge === null
      ? rejected(context, NEED_STRAIGHT_EDGE)
      : created(commitReferenceAxis(context.document, { kind: 'edge', edge }));
  }
  if (kind === 'faceNormal') {
    const face = flatFace(context);
    return face === null
      ? rejected(context, NEED_FLAT_FACE)
      : created(commitReferenceAxis(context.document, { kind: 'faceNormal', face }));
  }
  const faces = flatFaces(context);
  const face1 = faces[0];
  const face2 = faces[1];
  if (face1 === undefined || face2 === undefined) {
    return rejected(context, NEED_TWO_FLAT_FACES);
  }
  return created(
    commitReferenceAxis(context.document, { kind: 'faceIntersection', face1, face2 }),
  );
}

/** 2 点を通る基準軸(FR-329)。 */
function buildTwoPointAxis(
  commit: ReferenceInputCommit,
  context: ReferenceCommitContext,
): ReferenceCommitOutcome {
  const placed = takePoint(commit, context.draft.points);
  const start = placed[0];
  const end = placed[1];
  if (start === undefined || end === undefined) {
    return rejected(context, LOST_POINTS);
  }
  const points = appendCoordinatePoints(context.document, [start, end]);
  const from = points.points[0];
  const to = points.points[1];
  if (from === undefined || to === undefined) {
    return rejected(context, LOST_POINTS);
  }
  return created(
    commitReferenceAxis(points.document, { kind: 'twoPoints', from, to }),
  );
}

/** 基準点の決め方の段(FR-329)。座標で決めるときは位置を聞きに進む。 */
function buildPointFromKind(context: ReferenceCommitContext): ReferenceCommitOutcome {
  const kind = context.draft.choices.pointKind ?? 'coordinate';
  if (kind === 'coordinate') {
    return pending(context, { points: [] });
  }
  if (kind === 'vertex') {
    const vertex = firstRef(context, 'vertex');
    return vertex === null
      ? rejected(context, NEED_VERTEX)
      : created(commitReferencePoint(context.document, { kind: 'vertex', vertex }, true));
  }
  if (kind === 'edgeMidpoint') {
    const edge = firstRef(context, 'edge');
    return edge === null
      ? rejected(context, NEED_EDGE)
      : created(
          commitReferencePoint(context.document, { kind: 'edgeMidpoint', edge }, true),
        );
  }
  const face = firstRef(context, 'face');
  return face === null
    ? rejected(context, NEED_FLAT_FACE)
    : created(commitReferencePoint(context.document, { kind: 'faceCenter', face }, true));
}

/** 座標で決める基準点(FR-329)。こちらは画面に出す。 */
function buildCoordinatePoint(
  commit: ReferenceInputCommit,
  context: ReferenceCommitContext,
): ReferenceCommitOutcome {
  const at = commit.coordinate;
  if (at === null) {
    return rejected(context, LOST_POINTS);
  }
  return created(
    commitReferencePoint(
      context.document,
      { kind: 'coordinate', at: rebasePrevious(at, { kind: 'origin' }) },
      true,
    ),
  );
}

/** 基準座標系(FR-329)。原点は基準点として積み、2 軸は選択肢から組み立てる。 */
function buildCoordinateSystem(context: ReferenceCommitContext): ReferenceCommitOutcome {
  const placed = context.draft.points[0];
  if (placed === undefined) {
    return rejected(context, LOST_POINTS);
  }
  const xAxis = parseAxisSpec(context.draft.choices.csXAxis);
  const yAxis = parseAxisSpec(context.draft.choices.csYAxis);
  if (xAxis === null || yAxis === null) {
    return rejected(context, UNKNOWN_AXIS);
  }
  const points = appendCoordinatePoints(context.document, [placed]);
  const origin = points.points[0];
  if (origin === undefined) {
    return rejected(context, LOST_POINTS);
  }
  return created(commitCoordinateSystem(points.document, origin, xAxis, yAxis));
}

/* ---------------------------------------------------------------------------
 * 小さな道具
 * ------------------------------------------------------------------------- */

/**
 * 選択肢の値を軸の指定へ直す(§2.11「確定側で value から引き直す」)。
 * `x` / `y` / `z` はワールドの軸、`reference:<id>` は文書にある基準軸。
 */
export function parseAxisSpec(value: string | undefined): AxisSpec | null {
  if (value === 'x' || value === 'y' || value === 'z') {
    return { kind: 'world', axis: value };
  }
  if (value !== undefined && value.startsWith(REFERENCE_AXIS_VALUE_PREFIX)) {
    const id = value.slice(REFERENCE_AXIS_VALUE_PREFIX.length);
    return id === '' ? null : { kind: 'reference', referenceFeatureId: id };
  }
  return null;
}

/** 選択肢の持ち越し。持たない段の `undefined` で、前の段で選んだものを消さない。 */
function mergeChoices(
  base: ReferenceCommitChoices,
  next: ReferenceCommitChoices,
): ReferenceCommitChoices {
  return {
    planeBase: next.planeBase ?? base.planeBase,
    axis: next.axis ?? base.axis,
    throughMode: next.throughMode ?? base.throughMode,
    axisKind: next.axisKind ?? base.axisKind,
    pointKind: next.pointKind ?? base.pointKind,
    csXAxis: next.csXAxis ?? base.csXAxis,
    csYAxis: next.csYAxis ?? base.csYAxis,
  };
}

/** 確定した座標を下書きの点の並びへ足す。座標を聞かない段では並びをそのまま返す。 */
function takePoint(
  commit: ReferenceInputCommit,
  points: readonly CoordinateInput[],
): readonly CoordinateInput[] {
  return commit.coordinate === null ? points : [...points, commit.coordinate];
}

/** 選択の中の、指定した種類の部分形状の参照(選んだ順)。 */
function refsOf(
  context: ReferenceCommitContext,
  kind: 'face' | 'edge' | 'vertex',
): readonly SubShapeRef[] {
  return selectedSubShapeRefs(context.bodies, context.selection, kind);
}

function firstRef(
  context: ReferenceCommitContext,
  kind: 'face' | 'edge' | 'vertex',
): SubShapeRef | null {
  return refsOf(context, kind)[0] ?? null;
}

/**
 * 選んでいる平らな面(FR-328 の「既存の面」)。指紋に曲面の種類が入っているので、
 * カーネルへ聞き直さずにここで見分けられる。
 */
function flatFaces(context: ReferenceCommitContext): readonly SubShapeRef[] {
  return refsOf(context, 'face').filter(
    (ref) => ref.fingerprint.kind === 'face' && ref.fingerprint.surfaceKind === 'plane',
  );
}

function flatFace(context: ReferenceCommitContext): SubShapeRef | null {
  return flatFaces(context)[0] ?? null;
}

/** 選んでいるまっすぐな辺(FR-328 の「既存の辺」)。円や曲がった辺では平面・軸が決まらない。 */
function straightEdge(context: ReferenceCommitContext): SubShapeRef | null {
  return (
    refsOf(context, 'edge').find(
      (ref) => ref.fingerprint.kind === 'edge' && ref.fingerprint.curveKind === 'line',
    ) ?? null
  );
}

/** まだ作らない段(点を積んだだけ・決め方を選んだだけ)。 */
function pending(
  context: ReferenceCommitContext,
  patch: Partial<ReferenceDraft>,
): ReferenceCommitOutcome {
  return {
    document: context.document,
    draft: { ...context.draft, ...patch },
    rejection: null,
    featureId: null,
    createdPlaneId: null,
  };
}

/** 作れなかった。履歴も下書きも作りかけのまま残さず、理由だけを返す(FR-504)。 */
function rejected(context: ReferenceCommitContext, reason: string): ReferenceCommitOutcome {
  return {
    document: context.document,
    draft: EMPTY_REFERENCE_DRAFT,
    rejection: reason,
    featureId: null,
    createdPlaneId: null,
  };
}

/** 作れた。取りかけは空へ戻す。 */
function created(outcome: ReferenceAppendOutcome): ReferenceCommitOutcome {
  return {
    document: outcome.document,
    draft: EMPTY_REFERENCE_DRAFT,
    rejection: null,
    featureId: outcome.featureId,
    createdPlaneId: null,
  };
}

/** 作業平面を作れた。作った平面はそのまま作図面として選べるように id を返す。 */
function planeCreated(outcome: ReferenceAppendOutcome): ReferenceCommitOutcome {
  return { ...created(outcome), createdPlaneId: outcome.featureId };
}

