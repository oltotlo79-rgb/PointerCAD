/**
 * その場数値入力で決まった 1 段を、ストアの控え(履歴・取りかけ・断り)へ反映する
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク14)。
 *
 * 対応要件: FR-301〜309、FR-314〜318、FR-326、FR-327、FR-330、FR-504、NFR-UX-5。
 *
 * 何を履歴へ積むかを決めるのは純関数 `commitSketchInput`(`sketchCommands.ts`)で、ここは
 * その結果をストアへ書くだけ。**同じ手順を 2 か所に書かないための 1 か所**で、
 * ポップアップの確定(`AppShell.tsx`)と、3D スケッチで立体の頂点を押したときの確定
 * (`attachSketchInteraction.ts`)の両方がここを通る。
 */

import {
  affectsShape,
  baseWorkPlane,
  FREE_WORK_PLANE_ID,
  isFreeWorkPlaneId,
  nextFeatureId,
  replaceSketch,
  splitLineIntersections,
  WORK_PLANES,
  type ProjectionSource,
  type PartDocument,
  type SketchDocument,
  type SketchResolveOptions,
  type WorkPlane,
} from '@pointercad/model';

import {
  cancelExtrusion,
  confirmExtrusion,
  stageExtrusion,
  stagedExtrusionMessageKey,
  type ExtrudeStageCandidate,
} from '../solid/extrudePreview.js';
import { commitSolidInput } from '../solid/solidCommands.js';
import { subShapeBodiesOf } from '../solid/subShapeSelection.js';
import type { StagedConfirmation } from '../store/recomputeSlice.js';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { splitLineFailureMessage } from './splitLineMessages.js';
import { commitSketchChamfer, commitSketchFillet } from './cornerCommands.js';
import {
  commitCircularArray,
  commitCopy,
  commitLinearArray,
  commitMirror,
  type CopyCommitOutcome,
} from './copyCommands.js';
import { commitOffset, type OffsetCommitOutcome } from './editCommands.js';
import { applyInferredConstraints } from './inferredConstraints.js';
import { nextNumericInput } from './numericInput.js';
import type {
  EditInputCommit,
  NumericInputCommit,
  NumericInputState,
  NumericInputTransition,
  PickEditToolId,
  ReferenceInputCommit,
  SolidInputCommit,
} from './numericInput.js';
import {
  commitProjectionSources,
  projectionMissingTargetKey,
  projectionSourcesRejection,
} from './projectionCommands.js';
import { commitReferenceInput } from './referenceCommands.js';
import { commitFace, commitSketchInput } from './sketchCommands.js';
import { prepareNumericMathCommit } from './numericMathValues.js';
import { tryMathComposition } from '../math/tryMathComposition.js';

/** Both canvas Enter and guided Enter publish a face through the same document transaction. */
export function applySelectedFace(): boolean {
  const state = useAppStore.getState();
  const outcome = commitFace(state.sketch, state.resolvedSketch, state.workPlaneId, state.selection);
  if (!outcome.ok) { state.setFaceError(outcome.reasonKey); return false; }
  state.setFaceError(null);
  state.setSketch(outcome.document);
  state.setSelection([]);
  return true;
}

/** Keep coefficient identities private until the same operation publishes a real feature. */
function mathCommitBase(inputs: unknown): PartDocument | null {
  const store = useAppStore.getState(), result = prepareNumericMathCommit(store.document, inputs);
  if (!result.ok) { store.setShapeError(result.message); return null; }
  return result.document;
}

/**
 * いま線や図形を置いている面。作図面があればそれを解いた面(`workPlane`)、3D スケッチ
 * (FR-330)なら最後に押した場所の面(`freeSketchPlane`)。まだ一度も押していなければ
 * 床と同じ向きの面へ落とす。
 *
 * 3D スケッチの面は「保存される作図面」ではなく、押した場所を世界座標へ直したり円弧の
 * 向きを決めたりするための一時的な面なので、id は `FREE_WORK_PLANE_ID` のままにする。
 */
export function drawingPlane(): WorkPlane {
  const state = useAppStore.getState();
  if (!isFreeWorkPlaneId(state.workPlaneId)) {
    return state.workPlane;
  }
  return state.freeSketchPlane ?? { ...WORK_PLANES.xy, id: FREE_WORK_PLANE_ID };
}

/**
 * 決まった 1 段を履歴・取りかけ・断りへ反映する。**受け取れたら true、断ったら false。**
 *
 * 断りは先に出す。`setSketch`(= `applyDocument`)は古い断りを消すので、順序を逆にすると
 * 出したばかりの理由が消える(NFR-UX-5)。返り値はポップアップが「閉じてよいか」の判断に使う
 * (断られたときは閉じない。P4 タスク33、タスク12 の申し送り)。
 */
export function applySketchCommit(
  commit: NumericInputCommit,
  input: NumericInputState | null,
): boolean {
  const store = useAppStore.getState();
  const base = mathCommitBase([commit, store.shapeDraft]);
  if (base === null) return false;
  const calculated = tryMathComposition(() => commitSketchInput(commit, {
    document: store.sketch,
    planeId: store.workPlaneId,
    plane: drawingPlane(),
    chaining: store.chaining,
    pendingStart: store.pendingStart,
    // P4 の新しい図形は、置いた点と前の段の値を下書きへ積む(タスク12)。
    // 欄の値を名前で引くのに、確定した段の状態も渡す。
    shapeDraft: store.shapeDraft,
    input: input ?? undefined,
  }));
  if (!calculated.ok) { store.setShapeError(calculated.message); return false; }
  const outcome = calculated.value;
  store.setShapeError(outcome.rejection);
  // 予告していた拘束(FR-333)を同じ文書へ足してから 1 回だけ差し替える。
  let document = outcome.document;
  let connected = false;
  if (outcome.rejection === null && commit.step === 'lineEnd' && document !== store.sketch
      && commit.flags.splitIntersections !== false) {
    const split = splitLineIntersections(document, nextFeatureId(store.sketch, 'line'), cornerResolveOptions());
    if (!split.ok) {
      store.setShapeError(splitLineFailureMessage(split.reason));
      return false;
    }
    document = split.document;
    connected = split.pointIds.length > 0;
  }
  // The preview concerned the whole straight line. Do not attach it to only its final piece.
  if (connected) store.setInferredConstraints(null);
  else document = withInferredConstraints(store, commit, document);
  if (document !== store.sketch) {
    store.applyDocument(replaceSketch(base, document));
  }
  store.setPendingStart(outcome.pendingStart);
  store.setShapeDraft(outcome.shapeDraft);
  return outcome.rejection === null;
}

/**
 * 線を引き終えた瞬間に、予告していた拘束を足す(FR-333、P6 タスク41、§0.a-0.50
 * 「確定は線を引き終えた瞬間」)。足すものが無ければ渡された文書をそのまま返す。
 *
 * **足すのは「予告したときに読んだ id」と「いま作られる線の id」が同じときだけ。**
 * 予告してから確定するまでに別のフィーチャーが増えていれば、印が指していた線と拘束が
 * 付く線が食い違うので、黙って捨てる(間違った線に拘束を付けるより出さないほうがよい)。
 *
 * 予告そのものは**足せても足せなくても必ず落とす**(1 回きりの表示で、次の線へ持ち越さない)。
 * 文書の差し替えは呼び出し側で 1 回なので、**線 1 本と拘束はまとめて 1 回の取り消しで戻る**
 * (NFR-UX-3)。
 */
function withInferredConstraints(
  store: ReturnType<typeof useAppStore.getState>,
  commit: NumericInputCommit,
  document: SketchDocument,
): SketchDocument {
  const preview = store.inferredConstraints;
  if (preview === null) {
    return document;
  }
  store.setInferredConstraints(null);
  // 段が違う(線の終点ではない)・断られて履歴が変わっていないときは足さない。
  if (commit.step !== 'lineEnd' || document === store.sketch) {
    return document;
  }
  if (preview.featureId !== nextFeatureId(store.sketch, 'line')) {
    return document;
  }
  return applyInferredConstraints(document, preview.constraints).document;
}

/**
 * 立体を 1 つ作って部品文書へ積む(FR-401〜403)。**受け取れたら true、断ったら false。**
 *
 * 何を作るかは純関数 `commitSolidInput` が決め、断られたら理由を帯へ出して履歴は変えない
 * (FR-504、NFR-UX-5)。作れたらその立体を選び、道具は選択へ戻す。
 *
 * 道具を先に選択へ戻し、そのあとで作ったフィーチャーを選ぶ(P4 タスク30 不具合(a))。
 * 逆順(選ぶ→道具を戻す)だと、穴・ねじ穴・R/C面取りのように選ぶ種類が面/辺から立体へ
 * 変わる道具では、`setActiveTool` が種類の変化を見て選択を空にしてしまい、作った直後の
 * 立体が選ばれない。`setActiveTool` を先に呼べば、選択が空になるのはこの時点までで、
 * その後の `setSelection` が確定して残る。
 *
 * (P4b タスク18 で `AppShell.tsx` から移した。ポップアップとコマンドラインの 2 つの入口が
 * 同じ手順を通るようにするため。手順そのものは 1 行も変えていない。)
 */
function currentCutSketches(store: ReturnType<typeof useAppStore.getState>) {
  const snapshot = store.resolvedPartSketches;
  if (snapshot === null || activePartDocument(store) === null || store.isComputing
    || store.recomputeCancelled || store.timelineIndex !== null || store.lastOutcome !== 'success'
    || snapshot.activeDocumentId !== store.activeDocumentId
    || snapshot.generation !== store.requestedGeneration || snapshot.generation !== store.completedGeneration
    || snapshot.document.id !== store.document.id || affectsShape(snapshot.document, store.document)) return undefined;
  return snapshot;
}

export function applySolidCommit(commit: SolidInputCommit): boolean {
  // 押し出しは形を計算してから確定する(文書だけ先に積まない)。同期で積む道は残さない。
  if (commit.tool === 'extrude') return confirmExtrudeCommit(commit) === 'adopted';
  if (commit.tool === 'cut') return confirmMachiningCommit(commit) === 'adopted';
  if (commit.tool === 'faceOffset' || commit.tool === 'holeTranslate' || commit.tool === 'faceRotate') return confirmMachiningCommit(commit) === 'adopted';
  // 計算担当が未接続なら従来の同期確定と後始末を使う。接続済みは成功した候補だけを採用する。
  if ((commit.tool === 'hole' || commit.tool === 'threadHole')
    && useAppStore.getState().partStager !== null) return confirmMachiningCommit(commit) === 'adopted';
  const store = useAppStore.getState();
  const base = mathCommitBase(commit);
  if (base === null) return false;
  // 加工6種(穴・ねじ穴・R面取り・C面取り・直線/円形パターン)の確定には部分形状の一覧が
  // 要る(solidCommands.ts タスク25b の4引数目)。
  const calculated = tryMathComposition(() => commitSolidInput(
    base,
    store.selection,
    commit,
    subShapeBodiesOf(store.bodies),
    // ばねの導出式(ピッチ × 巻数 = 全長)にパラメータ表の変数表を渡す(P4b タスク22b-(h))。
    // 渡さないと、ピッチに「板厚」と書いたとき全長の読み取り専用の欄が = 0 になる。
    store.parameterAnalysis.variables,
    store.parameterAnalysis,
    currentCutSketches(store),
  ));
  if (!calculated.ok) { store.setShapeError(calculated.message); return false; }
  const outcome = calculated.value;
  if (!outcome.ok) {
    store.setSolidError(outcome.reasonKey);
    // 断られたらポップアップを閉じない(理由は帯に出ている、P4 タスク33)。
    return false;
  }
  store.applyDocument(outcome.document);
  store.setActiveTool('select');
  store.setSelection([outcome.featureId], { kind: 'sketch', sketchId: store.sketch.id });
  return true;
}

/**
 * 押し出しの候補(純関数 `commitSolidInput` の結果)と入力の鍵。確かめる・確定するの両方が
 * これを通るので、同じ入力なら同じ候補(同じ id・同じ差し込み位置)になる。断りは帯へ出して null。
 */
function solidStageCandidateOf(commit: SolidInputCommit): ExtrudeStageCandidate | null {
  const store = useAppStore.getState();
  const current = store.document;
  const base = mathCommitBase(commit);
  if (base === null) return null;
  const calculated = tryMathComposition(() => commitSolidInput(
    base,
    store.selection,
    commit,
    subShapeBodiesOf(store.bodies),
    store.parameterAnalysis.variables,
    store.parameterAnalysis,
    currentCutSketches(store),
  ));
  if (!calculated.ok) { store.setShapeError(calculated.message); return null; }
  const outcome = calculated.value;
  if (!outcome.ok) {
    store.setSolidError(outcome.reasonKey);
    return null;
  }
  store.setSolidError(null);
  const inputKey = JSON.stringify([commit, store.selection],
    (_key: string, value: unknown): unknown => typeof value === 'bigint' ? value.toString() : value);
  return { base: current, document: outcome.document, featureId: outcome.featureId, inputKey };
}

/**
 * 押し出しを確定する(EX-14)。形の計算が成功したその文書と結果を 1 回で採用し、取り消しは
 * 1 段だけ積む。計算中なら 'pending' を返し、入力の窓は開いたまま(終わり次第採用して閉じる)。
 * 計算部が無い・断られた・失敗した・古くなったときは理由を帯へ出し、文書と取り消しは変えない。
 */
export function confirmExtrudeCommit(commit: SolidInputCommit): StagedConfirmation {
  const store = useAppStore.getState();
  if (store.partStager === null) {
    store.setSolidError('solidError.extrudeUnavailable');
    return 'refused';
  }
  const candidate = solidStageCandidateOf(commit);
  if (candidate === null) return 'refused';
  const confirmation = confirmExtrusion(candidate, () => { useAppStore.getState().closeNumericInput(); });
  if (confirmation === 'refused') {
    useAppStore.getState().setSolidError(stagedExtrusionMessageKey(useAppStore.getState(), true)
      ?? 'solidError.extrudeStale');
  }
  return confirmation;
}

/** 穴・ねじも成功した形だけを採用する。失敗・取消・別入力は既存の所有照合で捨てる。 */
function confirmMachiningCommit(commit: SolidInputCommit): StagedConfirmation {
  const store = useAppStore.getState();
  // Keep the cut's existing input refusals specific, including a retired formula snapshot.
  const cutCandidate = commit.tool === 'cut' ? solidStageCandidateOf(commit) : null;
  if (commit.tool === 'cut' && cutCandidate === null) return 'refused';
  if (store.partStager === null) {
    store.setSolidError('solidError.notYetAvailable');
    return 'refused';
  }
  const candidate = cutCandidate ?? solidStageCandidateOf(commit);
  if (candidate === null) return 'refused';
  const confirmation = confirmExtrusion(candidate, () => { useAppStore.getState().closeNumericInput(); });
  const failed = useAppStore.getState().stagedSolid;
  if (confirmation === 'refused' && failed?.status === 'failed' && failed.errors[0] !== undefined) {
    useAppStore.getState().setShapeError(failed.errors[0].message);
  }
  return confirmation;
}

/**
 * 「形を確かめる」(EX-14)。確定と同じ候補を段階計算に出し、成功した形を仮に表示する。
 * 文書・取り消しには触れない。欄に誤りがあれば確定と同じく最初の誤りへ焦点を戻す。
 */
export function previewExtrudeTransition(transition: NumericInputTransition): void {
  const store = useAppStore.getState();
  if (transition.kind === 'blocked') {
    store.updateNumericInput(transition.state);
    return;
  }
  if (transition.kind !== 'solidCommitted' || transition.commit.tool !== 'extrude') return;
  if (store.partStager === null) {
    store.setSolidError('solidError.extrudeUnavailable');
    return;
  }
  const candidate = solidStageCandidateOf(transition.commit);
  if (candidate !== null) stageExtrusion(candidate);
}

/**
 * 基準ジオメトリ(作業平面・基準軸・基準点・座標系)を部品文書へ積む(FR-328、FR-329)。
 *
 * 何を作るかは純関数 `commitReferenceInput` が決め、断られたら理由を帯へ出して履歴は
 * 変えない(FR-504、NFR-UX-5)。作業平面ができたら、そのまま作図面として選ぶ
 * (次の一手が続く、NFR-UX-1)。断りは `applyDocument` より**先に**出す
 * (`applyDocument` は古い断りを消すので、逆順にすると消える)。
 *
 * (P4b タスク18 で `AppShell.tsx` から移した。手順そのものは 1 行も変えていない。)
 */
export function applyReferenceCommit(commit: ReferenceInputCommit): boolean {
  const store = useAppStore.getState();
  const base = mathCommitBase([commit, store.referenceDraft]);
  if (base === null) return false;
  const calculated = tryMathComposition(() => commitReferenceInput(commit, {
    document: base,
    planeId: store.workPlaneId,
    bodies: subShapeBodiesOf(store.bodies),
    selection: store.selection,
    draft: store.referenceDraft,
  }));
  if (!calculated.ok) { store.setShapeError(calculated.message); return false; }
  const outcome = calculated.value;
  store.setReferenceError(outcome.rejection);
  if (outcome.document !== base) {
    store.applyDocument(outcome.document);
  }
  store.setReferenceDraft(outcome.draft);
  if (outcome.createdPlaneId !== null) {
    store.setWorkPlane(outcome.createdPlaneId);
  }
  // 断られたらポップアップを閉じない(P4 タスク33、タスク12 の申し送り)。
  return outcome.rejection === null;
}

/**
 * その場入力の 1 手(`applyNumericInputKey` が返した移り変わり)をストアへ反映する
 * (P4b タスク18)。
 *
 * **ここが唯一の入口**で、その場入力のポップアップ(`NumericInputPopover.tsx`)と
 * コマンドライン(`shell/CommandLine.tsx`)の両方がこれを呼ぶ。どちらから打っても
 * まったく同じ道筋を通る(NFR-UX-1、§0.a-0.9「どちらから打っても同じ確定処理」)。
 *
 * **断られたときはポップアップを閉じない**(P4 タスク33、タスク12 の申し送り)。
 * 半径が 2 点の間隔の半分に足りないときのように、値そのものは式として読めても形が
 * 作れないことがある。その場で閉じてしまうと、利用者は入れ直した値を全部打ち直す羽目に
 * なる。理由は帯に出ているので、欄はそのまま残して直させる(NFR-UX-5、NFR-UX-3)。
 */
export function applyNumericTransition(transition: NumericInputTransition): void {
  const store = useAppStore.getState();
  // 文字は字体待ちを含む専用の一括確定を通す。通常のpoint段から点を作らない。
  if (store.numericInput?.toolId === 'text' && transition.kind !== 'cancelled') return;
  switch (transition.kind) {
    case 'open':
      store.updateNumericInput(transition.state);
      return;
    case 'blocked':
      // 決定させず、最初に間違っている欄へ焦点を戻す(NFR-UX-5)。
      store.updateNumericInput(transition.state);
      return;
    case 'cancelled':
      store.closeNumericInput();
      // 押し出しの確かめていた形・計算中の確定も一緒にやめる(EX-14)。文書には触れない。
      cancelExtrusion();
      return;
    case 'solidCommitted':
      // 押し出しは形の計算が成功してから採用し、採用した時に窓を閉じる。計算中・断り・失敗の
      // 間は窓を開いたままにする(EX-14。confirmExtrudeCommit の注釈)。
      if (transition.commit.tool === 'extrude') {
        // コマンドラインは値を流し込んだ姿で確定する。計算中・失敗のときに窓に見える値と、
        // 計算している値を同じにするため、その姿を先に入力の窓へ残す(所有の判定は変わらない)。
        if (store.numericInput !== transition.state) store.updateNumericInput(transition.state);
        confirmExtrudeCommit(transition.commit);
        return;
      }
      if (transition.commit.tool === 'cut' || transition.commit.tool === 'faceOffset' || transition.commit.tool === 'holeTranslate' || transition.commit.tool === 'faceRotate'
        || ((transition.commit.tool === 'hole' || transition.commit.tool === 'threadHole') && store.partStager !== null)) {
        if (store.numericInput !== transition.state) store.updateNumericInput(transition.state);
        confirmMachiningCommit(transition.commit);
        return;
      }
      // ソリッドは(ばねの1段目を除き)1段で終わるので、決めたら必ず閉じる
      // (nextNumericInput も null を返す)。断られたときは閉じない。
      if (!applySolidCommit(transition.commit)) {
        return;
      }
      store.closeNumericInput();
      return;
    case 'referenceCommitted': {
      // 基準ジオメトリは 1 つ作ったら閉じる段と、次の点を聞く段がある(P4 タスク13)。
      // どちらかは nextNumericInput が決めるので、スケッチと同じ流れで扱う。
      if (!applyReferenceCommit(transition.commit)) {
        return;
      }
      openNext(transition.state);
      return;
    }
    case 'committed': {
      if (!applySketchCommit(transition.commit, transition.state)) {
        return;
      }
      openNext(transition.state);
      return;
    }
    case 'editCommitted':
      // 整形系(オフセット、FR-321)は対象を選び直さないと続けられないので、
      // ソリッドと同じく決めたら必ず閉じる(nextNumericInput も null を返す)。
      if (!applyEditCommit(transition.commit)) {
        return;
      }
      store.closeNumericInput();
      return;
  }
}

/** 決めた後に続けて聞くことがあれば開き直し、無ければ閉じる(FR-307)。 */
function openNext(state: NumericInputState): void {
  const store = useAppStore.getState();
  const next = nextNumericInput(state, store.chaining);
  if (next === null) {
    store.closeNumericInput();
    return;
  }
  store.updateNumericInput(next);
}

/**
 * 整形系の道具(オフセット FR-321、ミラー・複写・配列複写 FR-324)の確定をストアへ反映する。
 * 対象はすでに選ばれているので `commitSketchInput` は経由せず、`editCommands.ts` /
 * `copyCommands.ts` を直に呼ぶ。作れたら道具を選択へ戻し、作った複製を選んでおく
 * (続けてもう 1 つ重ねられる、NFR-UX-1。`Toolbar.tsx` の `commitBooleanAction` と同じ順序)。
 *
 * 断りは帯へ出すだけで、履歴も選択も変えない(NFR-UX-5、FR-504)。
 */
export function applyEditCommit(commit: EditInputCommit): boolean {
  const store = useAppStore.getState();
  const base = mathCommitBase(commit);
  if (base === null) return false;
  if (commit.tool === 'sketchFillet' || commit.tool === 'sketchChamfer') {
    return applyCornerCommit(commit, base);
  }
  const calculated = tryMathComposition(() => editCommitOutcome(commit, store));
  if (!calculated.ok) { store.setShapeError(calculated.message); return false; }
  const outcome = calculated.value;
  if (outcome === null) {
    return false;
  }
  if (!outcome.ok) {
    store.setEditError(outcome.reasonKey);
    // 断られたらポップアップを閉じない(理由は帯に出ている)。
    return false;
  }
  store.setEditError(null);
  store.applyDocument(replaceSketch(base, outcome.document));
  store.setActiveTool('select');
  store.setSelection([outcome.featureId], { kind: 'sketch', sketchId: store.sketch.id });
  return true;
}

/**
 * 投影・交差(FR-325、タスク27)の確定をストアへ反映する。
 *
 * 数値を 1 つも聞かないので段(その場入力)を通らず、**押した瞬間に決まる**
 * (`Toolbar.tsx` の `commitBooleanAction` と同じ「数値を聞かない道具」の作り)。
 * ここを通るのは 2 つの道で、どちらも同じ手順にそろえてある(NFR-UX-1)。
 *   ①道具を選んでからビューポートで面・辺・立体を押す(`attachSketchInteraction.ts`)。
 *   ②面・辺・立体を選んでから一覧の「投影」「断面」を押す(`Toolbar.tsx`)。
 *
 * 道具は選んだまま残す(続けて何枚でも取り込める。トリム・延長と同じ、§0.a-0.26)。
 * 断りは帯へ出すだけで履歴も選択も変えない(FR-504、NFR-UX-5)。**文書の差し替えは 1 回**
 * なので、複数まとめて取り込んでも取り消し(Ctrl+Z)は 1 回で戻る(NFR-UX-3)。
 */
export function applyProjectionCommit(
  tool: PickEditToolId,
  sources: readonly ProjectionSource[],
): boolean {
  const store = useAppStore.getState();
  if (sources.length === 0) {
    store.setEditError(projectionMissingTargetKey(tool));
    return false;
  }
  // 順序の制約(§0.a-0.11)は押した瞬間に見る。再計算まで待たせない(NFR-UX-5)。
  const rejection = projectionSourcesRejection(store.document, store.sketch.id, sources);
  if (rejection !== null) {
    store.setEditError(rejection);
    return false;
  }
  store.setEditError(null);
  store.setSketch(commitProjectionSources(store.sketch, store.workPlaneId, sources));
  return true;
}

/**
 * 角の丸め・面取り(FR-323、タスク23)の確定。
 *
 * 他の整形系と 2 つだけ違う。①**道具を選んだまま残す**(続けて別の角を指せる。
 * 利用者の決定「続けて別の角も。Esc で終了」)。②丸めた 2 本を境界に使っている面が
 * あったときは、新しい円弧・線分を境界へ組み込んだことを帯へ知らせる。
 * 面の参照と境界の更新も同じ文書の差し替えに含めるので、Undo は 1 回で済む。
 *
 * 案内は `setSketch` の**あと**に出す。`applyDocument` は文書が変わるたびに古い断り・
 * 案内を落とすので、先に出すと消えてしまう。
 */
function applyCornerCommit(commit: EditInputCommit, base: PartDocument): boolean {
  const store = useAppStore.getState();
  const outcome =
    commit.tool === 'sketchFillet'
      ? commitSketchFillet(store.sketch, store.selection, commit, cornerResolveOptions())
      : commitSketchChamfer(store.sketch, store.selection, commit, cornerResolveOptions());
  if (!outcome.ok) {
    // 断られたらポップアップを閉じない(理由は帯に出ている)。半径を入れ直せばそのまま試せる。
    store.setEditError(outcome.reasonKey);
    return false;
  }
  store.setEditError(null);
  store.applyDocument(replaceSketch(base, outcome.document));
  // 足した円弧・線分を選んでおく(次の一手がそのまま続く、NFR-UX-1)。道具は残す。
  store.setSelection([outcome.featureId], { kind: 'sketch', sketchId: store.sketch.id });
  if (outcome.boundaryUpdated) {
    store.setEditNotice('corner.notice.faceBoundary');
  }
  return true;
}

/**
 * 角を解くときの作図面の引き方。model の `filletCorner` は中で文書を解き直すので、
 * 任意の作業平面(FR-328)も引けるよう、いま解いてある面を渡す
 * (`attachSketchInteraction.ts` の `editResolveOptions` と同じ渡し方)。
 */
function cornerResolveOptions(): SketchResolveOptions {
  const store = useAppStore.getState();
  return {
    workPlane: (planeId) =>
      planeId === store.workPlaneId ? store.workPlane : baseWorkPlane(planeId),
  };
}

/** 道具ごとの確定の振り分け。段を持たない道具(トリム・延長)はここへ来ないので null。 */
function editCommitOutcome(
  commit: EditInputCommit,
  store: ReturnType<typeof useAppStore.getState>,
): OffsetCommitOutcome | CopyCommitOutcome | null {
  switch (commit.tool) {
    // 角の丸め・面取りは `applyCornerCommit` が先に受け取るのでここへは来ない。
    case 'sketchFillet':
    case 'sketchChamfer':
      return null;
    case 'offset':
      return commitOffset(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        store.selection,
        commit,
      );
    case 'mirror':
      return commitMirror(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        store.selection,
        commit,
      );
    case 'copy':
      return commitCopy(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        drawingPlane(),
        store.selection,
        commit,
      );
    case 'linearArray':
      return commitLinearArray(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        store.selection,
        commit,
      );
    case 'circularArray':
      return commitCircularArray(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        store.selection,
        commit,
      );
  }
}
