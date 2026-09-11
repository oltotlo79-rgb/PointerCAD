/**
 * 選択とその場入力から Should 群の立体フィーチャーを作る純関数
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク50、§2.11、§2.15)。
 *
 * 対応要件: FR-409(スイープ)、FR-417(抜き勾配)、FR-418(くり抜き)、FR-419(ミラー)、
 * FR-420(リブ)、FR-421(エンボス)、FR-423(外ねじ)、FR-424(移動/回転・拡大縮小)、
 * FR-425(点集合パターン)、FR-428(曲面)、FR-201/202(式のまま持つ)、FR-502、FR-504、
 * NFR-UX-1(対象を選んでから操作)、NFR-UX-4(Enter 連打で意味のある結果)、
 * NFR-UX-5(できない操作は実行前に理由を示す)。
 *
 * **`machiningCommands.ts`(P3 タスク25)とまったく同じ形にしてある。** 文脈は
 * `MachiningContext`(文書・ボディの一覧・選択)を使い回し、押せるかどうかは
 * `shapeEditReadiness`、確定は `commitShapeEdit` の 2 つだけを外へ出す。ストアにも DOM にも
 * 触れない純関数だけを置き、操作の判断を Node の単体検査で固定できるようにする
 * (`docs/報告記録.md` 2026-09-02 23:09 の教訓)。文書は不変で、断るときは元の文書を
 * そのまま返す(FR-504、NFR-UX-5)。
 *
 * **切断(FR-432)はここに置かない。** 平面の決め方(`PlaneSpec`)と予告の四角を持ち、
 * 「反対側も残す」で履歴を 2 段積む(§0.a-0.58)という別の作りなので `cutCommands.ts` にある。
 *
 * **押し出しの終わり方・薄板(FR-415/416)、ざぐり・皿もみ(FR-422)、可変半径の R 面取り
 * (FR-426)もここに無い。** タスク50 で既存の押し出し・穴・R 面取りへ畳んだので、確定は
 * `solidCommands.ts` の `commitExtrude` と `machiningCommands.ts` の `commitHole` /
 * `commitFillet` が受け持つ(統括の決定 2026-09-06)。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { selectedSweepGuide } from './sweepGuideChoices.js';
import {
  appendSolid,
  DEFAULT_DRAFT_ANGLE_DEGREES,
  DEFAULT_EMBOSS_HEIGHT_MM,
  DEFAULT_EMBOSS_RAISED,
  DEFAULT_MIRROR_PLANE_ID,
  DEFAULT_PRIMITIVE_AXIS,
  DEFAULT_RIB_EXTEND_TO_BODY,
  DEFAULT_RIB_SIDE,
  DEFAULT_RIB_THICKNESS_MM,
  DEFAULT_SCALE_FACTOR,
  DEFAULT_SHELL_OUTWARD,
  DEFAULT_SHELL_THICKNESS_MM,
  DEFAULT_SURFACE_ANGLE_DEGREES,
  DEFAULT_SURFACE_DISTANCE_MM,
  DEFAULT_SURFACE_OFFSET_MM,
  DEFAULT_SWEEP_FRENET,
  DEFAULT_THREAD_DESIGNATION,
  DEFAULT_THREAD_SHAFT_FROM_END,
  DEFAULT_THREAD_SHAFT_LENGTH_MM,
  DEFAULT_THREAD_SHAFT_MODELED,
  DEFAULT_TRANSFORM_ROTATION_DEGREES,
  DEFAULT_TRANSLATION_MM,
  findMetricThread,
  findSolid,
  isPatternSource,
  liveBodyIds,
  metricThreadPitch,
  nextSolidId,
  nextSolidName,
  type AxisSpec,
  type DraftFeature,
  type EmbossFeature,
  type MirrorFeature,
  type MirrorPlane,
  type PartDocument,
  type PatternFeature,
  type PointReference,
  type RibFeature,
  type RibSide,
  type ScaleFactor,
  type ScaleFeature,
  type ShellFeature,
  type SketchCurveRef,
  type SketchFaceRef,
  type SketchFeature,
  type SubShapeRef,
  type SurfaceFeature,
  type SurfaceOperation,
  type SweepFeature,
  type ThreadSeries,
  type ThreadShaftFeature,
  type TransformFeature,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type { SolidInputCommit } from '../sketch/numericInput.js';

import type { MachiningContext } from './machiningCommands.js';
import { findSketchFeatureAt } from './sketchRefs.js';
import type { SolidCommandOutcome, SolidToolReadiness } from './solidCommands.js';
import {
  parseSubShapeId,
  selectedBodyIds,
  selectedSubShapeRefs,
  subShapeRefOf,
  type SubShapeBody,
} from './subShapeSelection.js';

/**
 * Should 群の道具(§2.15 のツールバーの一覧のうち 11 個)。
 *
 * 計画書タスク50 の宣言は 10 個(`shell` を Could 群として外していた)だが、くり抜きは
 * model(タスク46 が前倒し)もカーネル(タスク53)も揃っているので、ここで一緒に扱う。
 * 道具の id は `SolidToolId`(`numericInput.ts` が正本)の部分集合で、立体のミラーだけは
 * スケッチの鏡像複写(FR-324)と id がぶつかるため `mirrorSolid` になっている。
 */
export type ShapeEditToolId =
  | 'draft'
  | 'mirrorSolid'
  | 'transform'
  | 'scale'
  | 'sweep'
  | 'rib'
  | 'emboss'
  | 'threadShaft'
  | 'surface'
  | 'pointPattern'
  | 'shell';

/** 押せる。 */
const READY: SolidToolReadiness = { ready: true, reasonKey: null };

/** 抜き勾配に要る面の最小枚数(基準の面 1 枚 + 傾ける面 1 枚以上)。 */
const MIN_DRAFT_FACES = 2;
/** 点集合パターンに要る点の最小数(2 つ以上でないと「並べる」意味を持たない)。 */
const MIN_PATTERN_POINTS = 2;
/** 曲面の「つなぐ」に要る輪郭の最小数。 */
const MIN_SURFACE_LOFT_SECTIONS = 2;

/* ------------------------------------------------------------------ *
 * 既定値(model の定数を式へ直したもの。同じ数を 2 か所に書かない)
 * ------------------------------------------------------------------ */

export const DEFAULT_DRAFT_ANGLE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_DRAFT_ANGLE_DEGREES,
);
export const DEFAULT_TRANSLATION: ExpressionValue =
  expressionValueFromNumber(DEFAULT_TRANSLATION_MM);
export const DEFAULT_ROTATION_ANGLE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_TRANSFORM_ROTATION_DEGREES,
);
export const DEFAULT_SCALE: ExpressionValue = expressionValueFromNumber(DEFAULT_SCALE_FACTOR);
export const DEFAULT_RIB_THICKNESS: ExpressionValue =
  expressionValueFromNumber(DEFAULT_RIB_THICKNESS_MM);
export const DEFAULT_EMBOSS_HEIGHT: ExpressionValue =
  expressionValueFromNumber(DEFAULT_EMBOSS_HEIGHT_MM);
export const DEFAULT_THREAD_SHAFT_LENGTH: ExpressionValue = expressionValueFromNumber(
  DEFAULT_THREAD_SHAFT_LENGTH_MM,
);
export const DEFAULT_SURFACE_DISTANCE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SURFACE_DISTANCE_MM,
);
export const DEFAULT_SURFACE_ANGLE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SURFACE_ANGLE_DEGREES,
);
export const DEFAULT_SURFACE_OFFSET: ExpressionValue =
  expressionValueFromNumber(DEFAULT_SURFACE_OFFSET_MM);
export const DEFAULT_SHELL_THICKNESS: ExpressionValue =
  expressionValueFromNumber(DEFAULT_SHELL_THICKNESS_MM);

/* ------------------------------------------------------------------ *
 * 選択 → 材料(スケッチの面・曲線・点、立体の面)
 * ------------------------------------------------------------------ */

/** 面フィーチャーだけを当たりとする種類の集合。 */
const FACE_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['face']);

/** 点・点列を当たりとする種類の集合(点集合パターンの置き場所)。 */
const POINT_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['point', 'pointArray']);

/**
 * 線として使えるスケッチのフィーチャーの種類(FR-420 のリブ、FR-409 の経路、FR-428 の輪郭)。
 *
 * 面(`face`)と点(`point` / `pointArray`)以外はすべて線を持つ。複写(`copy`)だけは
 * 「元の要素をまとめて複製したもの」で 1 本の線として指せないため外す。
 */
const CURVE_KINDS: ReadonlySet<SketchFeature['kind']> = new Set([
  'line',
  'arc',
  'rectangle',
  'polygon',
  'slot',
  'ellipse',
  'spline',
  'offset',
  'projectedCurve',
  'planeSection',
]);

/** 選択から最初のスケッチの面を拾う(スイープの断面・エンボスの輪郭)。 */
function selectedSketchFace(
  document: PartDocument,
  selection: readonly string[],
): SketchFaceRef | null {
  for (const elementId of selection) {
    // 編集中のスケッチを先に見る(`sketchRefs.ts` の説明。P4 仕上げ (g))。
    const found = findSketchFeatureAt(document, elementId, FACE_KINDS);
    if (found !== undefined) {
      return { sketchId: found.sketchId, faceFeatureId: found.featureId };
    }
  }
  return null;
}

/**
 * 選択からスケッチの線の連なりを選んだ順に拾う(`SketchCurveRef`)。
 *
 * **1 本のスケッチにまとめる。** 経路も輪郭も 1 つの平面に乗っていることが前提なので、
 * 最初に見つかった線のスケッチだけを見て、別のスケッチの線は読み飛ばす。
 * 同じフィーチャーを 2 度選んでも 1 回だけ数える。
 */
export function selectedCurvePath(
  document: PartDocument,
  selection: readonly string[],
): SketchCurveRef | null {
  let sketchId: string | null = null;
  const curveIds: string[] = [];
  const seen = new Set<string>();
  for (const elementId of selection) {
    const found = findSketchFeatureAt(document, elementId, CURVE_KINDS);
    if (found === undefined) {
      continue;
    }
    if (sketchId === null) {
      sketchId = found.sketchId;
    } else if (sketchId !== found.sketchId) {
      continue;
    }
    if (!seen.has(found.featureId)) {
      seen.add(found.featureId);
      curveIds.push(found.featureId);
    }
  }
  return sketchId === null || curveIds.length === 0 ? null : { sketchId, curveIds };
}

/** 選択から線を 1 本ずつ別々の輪郭として拾う(曲面の「つなぐ」の断面)。 */
function selectedCurveSections(
  document: PartDocument,
  selection: readonly string[],
): readonly SketchCurveRef[] {
  const sections: SketchCurveRef[] = [];
  const seen = new Set<string>();
  for (const elementId of selection) {
    const found = findSketchFeatureAt(document, elementId, CURVE_KINDS);
    if (found === undefined || seen.has(found.featureId)) {
      continue;
    }
    seen.add(found.featureId);
    sections.push({ sketchId: found.sketchId, curveIds: [found.featureId] });
  }
  return sections;
}

/**
 * 選択から点の参照を選んだ順に拾う(点集合パターンの置き場所、FR-425)。
 *
 * スケッチの点・点列は `{ kind: 'point' }`、立体の頂点は `{ kind: 'subShape' }` になる
 * (model の `PointReference` の 2 通り。座標を写さないので、上流が動けば置き場所も動く)。
 */
function selectedPointReferences(
  document: PartDocument,
  bodies: readonly SubShapeBody[],
  selection: readonly string[],
): readonly PointReference[] {
  const points: PointReference[] = [];
  const seen = new Set<string>();
  for (const elementId of selection) {
    if (seen.has(elementId)) {
      continue;
    }
    seen.add(elementId);
    const parsed = parseSubShapeId(elementId);
    if (parsed !== null) {
      if (parsed.kind !== 'vertex') {
        continue;
      }
      const ref = subShapeRefOf(bodies, elementId);
      if (ref !== null) {
        points.push({ kind: 'subShape', ref });
      }
      continue;
    }
    const found = findSketchFeatureAt(document, elementId, POINT_KINDS);
    if (found !== undefined) {
      points.push({ kind: 'point', pointId: found.featureId });
    }
  }
  return points;
}

/**
 * 対象になる立体を 1 つ決める(§0.a-0.6)。
 *
 * **直に選ばれている立体を先に見る。** 抜き勾配・エンボス・外ねじ・くり抜きは面を選ぶが、
 * ミラー・移動/回転・拡大縮小・リブは立体そのものを選ぶ。どちらの選び方でも同じ関数で
 * 決まるようにしてある(NFR-UX-1)。ちょうど 1 つに決まらなければ null。
 */
function shapeEditTargetOf(context: MachiningContext): string | null {
  const bodyIds = selectedBodyIds(context.selection, liveBodyIds(context.document));
  if (bodyIds.length === 1) {
    return bodyIds[0];
  }
  if (bodyIds.length > 1) {
    return null;
  }
  let common: string | null = null;
  for (const elementId of context.selection) {
    const parsed = parseSubShapeId(elementId);
    if (parsed === null) {
      continue;
    }
    if (common === null) {
      common = parsed.bodyFeatureId;
    } else if (common !== parsed.bodyFeatureId) {
      return null;
    }
  }
  return common;
}

/** 選択中の立体の面(選んだ順)。 */
function selectedSolidFaces(context: MachiningContext): readonly SubShapeRef[] {
  return selectedSubShapeRefs(context.bodies, context.selection, 'face');
}

/** その参照が平らな面か(指紋の曲面の種類で見る)。 */
function isFlatFace(ref: SubShapeRef): boolean {
  return ref.fingerprint.kind === 'face' && ref.fingerprint.surfaceKind === 'plane';
}

/** その参照が円柱の面か(外ねじを切れるのは丸い軸だけ、FR-423)。 */
function isCylinderFace(ref: SubShapeRef): boolean {
  return ref.fingerprint.kind === 'face' && ref.fingerprint.surfaceKind === 'cylinder';
}

/* ------------------------------------------------------------------ *
 * 選択肢の文字列 → model の型(未知の値は断る)
 * ------------------------------------------------------------------ */

/**
 * 段が運んでくる選択肢は**文字列のまま**なので、ここで 1 度だけ model の型へ読み替える
 * (`SolidShapeChoices` の注釈。組み立ての規則は「作る側」に 1 か所だけ置く)。
 *
 * **知らない値は断る。** 黙って既定へ落とすと、利用者が選んだ内容と作られた形が食い違う
 * まま履歴に積まれる(NFR-UX-5)。省略(undefined)は「その選択肢を持たない段から来た」
 * ことを意味するので、model の既定を使う。
 */
type ChoiceOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonKey: MessageKey };

const UNKNOWN_CHOICE: ChoiceOutcome<never> = {
  ok: false,
  reasonKey: 'shapeError.unknownChoice',
};

function ribSideOf(value: string | undefined): ChoiceOutcome<RibSide> {
  switch (value) {
    case undefined:
      return { ok: true, value: DEFAULT_RIB_SIDE };
    case 'both':
    case 'positive':
    case 'negative':
      return { ok: true, value };
    default:
      return UNKNOWN_CHOICE;
  }
}

function threadShaftEndOf(value: string | undefined): ChoiceOutcome<'first' | 'last'> {
  switch (value) {
    case undefined:
      return { ok: true, value: DEFAULT_THREAD_SHAFT_FROM_END };
    case 'first':
    case 'last':
      return { ok: true, value };
    default:
      return UNKNOWN_CHOICE;
  }
}

/**
 * ミラーの鏡にする面(FR-419、§0.a-0.36)。基準の 3 面はそのまま `workPlane`、
 * 「選んだ面」だけが立体の平らな面(指紋)になる。
 */
function mirrorPlaneOf(
  value: string | undefined,
  faces: readonly SubShapeRef[],
): ChoiceOutcome<MirrorPlane> {
  switch (value) {
    case undefined:
      return { ok: true, value: { kind: 'workPlane', planeId: DEFAULT_MIRROR_PLANE_ID } };
    case 'xy':
    case 'xz':
    case 'yz':
      return { ok: true, value: { kind: 'workPlane', planeId: value } };
    case 'face': {
      const face = faces.find(isFlatFace);
      return face === undefined
        ? { ok: false, reasonKey: 'shapeError.noFlatFace' }
        : { ok: true, value: { kind: 'face', face } };
    }
    default:
      return UNKNOWN_CHOICE;
  }
}

/* ------------------------------------------------------------------ *
 * 押せる条件(NFR-UX-5)
 * ------------------------------------------------------------------ */

/**
 * 抜き勾配(FR-417)。**基準にする平らな面 1 枚と、傾ける面 1 枚以上**が要る。
 * 選んだ順の 1 枚目が基準(中立面)で、残りが傾ける面になる。
 */
function draftRejection(context: MachiningContext): MessageKey | null {
  const faces = selectedSolidFaces(context);
  if (faces.length === 0) {
    return 'shapeError.noNeutralFace';
  }
  const neutral = faces[0];
  if (neutral === undefined || !isFlatFace(neutral)) {
    return 'shapeError.noNeutralFace';
  }
  if (faces.length < MIN_DRAFT_FACES) {
    return 'shapeError.noDraftFace';
  }
  return shapeEditTargetOf(context) === null ? 'shapeError.noTargetBody' : null;
}

/** 立体をちょうど 1 つ選ぶ道具(ミラー・移動/回転・拡大縮小・くり抜き)。 */
function singleBodyRejection(context: MachiningContext): MessageKey | null {
  return shapeEditTargetOf(context) === null ? 'shapeError.noTargetBody' : null;
}

/** スイープ(FR-409)。断面(スケッチの面)1 枚と経路(スケッチの線)が要る。 */
function sweepRejection(context: MachiningContext): MessageKey | null {
  if (selectedSketchFace(context.document, context.selection) === null) {
    return 'shapeError.noProfile';
  }
  return selectedCurvePath(context.document, context.selection) === null
    ? 'shapeError.noPath'
    : null;
}

/** リブ(FR-420)。対象の立体 1 つと、壁にする輪郭(開いていてよい)が要る。 */
function ribRejection(context: MachiningContext): MessageKey | null {
  if (shapeEditTargetOf(context) === null) {
    return 'shapeError.noTargetBody';
  }
  return selectedCurvePath(context.document, context.selection) === null
    ? 'shapeError.noProfile'
    : null;
}

/** エンボス(FR-421)。平らな面 1 枚と、彫る形の閉じた輪郭(スケッチの面)が要る。 */
function embossRejection(context: MachiningContext): MessageKey | null {
  const face = selectedSolidFaces(context).find(isFlatFace);
  if (face === undefined) {
    return 'shapeError.noFlatFace';
  }
  return selectedSketchFace(context.document, context.selection) === null
    ? 'shapeError.noProfile'
    : null;
}

/** 外ねじ(FR-423)。円柱の面 1 枚が要る(平面を選んだら理由を出す)。 */
function threadShaftRejection(context: MachiningContext): MessageKey | null {
  if (selectedSolidFaces(context).find(isCylinderFace) === undefined) {
    return 'shapeError.notCylinderFace';
  }
  return shapeEditTargetOf(context) === null ? 'shapeError.noTargetBody' : null;
}

/**
 * 曲面(FR-428)。作り方は段の選択肢で決まるので、押す時点では**材料が 1 つでもあるか**
 * だけを見る(輪郭の線か、立体の面)。作り方ごとの過不足は確定のときに断る。
 */
function surfaceRejection(context: MachiningContext): MessageKey | null {
  const hasCurve = selectedCurvePath(context.document, context.selection) !== null;
  const hasFace = selectedSolidFaces(context).length > 0;
  return hasCurve || hasFace ? null : 'shapeError.noSurfaceSource';
}

/** 点集合パターン(FR-425)。並べる加工 1 つと、置き場所の点が 2 つ以上要る。 */
function pointPatternRejection(context: MachiningContext): MessageKey | null {
  const source = pointPatternSourceOf(context);
  if (source === null) {
    return 'shapeError.noPatternSource';
  }
  const points = selectedPointReferences(context.document, context.bodies, context.selection);
  return points.length < MIN_PATTERN_POINTS ? 'shapeError.noPatternPoints' : null;
}

/**
 * 点集合パターンで繰り返す加工(穴・ねじ穴に限る、§0.a-0.20)を選択から決める。
 * 直線・円形パターン(`machiningCommands.ts` の `selectedPatternSource`)と同じ判定を使う。
 */
function pointPatternSourceOf(context: MachiningContext): string | null {
  const bodyIds = selectedBodyIds(context.selection, liveBodyIds(context.document));
  for (const bodyId of bodyIds) {
    const feature = findSolid(context.document, bodyId);
    if (feature !== undefined && isPatternSource(feature)) {
      return bodyId;
    }
  }
  return null;
}

/**
 * その道具がいま押せるか(NFR-UX-5)。`machiningToolReadiness` と同じ形で返す。
 *
 * 判定は実際に作るときと同じ関数を使うので、「押せるのに断られる」「押せないのに作れる」が
 * 起きない(`machiningCommands.ts` と同じ約束)。
 */
export function shapeEditReadiness(
  context: MachiningContext,
  tool: ShapeEditToolId,
): SolidToolReadiness {
  const rejection = shapeEditRejection(context, tool);
  return rejection === null ? READY : { ready: false, reasonKey: rejection };
}

/** 道具ごとの断りの理由(押せるなら null)。網羅の switch で足し忘れを型検査が捕まえる。 */
function shapeEditRejection(
  context: MachiningContext,
  tool: ShapeEditToolId,
): MessageKey | null {
  switch (tool) {
    case 'draft':
      return draftRejection(context);
    case 'mirrorSolid':
    case 'transform':
    case 'scale':
    case 'shell':
      return singleBodyRejection(context);
    case 'sweep':
      return sweepRejection(context);
    case 'rib':
      return ribRejection(context);
    case 'emboss':
      return embossRejection(context);
    case 'threadShaft':
      return threadShaftRejection(context);
    case 'surface':
      return surfaceRejection(context);
    case 'pointPattern':
      return pointPatternRejection(context);
  }
}

/**
 * 道具 id が Should 群かどうか(`as` を使わずに絞り込む)。
 * `SolidInputCommit.tool` は押し出し・加工も含む `SolidToolId` なので、確定を受けるときに
 * ここで 1 度だけ絞る(`ruledCommands.ts` の `ruledToolOf` と同じ形)。
 */
export function shapeEditToolOf(tool: string): ShapeEditToolId | null {
  switch (tool) {
    case 'draft':
    case 'mirrorSolid':
    case 'transform':
    case 'scale':
    case 'sweep':
    case 'rib':
    case 'emboss':
    case 'threadShaft':
    case 'surface':
    case 'pointPattern':
    case 'shell':
      return tool;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * 確定(その場入力 → フィーチャー 1 つ)
 * ------------------------------------------------------------------ */

/** 履歴へ 1 段積んで結果を返す(全部の道具で同じ形)。 */
function appended(
  document: PartDocument,
  feature: Parameters<typeof appendSolid>[1],
  id: string,
): SolidCommandOutcome {
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/** 抜き勾配(FR-417)。1 枚目の面が基準(中立面)、残りが傾ける面。 */
function commitDraft(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const rejection = draftRejection(context);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  const faces = selectedSolidFaces(context);
  const neutralFace = faces[0];
  const target = shapeEditTargetOf(context);
  if (neutralFace === undefined || target === null) {
    // draftRejection が確かめた後なので通らないが、型の絞り込みに要る。
    return { ok: false, reasonKey: 'shapeError.noNeutralFace' };
  }
  const id = nextSolidId(context.document, 'draft');
  const feature: DraftFeature = {
    id,
    name: nextSolidName(context.document, 'draft'),
    suppressed: false,
    kind: 'draft',
    targetFeatureId: target,
    faces: faces.slice(1),
    neutralFace,
    angle: commit.values.draftAngle ?? DEFAULT_DRAFT_ANGLE,
    reversed: commit.flags.reversed ?? false,
  };
  return appended(context.document, feature, id);
}

/** ミラー(FR-419)。**対象を消費しない**ので、元と鏡像の両方が残る(§0.a-0.36)。 */
function commitMirror(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const target = shapeEditTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const plane = mirrorPlaneOf(commit.shapeChoices?.mirrorPlane, selectedSolidFaces(context));
  if (!plane.ok) {
    return { ok: false, reasonKey: plane.reasonKey };
  }
  const id = nextSolidId(context.document, 'mirror');
  const feature: MirrorFeature = {
    id,
    name: nextSolidName(context.document, 'mirror'),
    suppressed: false,
    kind: 'mirror',
    targetFeatureId: target,
    plane: plane.value,
  };
  return appended(context.document, feature, id);
}

/**
 * 移動/回転(FR-424)。**対象を消費する**(元の位置に残すと同じ形が二重になる)。
 *
 * 回す角度が 0 のときは `rotationAxis` を null にする。model が「null なら回さない」と
 * 決めており(`TransformFeature`)、0 度の回転を軸つきで持つと同じ形に 2 通りの書き方が
 * できてしまうため。
 */
function commitTransform(
  context: MachiningContext,
  commit: SolidInputCommit,
): SolidCommandOutcome {
  const target = shapeEditTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const rotationAngle = commit.values.rotationAngle ?? DEFAULT_ROTATION_ANGLE;
  const rotationAxis: AxisSpec | null =
    rotationAngle.value === 0 ? null : (commit.axis ?? DEFAULT_PRIMITIVE_AXIS);
  const id = nextSolidId(context.document, 'transform');
  const feature: TransformFeature = {
    id,
    name: nextSolidName(context.document, 'transform'),
    suppressed: false,
    kind: 'transform',
    targetFeatureId: target,
    translation: [
      commit.values.translationX ?? DEFAULT_TRANSLATION,
      commit.values.translationY ?? DEFAULT_TRANSLATION,
      commit.values.translationZ ?? DEFAULT_TRANSLATION,
    ],
    rotationAxis,
    rotationAngle,
  };
  return appended(context.document, feature, id);
}

/**
 * 拡大縮小(FR-424)。**対象を消費する。**
 *
 * 動かさない点は世界の原点にする。中心を選ばせる欄は §2.15 の段の表に無く、あとから
 * プロパティで式に直せる(FR-202、FR-502。基本形状の基準点と同じ扱い)。
 */
function commitScale(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const target = shapeEditTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const factor: ScaleFactor =
    commit.flags.scalePerAxis === true
      ? {
          kind: 'perAxis',
          x: commit.values.scaleX ?? DEFAULT_SCALE,
          y: commit.values.scaleY ?? DEFAULT_SCALE,
          z: commit.values.scaleZ ?? DEFAULT_SCALE,
        }
      : { kind: 'uniform', value: commit.values.scaleFactor ?? DEFAULT_SCALE };
  const id = nextSolidId(context.document, 'scale');
  const feature: ScaleFeature = {
    id,
    name: nextSolidName(context.document, 'scale'),
    suppressed: false,
    kind: 'scale',
    targetFeatureId: target,
    origin: { kind: 'origin' },
    factor,
  };
  return appended(context.document, feature, id);
}

/** スイープ(FR-409)。対象を取らない「作る」フィーチャー。 */
function commitSweep(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const profile = selectedSketchFace(context.document, context.selection);
  if (profile === null) {
    return { ok: false, reasonKey: 'shapeError.noProfile' };
  }
  const path = selectedCurvePath(context.document, context.selection);
  if (path === null) {
    return { ok: false, reasonKey: 'shapeError.noPath' };
  }
  const guide = selectedSweepGuide(context.document, commit.shapeChoices?.sweepGuide, path);
  if (guide === null) return { ok: false, reasonKey: 'shapeError.noSweepGuide' };
  const id = nextSolidId(context.document, 'sweep');
  const feature: SweepFeature = {
    id,
    name: nextSolidName(context.document, 'sweep'),
    suppressed: false,
    kind: 'sweep',
    profile,
    path,
    frenet: commit.flags.sweepFrenet ?? DEFAULT_SWEEP_FRENET,
    ...(guide === undefined ? {} : { guide }),
  };
  return appended(context.document, feature, id);
}

/** リブ(FR-420)。**対象を消費する。** 材料へ届くまで伸ばすのは既定どおり(タスク46)。 */
function commitRib(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const target = shapeEditTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const profile = selectedCurvePath(context.document, context.selection);
  if (profile === null) {
    return { ok: false, reasonKey: 'shapeError.noProfile' };
  }
  const side = ribSideOf(commit.shapeChoices?.ribSide);
  if (!side.ok) {
    return { ok: false, reasonKey: side.reasonKey };
  }
  const id = nextSolidId(context.document, 'rib');
  const feature: RibFeature = {
    id,
    name: nextSolidName(context.document, 'rib'),
    suppressed: false,
    kind: 'rib',
    targetFeatureId: target,
    profile,
    thickness: commit.values.ribThickness ?? DEFAULT_RIB_THICKNESS,
    side: side.value,
    extendToBody: DEFAULT_RIB_EXTEND_TO_BODY,
  };
  return appended(context.document, feature, id);
}

/** エンボス(FR-421)。**対象を消費する。** 面は平らな面だけ(タスク39)。 */
function commitEmboss(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const face = selectedSolidFaces(context).find(isFlatFace);
  if (face === undefined) {
    return { ok: false, reasonKey: 'shapeError.noFlatFace' };
  }
  const profile = selectedSketchFace(context.document, context.selection);
  if (profile === null) {
    return { ok: false, reasonKey: 'shapeError.noProfile' };
  }
  const target = shapeEditTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const id = nextSolidId(context.document, 'emboss');
  const feature: EmbossFeature = {
    id,
    name: nextSolidName(context.document, 'emboss'),
    suppressed: false,
    kind: 'emboss',
    targetFeatureId: target,
    face,
    profile,
    height: commit.values.embossHeight ?? DEFAULT_EMBOSS_HEIGHT,
    raised: commit.flags.raised ?? DEFAULT_EMBOSS_RAISED,
  };
  return appended(context.document, feature, id);
}

/**
 * 外ねじ(FR-423)。**対象を消費する。**
 *
 * ピッチは規格表(`findMetricThread` + `metricThreadPitch`)から作り、欄に入っていれば
 * そちらを使う(利用者が式で書き換えられる、FR-202)。**径は面から測る**ので聞かない。
 */
function commitThreadShaft(
  context: MachiningContext,
  commit: SolidInputCommit,
): SolidCommandOutcome {
  const face = selectedSolidFaces(context).find(isCylinderFace);
  if (face === undefined) {
    return { ok: false, reasonKey: 'shapeError.notCylinderFace' };
  }
  const target = shapeEditTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const fromEnd = threadShaftEndOf(commit.shapeChoices?.threadShaftEnd);
  if (!fromEnd.ok) {
    return { ok: false, reasonKey: fromEnd.reasonKey };
  }
  const series: ThreadSeries = commit.threadSeries ?? 'coarse';
  const fallback = findMetricThread(DEFAULT_THREAD_DESIGNATION);
  if (fallback === undefined) {
    throw new Error('DEFAULT_THREAD_DESIGNATION が METRIC_THREADS の表にありません。');
  }
  const size = findMetricThread(commit.threadDesignation ?? DEFAULT_THREAD_DESIGNATION) ?? fallback;
  const id = nextSolidId(context.document, 'threadShaft');
  const feature: ThreadShaftFeature = {
    id,
    name: nextSolidName(context.document, 'threadShaft'),
    suppressed: false,
    kind: 'threadShaft',
    targetFeatureId: target,
    face,
    nominal: size.designation,
    series,
    pitch:
      commit.values.threadShaftPitch ??
      expressionValueFromNumber(metricThreadPitch(size, series)),
    length: commit.values.threadShaftLength ?? DEFAULT_THREAD_SHAFT_LENGTH,
    fromEnd: fromEnd.value,
    modeled: commit.flags.modeledThread ?? DEFAULT_THREAD_SHAFT_MODELED,
  };
  return appended(context.document, feature, id);
}

/**
 * 曲面(FR-428)。**どの作り方も対象を消費しない**(面を読むだけ、§0.a-0.45)。
 * 作り方ごとに要る材料が違うので、足りなければそれぞれの理由で断る(NFR-UX-5)。
 */
function surfaceOperationOf(
  context: MachiningContext,
  commit: SolidInputCommit,
): ChoiceOutcome<SurfaceOperation> {
  const value = commit.shapeChoices?.surfaceOperation ?? 'extrude';
  const profile = selectedCurvePath(context.document, context.selection);
  const face = selectedSolidFaces(context)[0];
  const target = shapeEditTargetOf(context);
  switch (value) {
    case 'extrude':
      return profile === null
        ? { ok: false, reasonKey: 'shapeError.noProfile' }
        : {
            ok: true,
            value: {
              kind: 'extrude',
              profile,
              distance: commit.values.surfaceDistance ?? DEFAULT_SURFACE_DISTANCE,
              reversed: commit.flags.reversed ?? false,
            },
          };
    case 'revolve':
      return profile === null
        ? { ok: false, reasonKey: 'shapeError.noProfile' }
        : {
            ok: true,
            value: {
              kind: 'revolve',
              profile,
              axis: commit.axis ?? DEFAULT_PRIMITIVE_AXIS,
              angle: commit.values.surfaceAngle ?? DEFAULT_SURFACE_ANGLE,
              reversed: commit.flags.reversed ?? false,
            },
          };
    case 'planar':
      return profile === null
        ? { ok: false, reasonKey: 'shapeError.noProfile' }
        : { ok: true, value: { kind: 'planar', profile } };
    case 'loft': {
      const sections = selectedCurveSections(context.document, context.selection);
      return sections.length < MIN_SURFACE_LOFT_SECTIONS
        ? { ok: false, reasonKey: 'shapeError.noProfile' }
        : { ok: true, value: { kind: 'loft', sections, ruled: false } };
    }
    case 'face':
      return face === undefined || target === null
        ? { ok: false, reasonKey: 'shapeError.noSurfaceSource' }
        : { ok: true, value: { kind: 'face', targetFeatureId: target, face } };
    case 'offset':
      return face === undefined || target === null
        ? { ok: false, reasonKey: 'shapeError.noSurfaceSource' }
        : {
            ok: true,
            value: {
              kind: 'offset',
              targetFeatureId: target,
              face,
              distance: commit.values.surfaceOffset ?? DEFAULT_SURFACE_OFFSET,
            },
          };
    default:
      return UNKNOWN_CHOICE;
  }
}

function commitSurface(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const operation = surfaceOperationOf(context, commit);
  if (!operation.ok) {
    return { ok: false, reasonKey: operation.reasonKey };
  }
  const id = nextSolidId(context.document, 'surface');
  const feature: SurfaceFeature = {
    id,
    name: nextSolidName(context.document, 'surface'),
    suppressed: false,
    kind: 'surface',
    operation: operation.value,
  };
  return appended(context.document, feature, id);
}

/** 点集合パターン(FR-425)。もとの加工を、選んだ点の場所へ並べる。 */
function commitPointPattern(context: MachiningContext): SolidCommandOutcome {
  const rejection = pointPatternRejection(context);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  const sourceFeatureId = pointPatternSourceOf(context);
  if (sourceFeatureId === null) {
    return { ok: false, reasonKey: 'shapeError.noPatternSource' };
  }
  const points = selectedPointReferences(context.document, context.bodies, context.selection);
  const id = nextSolidId(context.document, 'pointPattern');
  const feature: PatternFeature = {
    id,
    name: nextSolidName(context.document, 'pointPattern'),
    suppressed: false,
    kind: 'pattern',
    sourceFeatureId,
    placement: { kind: 'points', points },
  };
  return appended(context.document, feature, id);
}

/**
 * くり抜き(FR-418)。**対象を消費する。**
 * 開ける面は 0 枚でもよい(閉じたまま中だけ空になる。タスク53 の実測)。
 */
function commitShell(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const target = shapeEditTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const id = nextSolidId(context.document, 'shell');
  const feature: ShellFeature = {
    id,
    name: nextSolidName(context.document, 'shell'),
    suppressed: false,
    kind: 'shell',
    targetFeatureId: target,
    openFaces: selectedSolidFaces(context),
    thickness: commit.values.shellThickness ?? DEFAULT_SHELL_THICKNESS,
    outward: commit.flags.shellOutward ?? DEFAULT_SHELL_OUTWARD,
  };
  return appended(context.document, feature, id);
}

/**
 * その場入力の確定結果から Should 群のフィーチャーを 1 つ作る(**履歴は 1 段**)。
 *
 * 材料は**決めた時点の選択**から拾い直す(ポップアップを開いたまま選び直せるので、
 * 最後に選ばれていたものを使うのが利用者の期待に合う。NFR-UX-1)。欄が空のまま決めたときは
 * model の既定値で作る(NFR-UX-4)。
 */
export function commitShapeEdit(
  context: MachiningContext,
  commit: SolidInputCommit,
  tool: ShapeEditToolId,
): SolidCommandOutcome {
  switch (tool) {
    case 'draft':
      return commitDraft(context, commit);
    case 'mirrorSolid':
      return commitMirror(context, commit);
    case 'transform':
      return commitTransform(context, commit);
    case 'scale':
      return commitScale(context, commit);
    case 'sweep':
      return commitSweep(context, commit);
    case 'rib':
      return commitRib(context, commit);
    case 'emboss':
      return commitEmboss(context, commit);
    case 'threadShaft':
      return commitThreadShaft(context, commit);
    case 'surface':
      return commitSurface(context, commit);
    case 'pointPattern':
      return commitPointPattern(context);
    case 'shell':
      return commitShell(context, commit);
  }
}
