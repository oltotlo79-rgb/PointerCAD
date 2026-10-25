/**
 * 押し出しの確定前の計算(段階計算)を、入力ごとに頼む口(EX-14 の核)。
 *
 * 候補の文書は純関数(`commitSolidInput` など)が作り、ここはそれを計算の順番の持ち主
 * (`attachPartRecompute` が差し出す `PartStager`)へ渡すだけにする。形の計算・採用の判定は
 * ストア側(`attachKernel.ts`・`recomputeSlice.ts`)の 1 か所にあり、ここでは繰り返さない。
 *
 * - 同じ入力(`inputKey`)・同じ文書なら計算をやり直さない(再描画のたびに作り直さない)。
 * - 確定は、成功したその入力の計算をそのまま採用する。計算中なら終わり次第採用し、
 *   入力・対象・文書が変われば採用しない(先に反映して戻すことはしない)。
 * - 仮の形の表示は `viewport/solidMeshAdmission.ts` の段階計算の枝、入力の窓からの
 *   「形を確かめる」「確定」は `sketch/commitToStore.ts` がここを呼ぶ。
 */
import type { PartDocument } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import {
  currentStagedSolid,
  type StagedConfirmation,
  type StagedSolidFailure,
  type StagedSolidState,
} from '../store/recomputeSlice.js';
import { useAppStore } from '../store/useAppStore.js';

/** 押し出しの候補。`document` は `base` から純関数で作り、末尾へ積んだ形のもの。 */
export interface ExtrudeStageCandidate {
  /** 候補を作った元の文書(いまの文書と同じ実体でなければ断る)。 */
  readonly base: PartDocument;
  readonly document: PartDocument;
  /** 最後に作られる立体(結合・切り取りではブーリアンの段)。確定後に選ぶ。 */
  readonly featureId: string;
  /**
   * 入力の意味の鍵(距離・向き・作り方・相手の立体など、入力欄が決める値)。
   * 同じ鍵・同じ文書なら同じ候補になる(候補を作る関数は純関数)。
   */
  readonly inputKey: string;
}

/** 候補を段階計算に出す。計算部が無い・部品を開いていない・古い候補なら null。 */
export function stageExtrusion(candidate: ExtrudeStageCandidate): StagedSolidState | null {
  const stager = useAppStore.getState().partStager;
  if (stager === null) return null;
  return stager.stage({ base: candidate.base, candidate: candidate.document,
    finalFeatureId: candidate.featureId, fingerprint: candidate.inputKey });
}

/**
 * その入力の段階計算を確定する。計算中なら 'pending' を返し、成功し次第採用する。
 * 採用したら道具を選択へ戻して作った立体を選ぶ(`applySolidCommit` と同じ順番。
 * 道具を先に戻さないと、選ぶ種類の変化で選択が空になる)。`onAdopted` はその後に呼ぶ。
 */
export function confirmExtrusion(
  candidate: ExtrudeStageCandidate,
  onAdopted?: (adopted: StagedSolidState) => void,
): StagedConfirmation {
  const staged = stageExtrusion(candidate);
  const stager = useAppStore.getState().partStager;
  if (staged === null || stager === null) return 'refused';
  return stager.confirm(staged.ownership.inputRevision, (adopted) => {
    const store = useAppStore.getState();
    store.setActiveTool('select');
    store.setSelection([adopted.finalFeatureId], { kind: 'sketch', sketchId: store.sketch.id });
    onAdopted?.(adopted);
  });
}

/** 段階計算をやめる(Escape・道具を閉じる)。確定済みの文書には触れない。 */
export function cancelExtrusion(): void {
  useAppStore.getState().partStager?.cancel();
}

/** いまの段階計算のうち、その入力の鍵のもの。所有が変わった古い計算は返さない。 */
export function stagedExtrusionFor(state: ReturnType<typeof useAppStore.getState>, inputKey: string): StagedSolidState | null {
  const staged = currentStagedSolid(state);
  return staged !== null && staged.fingerprint === inputKey ? staged : null;
}

/** 採用できなかった理由ごとの、利用者が次にすることを含む文言(i18n の solid.json)。 */
const FAILURE_MESSAGE_KEYS: Readonly<Record<StagedSolidFailure, MessageKey>> = {
  failed: 'solidError.extrudeFailed',
  workerBroken: 'solidError.extrudeWorkerBroken',
  thrown: 'solidError.extrudeWorkerBroken',
  incomplete: 'solidError.extrudeUnverified',
  missingBody: 'solidError.extrudeMissingBody',
  invalidBody: 'solidError.extrudeUnverified',
  accounting: 'solidError.extrudeUnverified',
};

/**
 * 入力の窓に出す段階計算の知らせ。計算中・表示中・失敗の理由と、確定を頼んだ後に入力・対象・
 * 文書が変わって使えなくなったこと。`refused` は確定を断られた直後の呼び出し(今の計算が
 * 無ければ「変わった」と知らせる)。知らせることが無ければ null。
 */
export function stagedExtrusionMessageKey(state: ReturnType<typeof useAppStore.getState>, refused = false): MessageKey | null {
  const current = currentStagedSolid(state);
  if (current === null) {
    const latest = state.stagedSolid;
    return refused || (latest !== null && latest.confirmRequested) ? 'solidError.extrudeStale' : null;
  }
  if (current.status === 'failed') {
    return current.failure === null ? 'solidError.extrudeFailed' : FAILURE_MESSAGE_KEYS[current.failure];
  }
  // 失敗していない計算で確定を断られたのは、採用の直前に所有が変わったとき。
  if (refused) return 'solidError.extrudeStale';
  if (current.status === 'pending') {
    return current.confirmRequested ? 'numericInput.extrudeConfirming' : 'numericInput.extrudePreviewComputing';
  }
  return 'numericInput.extrudePreviewReady';
}
