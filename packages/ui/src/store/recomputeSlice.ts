/**
 * 再計算の結果のスライス(立体・失敗・進み具合・中止。要件§6.3、NFR-PF-4)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import type {
  AppearanceMatchEntry,
  PartDocument,
  PartProgress,
  PartRecomputeError,
  PartRecomputeResult,
  SolidBody,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { AppState } from './appState.js';
import { activeSketchErrors, activeSketchOf, constraintSummaryPatch } from './documentDerived.js';

/** 検査口からも読める、最後に完了した再計算の結末。 */
export type RecomputeOutcome =
  | 'idle'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'workerBroken';

/** 再計算のスライスが持つ欄と操作。 */
export interface RecomputeSlice {
  /** ソリッドのボディ(§0.a-0.5)。カーネルが返した三角形と稜線。 */
  readonly bodies: readonly SolidBody[];
  /**
   * 外観を割り当てた面が、いまの形のどの面に当たるか(FR-1106、P5 §2.2.3、タスク10)。
   *
   * 再計算のたびにカーネルが指紋で選び直した結果がそのまま入る。`faceIndex` が `null` の
   * ものは選び直せなかった割り当てで、その面は既定の外観で描き、警告を出す(タスク11・12)。
   * **割り当て自体は文書から消さない。**
   */
  readonly appearanceMatches: readonly AppearanceMatchEntry[];
  /** 部品の再計算で集めた失敗。スケッチ側もソリッド側も並ぶ(FR-504)。 */
  readonly partErrors: readonly PartRecomputeError[];
  /** 作り直さずに済んだ段の数(NFR-PF-3 の効き目)。 */
  readonly cacheHits: number;
  /** 計算の進み具合(NFR-PF-4)。計算していなければ null。 */
  readonly recomputeProgress: PartProgress | null;
  /**
   * 中止を頼んだ回数(NFR-PF-4)。`attachPartRecompute` は計算を始めるときの値を覚え、
   * それより増えていたら段と段の間で打ち切る。数で持つのは、止めたい計算が
   * 走っていないときに押されても次の計算へ引きずらないため(§0.a-0.22)。
   */
  readonly cancelRequestCount: number;
  /**
   * 直前の計算が中止で終わったか(NFR-PF-4)。中止は失敗ではないので `errorMessage` へは
   * 入れず、帯も赤くしない。次に文書が変わるか、次の計算が終われば消える
   * (時間で自動的に消さないのは、いつ消えるかを検査で決められるようにするため)。
   */
  readonly recomputeCancelled: boolean;
  /** `attachPartRecompute` が最後に開始を依頼した世代。起動前は 0。 */
  readonly requestedGeneration: number;
  /** 成功・失敗・取消・Worker 破損のいずれかで最後に完了した世代。起動前は 0。 */
  readonly completedGeneration: number;
  /** `completedGeneration` の結末。まだ 1 度も完了していなければ `idle`。 */
  readonly lastOutcome: RecomputeOutcome;
  /** 部品まるごとの再計算の結果を反映する(要件§6.3)。 */
  readonly applyRecompute: (document: PartDocument, result: PartRecomputeResult) => void;
  /** 計算の進み具合を出す・消す(NFR-PF-4)。 */
  readonly setRecomputeProgress: (progress: PartProgress | null) => void;
  /** 計算を止めるよう頼む(NFR-PF-4)。段と段の間でしか止まらない(§2.6 の限界)。 */
  readonly cancelRecompute: () => void;
  /** 再計算を開始した世代を記録する(E2E の検査口、P7 タスク52)。 */
  readonly recordRecomputeRequest: (generation: number) => void;
  /** 再計算が終わった世代と結末を対で記録する(E2E の検査口、P7 タスク52)。 */
  readonly recordRecomputeCompletion: (
    generation: number,
    outcome: Exclude<RecomputeOutcome, 'idle'>,
  ) => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(再計算)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type RecomputeInitialState = Pick<
  RecomputeSlice,
  | 'bodies'
  | 'appearanceMatches'
  | 'partErrors'
  | 'cacheHits'
  | 'recomputeProgress'
  | 'cancelRequestCount'
  | 'recomputeCancelled'
>;

export const createRecomputeSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<RecomputeSlice, keyof RecomputeInitialState>
> = (set) => ({
  // 文書を作り直しても世代を巻き戻さないため、createInitialDocumentState には含めない。
  requestedGeneration: 0,
  completedGeneration: 0,
  lastOutcome: 'idle',
  applyRecompute: (document, result) => {
    set((state) => {
      const sketch = activeSketchOf(document);
      const active = result.sketches.find((entry) => entry.sketchId === sketch.id);
      return {
        resolvedSketch: active === undefined ? state.resolvedSketch : active.resolved,
        sketchMesh: active === undefined ? state.sketchMesh : active.mesh,
        sketchErrors:
          active === undefined
            ? state.sketchErrors
            : activeSketchErrors(sketch, active, result.errors),
        // 拘束の診断(FR-313、タスク13)。いま編集しているスケッチのぶんだけを控える。
        constraintDiagnosis: active === undefined ? state.constraintDiagnosis : active.diagnosis,
        ...(active === undefined
          ? { constraintSummaries: state.constraintSummaries }
          : constraintSummaryPatch(sketch, active.resolved, active.diagnosis)),
        // 確定した形が届いたので、引っぱっている間の仮の形は用済み(タスク14)。
        dragResolved: active === undefined ? state.dragResolved : null,
        // 途中で打ち切られた結果は「作れたところまで」でしかないので、前のボディを
        // 半分だけの形へ置き換えない(NFR-PF-4、§2.6 の限界)。
        bodies: result.cancelled ? state.bodies : result.bodies,
        // 外観の面の照合(FR-1106)はボディと対で意味を持つので、ボディを差し替えたときだけ
        // 一緒に差し替える(打ち切られた結果の照合は「作れたところまで」でしかない)。
        appearanceMatches: result.cancelled
          ? state.appearanceMatches
          : (result.appearanceMatches ?? []),
        partErrors: result.errors,
        cacheHits: result.cacheHits,
        documentName: sketch.name,
        featureNames: sketch.features.map((feature) => feature.name),
        isComputing: false,
        recomputeProgress: null,
        // 中止で終わったことは帯で短く知らせる。最後まで走ったならその知らせは消す。
        recomputeCancelled: result.cancelled,
        // 幾何カーネルを積んで少なくとも 1 回計算が終わった(§0.a-0.23 ⑨)。
        // 購読通知(subscribe)の中で set を入れ子にしないよう、ここへ直接含める。
        kernelLoaded: true,
      };
    });
  },
  setRecomputeProgress: (recomputeProgress) => {
    set({ recomputeProgress });
  },
  cancelRecompute: () => {
    set((state) => ({ cancelRequestCount: state.cancelRequestCount + 1 }));
  },
  recordRecomputeRequest: (requestedGeneration) => {
    set({ requestedGeneration });
  },
  recordRecomputeCompletion: (completedGeneration, lastOutcome) => {
    set({ completedGeneration, lastOutcome });
  },
});
