/**
 * 選択からソリッドフィーチャーを作る純関数(計画書 docs/plans/P2-ソリッド基礎.md タスク18、
 * docs/plans/P3-加工フィーチャー.md タスク25b)。
 *
 * 対応要件: FR-401(押し出し)、FR-402(回転)、FR-403(縫合)、FR-404(ブーリアン)、FR-414(ばね)、
 * NFR-UX-1(対象を選んでから操作)、NFR-UX-5(できない操作は理由を示す)。
 *
 * `packages/ui/src/sketch/sketchCommands.ts` と同じ流儀に揃える。ストアにも DOM にも
 * 触れない純関数だけを置き、操作の判断を Node の単体検査で固定できるようにする
 * (`docs/報告記録.md` 2026-09-02 23:09 の教訓)。文書は不変で、確定できないときは
 * 元の文書をそのまま返す。
 *
 * **ばね(`commitSpring`)はここに置く。** ばねは対象を消費しない「作る」フィーチャーで、
 * 押し出し・回転・縫合の仲間であり加工ではない(§0.a-0.36)。加工6種(穴・ねじ穴・R面取り・
 * C面取り・直線/円形パターン)の実装は `machiningCommands.ts`(タスク25)にあり、
 * `solidToolReadiness` / `commitSolidInput` はそちらへ委譲する。
 */

import { evaluateExpression, expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  appendSolid,
  DEFAULT_SEW_TOLERANCE_MM,
  DEFAULT_SPRING_COIL_DIAMETER_MM,
  DEFAULT_SPRING_PITCH_MM,
  DEFAULT_SPRING_TURNS as DEFAULT_SPRING_TURNS_COUNT,
  DEFAULT_SPRING_WIRE_DIAMETER_MM,
  findFeature,
  findSketch,
  liveBodyIds,
  nextSolidId,
  nextSolidName,
  type BooleanOperation,
  type ExtrudeFeature,
  type PartDocument,
  type RevolveAxis,
  type RevolveFeature,
  type SewFeature,
  type SketchFaceRef,
  type SketchFeature,
  type SketchLineRef,
  type SketchPointRef,
  type SpringDerived,
  type SpringFeature,
  type SpringHandedness,
  type BooleanFeature,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type { SolidInputCommit, SolidToolId } from '../sketch/numericInput.js';

import {
  commitMachiningInput,
  DEFAULT_TILT_ANGLE,
  DEFAULT_TILT_AZIMUTH,
  machiningToolReadiness,
  type MachiningContext,
} from './machiningCommands.js';
import { findSketchFeatureAt } from './sketchRefs.js';
import type { SubShapeBody } from './subShapeSelection.js';

/** 縫合に要る面の最小枚数(§0.a-0.7)。 */
const MIN_SEW_FACES = 2;
/** ブーリアンに要るボディの選択数(§0.a-0.6)。 */
const REQUIRED_BODY_COUNT = 2;

/** 押し出し距離の既定値(§0.a-0.8)。 */
export const DEFAULT_EXTRUDE_DISTANCE: ExpressionValue = expressionValueFromNumber(10);
/** 回転角度の既定値(§0.a-0.9)。 */
export const DEFAULT_REVOLVE_ANGLE: ExpressionValue = expressionValueFromNumber(360);
/** 回転軸の既定値。world の Z 軸(§0.a-0.9)。 */
export const DEFAULT_REVOLVE_AXIS: RevolveAxis = { kind: 'world', axis: 'z' };
/** 縫合の許容量の既定値。model の DEFAULT_SEW_TOLERANCE_MM を式へ直したもの(§0.a-0.7)。 */
export const DEFAULT_SEW_TOLERANCE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SEW_TOLERANCE_MM,
);

/** ばねのコイル径の既定値。model の DEFAULT_SPRING_COIL_DIAMETER_MM を式へ直したもの(§0.a-0.30)。 */
export const DEFAULT_SPRING_COIL_DIAMETER: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SPRING_COIL_DIAMETER_MM,
);
/** ばねの線径の既定値。 */
export const DEFAULT_SPRING_WIRE_DIAMETER: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SPRING_WIRE_DIAMETER_MM,
);
/** ばねのピッチの既定値。 */
export const DEFAULT_SPRING_PITCH: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SPRING_PITCH_MM,
);
/** ばねの巻数の既定値(既定の全長はピッチ×巻数 = 20mm、§0.a-0.30)。 */
export const DEFAULT_SPRING_TURNS: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SPRING_TURNS_COUNT,
);
/** ばねの軸の既定値。world の Z 軸(§0.a-0.29)。 */
export const DEFAULT_SPRING_AXIS: RevolveAxis = { kind: 'world', axis: 'z' };
/** ばねの巻き方向の既定値(§0.a-0.33)。 */
export const DEFAULT_SPRING_HANDEDNESS: SpringHandedness = 'right';
/** 全長・ピッチ・巻数のうち計算で求める欄の既定値(§0.a-0.30)。 */
export const DEFAULT_SPRING_DERIVED: SpringDerived = 'length';
/**
 * ばねの全長の欄が無いとき(既定の `derived: 'length'` のとき、springLength は
 * その場入力に出てこない)に `commitSpring` へ渡す穴埋め値。`commitSpring` は
 * `derived` が指す欄を必ず自動生成した式で上書きするので、この値がそのまま
 * 使われることはない(§0.a-0.30)。計画書はこの定数を挙げていないので、export はせず
 * ここだけで使う(判断に迷った点として報告する)。
 */
const SPRING_LENGTH_PLACEHOLDER: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SPRING_PITCH_MM * DEFAULT_SPRING_TURNS_COUNT,
);

/** ソリッドのフィーチャーを 1 つ作った結果。断ったときは文書を変えない。 */
export type SolidCommandOutcome =
  | { readonly ok: true; readonly document: PartDocument; readonly featureId: string }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * ツールバーの「ソリッド」区画に並ぶ 6 つの操作(§0.a-0.15)。
 *
 * 前の 3 つは数値を聞いてから作るので `SolidToolId`(numericInput.ts が正本)と同じ id を使い、
 * 後の 3 つは選んで押すだけなので `BooleanOperation` の id をそのまま使う。同じものを
 * 2 か所で数え直さないよう、どちらも既存の型から組み立てる。
 */
export type SolidActionId = SolidToolId | BooleanOperation;

/** その操作がいま押せるか。押せないときは理由を添える(NFR-UX-5)。 */
export interface SolidToolReadiness {
  readonly ready: boolean;
  /** 押せない理由の文言キー。押せるときは null。 */
  readonly reasonKey: MessageKey | null;
}

/** 選択から面フィーチャーの参照を 1 つ拾った結果。 */
export type FaceRefOutcome =
  | { readonly ok: true; readonly ref: SketchFaceRef }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 選択から面フィーチャーの参照を複数拾った結果(縫合用)。 */
export type FaceRefsOutcome =
  | { readonly ok: true; readonly refs: readonly SketchFaceRef[] }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 選択からブーリアンの対象・相手を決めた結果。 */
export type BodyPairOutcome =
  | { readonly ok: true; readonly targetFeatureId: string; readonly toolFeatureId: string }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 面・線分・点だけを当たりとする種類の集合(`findSketchFeatureAt` へ渡す)。 */
const FACE_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['face']);
const LINE_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['line']);
const POINT_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['point']);

/**
 * 要素 id が面フィーチャーを指しているかを、id の接頭辞ではなく文書を引いて判定する。
 * 見つからなければ undefined(面でない、または実在しない)。
 *
 * 探す順は `findSketchFeatureAt`(`sketchRefs.ts`)に任せ、**編集中のスケッチを先に**見る。
 * 文書の並び順に前から探すと、スケッチ 2 の `face-1` を押し出したつもりでスケッチ 1 の
 * `face-1` が使われる(P4 タスク27 の報告 (B)、仕上げ (g) で修正)。
 */
function faceRefById(document: PartDocument, elementId: string): SketchFaceRef | undefined {
  const found = findSketchFeatureAt(document, elementId, FACE_KINDS);
  return found === undefined
    ? undefined
    : { sketchId: found.sketchId, faceFeatureId: found.featureId };
}

/**
 * 選択中の要素から面フィーチャーの参照を 1 つ拾う(押し出し・回転用)。
 * 複数選ばれていても先頭の面を使う。面が 1 つも無ければ noFace。
 */
export function selectedFaceRef(
  document: PartDocument,
  selection: readonly string[],
): FaceRefOutcome {
  for (const elementId of selection) {
    const ref = faceRefById(document, elementId);
    if (ref !== undefined) {
      return { ok: true, ref };
    }
  }
  return { ok: false, reasonKey: 'solidError.noFace' };
}

/**
 * 選択中の要素から面フィーチャーの参照をすべて拾う(縫合用)。選んだ順を保つ。
 * 面でない要素は読み飛ばす。集まった面が 2 枚未満なら needTwoFaces。
 */
export function selectedFaceRefs(
  document: PartDocument,
  selection: readonly string[],
): FaceRefsOutcome {
  const refs: SketchFaceRef[] = [];
  for (const elementId of selection) {
    const ref = faceRefById(document, elementId);
    if (ref !== undefined) {
      refs.push(ref);
    }
  }
  if (refs.length < MIN_SEW_FACES) {
    return { ok: false, reasonKey: 'solidError.needTwoFaces' };
  }
  return { ok: true, refs };
}

/**
 * 選択中の要素から回転軸に使える線分の参照を 1 本拾う(§0.a-0.9)。
 *
 * 線分が選ばれていないときは undefined を返し、回転軸の選択肢は X / Y / Z だけになる。
 * 「線分が無い」は失敗ではない(軸の既定は world の Z)ので理由は持たない。
 */
export function selectedLineRef(
  document: PartDocument,
  selection: readonly string[],
): SketchLineRef | undefined {
  for (const elementId of selection) {
    // 面と同じく、編集中のスケッチを先に見る(仕上げ (g)。`faceRefById` の注釈を参照)。
    const found = findSketchFeatureAt(document, elementId, LINE_KINDS);
    if (found !== undefined) {
      return { sketchId: found.sketchId, lineFeatureId: found.featureId };
    }
  }
  return undefined;
}

/**
 * 選択中の要素からブーリアンの対象・相手を決める(§0.a-0.6)。
 * `selection` は面などとも混じり得るので、`liveBodyIds` に載っている id だけを数える。
 * 先に選んだものが対象、後(Shift で追加した方)が相手。ちょうど 2 つでなければ needTwoBodies。
 */
export function selectedBodyPair(
  selection: readonly string[],
  liveIds: readonly string[],
): BodyPairOutcome {
  const live = new Set(liveIds);
  const bodyIds = selection.filter((id) => live.has(id));
  if (bodyIds.length !== REQUIRED_BODY_COUNT) {
    return { ok: false, reasonKey: 'solidError.needTwoBodies' };
  }
  const [targetFeatureId, toolFeatureId] = bodyIds;
  return { ok: true, targetFeatureId, toolFeatureId };
}

/** `SketchFaceRef` が指す面フィーチャーが実在するか。 */
function faceRefExists(document: PartDocument, ref: SketchFaceRef): boolean {
  const sketch = findSketch(document, ref.sketchId);
  if (sketch === undefined) {
    return false;
  }
  const feature = findFeature(sketch, ref.faceFeatureId);
  return feature !== undefined && feature.kind === 'face';
}

/**
 * `SketchPointRef` が指す点フィーチャーが実在するか。**点列(`kind: 'pointArray'`)は
 * 受け付けない**(始点は 1 点でなければならない、§0.a-0.29)。
 */
function pointRefExists(document: PartDocument, ref: SketchPointRef): boolean {
  const sketch = findSketch(document, ref.sketchId);
  if (sketch === undefined) {
    return false;
  }
  const feature = findFeature(sketch, ref.pointFeatureId);
  return feature !== undefined && feature.kind === 'point';
}

/** 選択からばねの始点にする点フィーチャーを 1 つ拾った結果(タスク25b、§0.a-0.29)。 */
export type SpringOriginOutcome =
  | { readonly ok: true; readonly ref: SketchPointRef }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * 選択の中からばねの始点にする点フィーチャーを 1 つ拾う(§0.a-0.29)。選んだ順に見て、
 * 最初に見つかった**点フィーチャー(`kind: 'point'`)だけ**を使う。
 *
 * **点列は「その点列の1点目」として受け付けない。** 始点は 1 点でなければならないため、
 * 点列フィーチャー(`kind: 'pointArray'`)は読み飛ばす(この決めは計画書 §2.11 の表・
 * タスク25b の検証表どおり)。線分などほかの要素が混ざっていても無視して次を探す。
 * 1 つも見つからなければ `springError.noOriginPoint`。
 */
export function selectedSpringOrigin(
  document: PartDocument,
  selection: readonly string[],
): SpringOriginOutcome {
  for (const elementId of selection) {
    // 面・線分と同じく、編集中のスケッチを先に見る(仕上げ (g))。
    const found = findSketchFeatureAt(document, elementId, POINT_KINDS);
    if (found !== undefined) {
      return { ok: true, ref: { sketchId: found.sketchId, pointFeatureId: found.featureId } };
    }
  }
  return { ok: false, reasonKey: 'springError.noOriginPoint' };
}

/**
 * 式 `source` を評価して `ExpressionValue` にする。全長・ピッチ・巻数の関係式
 * (`全長 = ピッチ × 巻数`、§0.a-0.30)を自動生成した式を評価するのに使う。
 *
 * `pitch.source` と `turns.source` はどちらもすでに妥当な式(欄の検査を通っている)なので
 * `*` / `/` でつないだ式もほぼ必ず評価できるが、万一失敗しても例外を投げず(FR-504
 * 「止めずに警告する」)、少なくとも source は残して値 0 で作る。
 */
function evaluatedExpressionValue(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (result.ok) {
    return result.value;
  }
  return { source, value: 0, display: '0' };
}

/**
 * ばねの全長・ピッチ・巻数のうち、`derived` が指す 1 つを他の 2 つから自動生成した式で
 * 計算し直す(§0.a-0.30)。呼び出し側が `derived` の欄に何を渡していても、ここで必ず
 * 上書きする(呼び出し側は「入力された 2 つ」だけを正しく渡せばよい)。
 *
 * 自動生成した式の `source` は次のとおり(タスク25b の検証表で固定)。
 * - `derived: 'length'` → `` `${pitch.source}*${turns.source}` ``
 * - `derived: 'pitch'` → `` `${length.source}/${turns.source}` ``
 * - `derived: 'turns'` → `` `${length.source}/${pitch.source}` ``
 */
function resolveSpringLengthFields(
  derived: SpringDerived,
  length: ExpressionValue,
  pitch: ExpressionValue,
  turns: ExpressionValue,
): { readonly length: ExpressionValue; readonly pitch: ExpressionValue; readonly turns: ExpressionValue } {
  switch (derived) {
    case 'length':
      return { length: evaluatedExpressionValue(`${pitch.source}*${turns.source}`), pitch, turns };
    case 'pitch':
      return { length, pitch: evaluatedExpressionValue(`${length.source}/${turns.source}`), turns };
    case 'turns':
      return { length, pitch, turns: evaluatedExpressionValue(`${length.source}/${pitch.source}`) };
  }
}

/**
 * ばねを 1 つ作る(FR-414、§0.a-0.29〜0.36)。対象ボディを持たず、消費もしない
 * 「作る」フィーチャー(§0.a-0.36)。始点の参照先が無ければ `noOriginPoint` で断る。
 *
 * `params.length` / `pitch` / `turns` は 3 つとも渡すが、`derived` が指す 1 つは
 * `resolveSpringLengthFields` が他の 2 つから自動生成した式で必ず上書きする。
 */
export function commitSpring(
  document: PartDocument,
  params: {
    readonly origin: SketchPointRef;
    readonly axis: RevolveAxis;
    readonly tiltAngle: ExpressionValue;
    readonly tiltAzimuth: ExpressionValue;
    readonly length: ExpressionValue;
    readonly pitch: ExpressionValue;
    readonly turns: ExpressionValue;
    readonly derived: SpringDerived;
    readonly coilDiameter: ExpressionValue;
    readonly wireDiameter: ExpressionValue;
    readonly handedness: SpringHandedness;
  },
): SolidCommandOutcome {
  if (!pointRefExists(document, params.origin)) {
    return { ok: false, reasonKey: 'springError.noOriginPoint' };
  }
  const { length, pitch, turns } = resolveSpringLengthFields(
    params.derived,
    params.length,
    params.pitch,
    params.turns,
  );
  const id = nextSolidId(document, 'spring');
  const feature: SpringFeature = {
    id,
    name: nextSolidName(document, 'spring'),
    suppressed: false,
    kind: 'spring',
    origin: params.origin,
    axis: params.axis,
    tiltAngle: params.tiltAngle,
    tiltAzimuth: params.tiltAzimuth,
    length,
    pitch,
    turns,
    derived: params.derived,
    coilDiameter: params.coilDiameter,
    wireDiameter: params.wireDiameter,
    handedness: params.handedness,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/** 押し出しを 1 つ作る(FR-401)。面の参照先が無ければ noFace で断る。 */
export function commitExtrude(
  document: PartDocument,
  params: {
    readonly profile: SketchFaceRef;
    readonly distance: ExpressionValue;
    readonly reversed: boolean;
    readonly symmetric: boolean;
  },
): SolidCommandOutcome {
  if (!faceRefExists(document, params.profile)) {
    return { ok: false, reasonKey: 'solidError.noFace' };
  }
  const id = nextSolidId(document, 'extrude');
  const feature: ExtrudeFeature = {
    id,
    name: nextSolidName(document, 'extrude'),
    suppressed: false,
    kind: 'extrude',
    profile: params.profile,
    distance: params.distance,
    reversed: params.reversed,
    symmetric: params.symmetric,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/** 回転を 1 つ作る(FR-402)。面の参照先が無ければ noFace で断る。 */
export function commitRevolve(
  document: PartDocument,
  params: {
    readonly profile: SketchFaceRef;
    readonly axis: RevolveAxis;
    readonly angle: ExpressionValue;
    readonly reversed: boolean;
  },
): SolidCommandOutcome {
  if (!faceRefExists(document, params.profile)) {
    return { ok: false, reasonKey: 'solidError.noFace' };
  }
  const id = nextSolidId(document, 'revolve');
  const feature: RevolveFeature = {
    id,
    name: nextSolidName(document, 'revolve'),
    suppressed: false,
    kind: 'revolve',
    profile: params.profile,
    axis: params.axis,
    angle: params.angle,
    reversed: params.reversed,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/** 縫合を 1 つ作る(FR-403)。面が 2 枚未満なら needTwoFaces、参照先が無ければ noFace。 */
export function commitSew(
  document: PartDocument,
  params: { readonly faces: readonly SketchFaceRef[]; readonly tolerance: ExpressionValue },
): SolidCommandOutcome {
  if (params.faces.length < MIN_SEW_FACES) {
    return { ok: false, reasonKey: 'solidError.needTwoFaces' };
  }
  for (const face of params.faces) {
    if (!faceRefExists(document, face)) {
      return { ok: false, reasonKey: 'solidError.noFace' };
    }
  }
  const id = nextSolidId(document, 'sew');
  const feature: SewFeature = {
    id,
    name: nextSolidName(document, 'sew'),
    suppressed: false,
    kind: 'sew',
    faces: params.faces,
    tolerance: params.tolerance,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/**
 * ブーリアンを 1 つ作る(FR-404、§0.a-0.5)。
 * 対象と相手は同じ id なら sameBody、`liveBodyIds` に無ければ noBody で断る。
 */
export function commitBoolean(
  document: PartDocument,
  params: {
    readonly operation: BooleanOperation;
    readonly targetFeatureId: string;
    readonly toolFeatureId: string;
  },
): SolidCommandOutcome {
  if (params.targetFeatureId === params.toolFeatureId) {
    return { ok: false, reasonKey: 'solidError.sameBody' };
  }
  const live = new Set(liveBodyIds(document));
  if (!live.has(params.targetFeatureId) || !live.has(params.toolFeatureId)) {
    return { ok: false, reasonKey: 'solidError.noBody' };
  }
  const id = nextSolidId(document, params.operation);
  const feature: BooleanFeature = {
    id,
    name: nextSolidName(document, params.operation),
    suppressed: false,
    kind: 'boolean',
    operation: params.operation,
    targetFeatureId: params.targetFeatureId,
    toolFeatureId: params.toolFeatureId,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/** 押せる。 */
const READY: SolidToolReadiness = { ready: true, reasonKey: null };

/**
 * その操作がいま押せるか(NFR-UX-5)。ツールバーのボタンの有効・無効と、
 * 押せないときのツールチップの理由に使う。判定は実際に作るときと同じ関数で行うので、
 * 「押せるのに断られる」「押せないのに作れる」が起きない。
 *
 * `bodies` は加工6種(穴・ねじ穴・R面取り・C面取り・直線/円形パターン)を
 * `machiningToolReadiness`(タスク25、`machiningCommands.ts`)へ委譲するときに要る
 * カーネルの立体一覧(タスク20 の `SubShapeBody`)。**タスク26 がツールバー側から実際の
 * 一覧を渡すまでの間、既存の呼び出し(`Toolbar.tsx`)が3引数のままでも型検査が壊れないよう
 * 任意引数にし、既定を空配列にした**(計画書は4引数目を明記していないので、判断に迷った
 * 点として報告する)。押し出し・回転・縫合・和・差・積・ばねは `bodies` を使わない。
 */
export function solidToolReadiness(
  document: PartDocument,
  selection: readonly string[],
  tool: SolidActionId,
  bodies: readonly SubShapeBody[] = [],
): SolidToolReadiness {
  switch (tool) {
    case 'extrude':
    case 'revolve': {
      const face = selectedFaceRef(document, selection);
      return face.ok ? READY : { ready: false, reasonKey: face.reasonKey };
    }
    case 'sew': {
      const faces = selectedFaceRefs(document, selection);
      return faces.ok ? READY : { ready: false, reasonKey: faces.reasonKey };
    }
    case 'union':
    case 'subtract':
    case 'intersect': {
      const pair = selectedBodyPair(selection, liveBodyIds(document));
      if (!pair.ok) {
        return { ready: false, reasonKey: pair.reasonKey };
      }
      // 同じ立体を 2 度選ぶことは選択の仕組み上できないが、断る理由は作る側と揃えておく。
      return pair.targetFeatureId === pair.toolFeatureId
        ? { ready: false, reasonKey: 'solidError.sameBody' }
        : READY;
    }
    // 加工6種(タスク25)は machiningToolReadiness へ委譲する。同じ判断を2か所に書かない。
    case 'hole':
    case 'threadHole':
    case 'fillet':
    case 'chamfer':
    case 'linearPattern':
    case 'circularPattern': {
      const context: MachiningContext = { document, selection, bodies };
      return machiningToolReadiness(context, tool);
    }
    // ばね(タスク25b、§0.a-0.29)。押せる条件は「スケッチの点フィーチャーが1つ選ばれて
    // いること」だけ(軸は既定の Z があるので選ばなくてよい、NFR-UX-4)。
    case 'spring': {
      const origin = selectedSpringOrigin(document, selection);
      return origin.ok ? READY : { ready: false, reasonKey: origin.reasonKey };
    }
  }
}

/**
 * 選択とその場入力の確定結果から、ソリッドフィーチャーを 1 つ作る(タスク24 の SolidInputCommit)。
 *
 * 面はポップアップを開いた時点ではなく**決めた時点の選択**から拾い直す。開いたまま
 * 面を選び直せるので、最後に選ばれていたものを使うのが利用者の期待に合う(NFR-UX-1)。
 * 欄が空のまま決めたときは既定値で作る(NFR-UX-4)。
 *
 * 加工6種は `commitMachiningInput`(タスク25、`machiningCommands.ts`)へ委譲する。
 * `bodies` の扱いは `solidToolReadiness` の注釈のとおり(タスク26 まで既定は空配列)。
 * ばねは対象を消費しない「作る」フィーチャーなので、ここで直に `commitSpring` を呼ぶ
 * (§0.a-0.36)。
 */
export function commitSolidInput(
  document: PartDocument,
  selection: readonly string[],
  commit: SolidInputCommit,
  bodies: readonly SubShapeBody[] = [],
): SolidCommandOutcome {
  switch (commit.tool) {
    case 'extrude': {
      const face = selectedFaceRef(document, selection);
      if (!face.ok) {
        return { ok: false, reasonKey: face.reasonKey };
      }
      return commitExtrude(document, {
        profile: face.ref,
        distance: commit.values.distance ?? DEFAULT_EXTRUDE_DISTANCE,
        reversed: commit.flags.reversed ?? false,
        symmetric: commit.flags.symmetric ?? false,
      });
    }
    case 'revolve': {
      const face = selectedFaceRef(document, selection);
      if (!face.ok) {
        return { ok: false, reasonKey: face.reasonKey };
      }
      return commitRevolve(document, {
        profile: face.ref,
        axis: commit.axis ?? DEFAULT_REVOLVE_AXIS,
        angle: commit.values.angle ?? DEFAULT_REVOLVE_ANGLE,
        reversed: commit.flags.reversed ?? false,
      });
    }
    case 'sew': {
      const faces = selectedFaceRefs(document, selection);
      if (!faces.ok) {
        return { ok: false, reasonKey: faces.reasonKey };
      }
      return commitSew(document, {
        faces: faces.refs,
        tolerance: commit.values.tolerance ?? DEFAULT_SEW_TOLERANCE,
      });
    }
    // 加工6種(タスク25)は commitMachiningInput へ委譲する。同じ判断を2か所に書かない。
    case 'hole':
    case 'threadHole':
    case 'fillet':
    case 'chamfer':
    case 'linearPattern':
    case 'circularPattern': {
      const context: MachiningContext = { document, selection, bodies };
      return commitMachiningInput(context, commit);
    }
    // ばね(タスク25b、FR-414)。始点はスケッチの点フィーチャーの参照のみ(§0.a-0.29)。
    case 'spring': {
      const origin = selectedSpringOrigin(document, selection);
      if (!origin.ok) {
        return { ok: false, reasonKey: origin.reasonKey };
      }
      return commitSpring(document, {
        origin: origin.ref,
        axis: commit.axis ?? DEFAULT_SPRING_AXIS,
        // 傾き角・方位角はその場入力に出てこない(穴と同じ作り、§0.a-0.10)。
        // プロパティからの再編集はタスク29b の担当。
        tiltAngle: DEFAULT_TILT_ANGLE,
        tiltAzimuth: DEFAULT_TILT_AZIMUTH,
        length: commit.values.springLength ?? SPRING_LENGTH_PLACEHOLDER,
        pitch: commit.values.springPitch ?? DEFAULT_SPRING_PITCH,
        turns: commit.values.springTurns ?? DEFAULT_SPRING_TURNS,
        derived: commit.springDerived ?? DEFAULT_SPRING_DERIVED,
        coilDiameter: commit.values.coilDiameter ?? DEFAULT_SPRING_COIL_DIAMETER,
        wireDiameter: commit.values.wireDiameter ?? DEFAULT_SPRING_WIRE_DIAMETER,
        handedness: commit.springHandedness ?? DEFAULT_SPRING_HANDEDNESS,
      });
    }
  }
}

/**
 * 選択からブーリアンを 1 つ作る(§0.a-0.6)。和・差・積のボタンはこれ 1 つで済む。
 * 先に選んだ立体が対象、後(Shift で足した方)が相手になる。
 */
export function commitBooleanFromSelection(
  document: PartDocument,
  selection: readonly string[],
  operation: BooleanOperation,
): SolidCommandOutcome {
  const pair = selectedBodyPair(selection, liveBodyIds(document));
  if (!pair.ok) {
    return { ok: false, reasonKey: pair.reasonKey };
  }
  return commitBoolean(document, {
    operation,
    targetFeatureId: pair.targetFeatureId,
    toolFeatureId: pair.toolFeatureId,
  });
}
