/**
 * 拘束(FR-313)と引っぱりのスライス。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import type {
  ConstraintDiagnosis,
  ConstraintTarget,
  ResolvedSketch,
  SketchConstraintKind,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { MessageKey } from '../i18n/t.js';
import type { ConstraintValuePrompt } from '../sketch/constraintPicking.js';
import type { ConstraintSummary } from '../sketch/constraintSummary.js';
import type { SketchDrag } from '../viewport/dragSketch.js';
import type { AppState } from './appState.js';
import { NO_CONSTRAINT_TARGETS } from './documentDerived.js';

/** 拘束と引っぱりのスライスが持つ欄と操作。 */
export interface ConstraintSlice {
  /**
   * いま編集しているスケッチの拘束の診断(FR-313、P4b タスク13)。
   *
   * 中身は model が解いた結果(`PartSketchResult.diagnosis` / `SketchRecomputeResult.diagnosis`)
   * をそのまま写したもので、**拘束が 1 つも無いスケッチと 3D スケッチでは null**
   * (model が解く計算そのものを省くため)。帯の「あと N か所決まっていません」、
   * 一覧の状態、印の色がここ 1 つを見る(同じ計算を各所でやり直さない)。
   *
   * 文書から導ける控えなので保存しない(rules/04-設計の規律.md)。
   */
  readonly constraintDiagnosis: ConstraintDiagnosis | null;
  /**
   * 拘束の一覧の行(FR-313、P4b タスク13)。プロパティの一覧・3D の印・印の当たり判定が
   * **同じ 1 つ**を見る(描画・当たり判定・選択の 3 つをそろえる、P4 タスク12 の失敗の
   * 再発防止)。文書と解決結果から導ける控えなので保存しない(rules/04-設計の規律.md)。
   *
   * 拘束が 1 つも無ければ空の並びを使い回す(解決を歩き直さない、NFR-PF-1)。
   */
  readonly constraintSummaries: readonly ConstraintSummary[];
  /**
   * いま選んでいる拘束の道具(FR-313、P4b タスク13)。選んでいなければ null。
   *
   * 拘束の道具は**トリム・延長と同じ流儀**(道具を選んでから要素を順に押す。統括の決定
   * 2026-09-05)なので、`activeTool` とは別に持つ。`activeTool` は `'select'` のままで、
   * ビューポートの押下だけがこちらを先に見る(`attachSketchInteraction.ts`)。
   */
  readonly activeConstraintKind: SketchConstraintKind | null;
  /**
   * 拘束の道具で押した相手(FR-313)。必要な数がそろうと拘束が付いて空へ戻る。
   * 同じところをもう一度押すと外れる(`toggleConstraintTarget`)。
   */
  readonly constraintTargets: readonly ConstraintTarget[];
  /**
   * 拘束を付けられなかった理由(FR-504、NFR-UX-5)。`shapeErrorMessage` と同じ扱いで、
   * ステータスバーが「拘束を付けられませんでした:」の言い回しで出す。model の日本語を
   * そのまま持つので文言キーではなく文で持つ。
   */
  readonly constraintErrorMessage: string | null;
  /**
   * 寸法拘束(距離・角度・半径・直径)の値を聞いているところ(NFR-UX-2)。開いていなければ null。
   * 既定値は「いま測った値」(NFR-UX-4)。
   */
  readonly constraintPrompt: ConstraintValuePrompt | null;
  /**
   * 一覧で選んでいる拘束の id(FR-313)。3D の印を大きく出す。選んでいなければ null。
   * 印を押すとここへ入り(当たり判定)、一覧の行を押しても同じところへ入る。
   */
  readonly selectedConstraintId: string | null;
  /**
   * いま引っぱっている点(FR-313、P4b タスク14)。引っぱっていなければ null。
   *
   * **表示だけの一時状態**で、文書は 1 か所も変わらない(`pointermove` のたびに文書を
   * 作り直すと取り消しの段が増える)。文書へ書き戻すのは離した 1 回だけ。
   */
  readonly sketchDrag: SketchDrag | null;
  /**
   * 引っぱっている最中の形(FR-313、P4b タスク14)。引っぱっていなければ null。
   *
   * `resolvedSketch`(文書どおりの形)はそのままにして、**描くときだけこちらを優先する**
   * (`ViewportCanvas.tsx`)。当たり判定・プロパティ・吸着は文書どおりの形を読み続けるので、
   * 引っぱっている間に狙いがずれない。離した後は次の再計算(`applySketch` /
   * `applyRecompute`)が落とすので、確定した形へ切り替わるまで画面がちらつかない。
   */
  readonly dragResolved: ResolvedSketch | null;
  /**
   * 引っぱれなかった理由(FR-313、NFR-UX-5)。押した瞬間に帯へ出す。引っぱれたら null。
   */
  readonly dragRefusalKey: MessageKey | null;
  /**
   * 拘束の道具を選ぶ・やめる(FR-313、P4b タスク13)。`null` でやめる。
   * 道具を選ぶと、取りかけの入力・選択・押した相手は持ち越さない(NFR-UX-3)。
   */
  readonly setConstraintTool: (kind: SketchConstraintKind | null) => void;
  /** 拘束の道具で押した相手を置き換える(タスク13)。 */
  readonly setConstraintTargets: (targets: readonly ConstraintTarget[]) => void;
  /** 拘束を付けられなかった理由を出す・消す(NFR-UX-5)。 */
  readonly setConstraintError: (message: string | null) => void;
  /** 寸法拘束の値を聞くところを開く・閉じる(NFR-UX-2)。 */
  readonly setConstraintPrompt: (prompt: ConstraintValuePrompt | null) => void;
  /** 一覧・印で選んでいる拘束を差し替える(FR-313)。 */
  readonly setSelectedConstraint: (constraintId: string | null) => void;
  /**
   * 引っぱりを始める(FR-313、P4b タスク14)。掴んだ点を覚えるだけで、文書は変えない。
   * 前の断りはここで消える(押し直したら理由も出し直す)。
   */
  readonly beginSketchDrag: (drag: SketchDrag) => void;
  /** 引っぱっている最中の形を差し替える(表示だけ。1 コマに 1 回呼ぶ)。 */
  readonly setDragResolved: (resolved: ResolvedSketch) => void;
  /**
   * 引っぱりを終える。`keepShape` が真なら、離した形を**次の再計算まで**残す
   * (確定した文書の計算が終わるまでの間に元の形へ戻ってちらつくのを防ぐ)。
   * Esc・掴み損ねのときは偽にして、その場で元の形へ戻す。
   */
  readonly endSketchDrag: (keepShape: boolean) => void;
  /** 引っぱれない理由を出す・消す(NFR-UX-5)。 */
  readonly setDragRefusal: (key: MessageKey | null) => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(拘束と引っぱり)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type ConstraintInitialState = Pick<
  ConstraintSlice,
  | 'constraintDiagnosis'
  | 'constraintSummaries'
  | 'activeConstraintKind'
  | 'constraintTargets'
  | 'constraintErrorMessage'
  | 'constraintPrompt'
  | 'selectedConstraintId'
  | 'sketchDrag'
  | 'dragResolved'
  | 'dragRefusalKey'
>;

export const createConstraintSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<ConstraintSlice, keyof ConstraintInitialState>
> = (set, get) => ({
  setConstraintTool: (kind) => {
    const state = get();
    // 取りかけの入力・下書き・案内線の後始末は `setActiveTool` に任せ、規則を 2 か所に書かない。
    // 拘束の道具はビューポートを押して相手を決めるので、下地の道具は選択にしておく。
    state.setActiveTool('select');
    set({
      activeConstraintKind: kind,
      constraintTargets: NO_CONSTRAINT_TARGETS,
      constraintErrorMessage: null,
      constraintPrompt: null,
      // 前の道具で選んでいたものを拘束の相手に紛れ込ませない(NFR-UX-3)。
      selection: [],
    });
  },
  setConstraintTargets: (constraintTargets) => {
    set({ constraintTargets });
  },
  setConstraintError: (constraintErrorMessage) => {
    set({ constraintErrorMessage });
  },
  setConstraintPrompt: (constraintPrompt) => {
    set({ constraintPrompt });
  },
  setSelectedConstraint: (selectedConstraintId) => {
    set({ selectedConstraintId });
  },
  beginSketchDrag: (sketchDrag) => {
    // まだ 1 度も動かしていないので形はそのまま(押しただけで形が動かないように)。
    set({ sketchDrag, dragResolved: null, dragRefusalKey: null });
  },
  setDragResolved: (dragResolved) => {
    set({ dragResolved });
  },
  endSketchDrag: (keepShape) => {
    set((state) => ({
      sketchDrag: null,
      dragResolved: keepShape ? state.dragResolved : null,
    }));
  },
  setDragRefusal: (dragRefusalKey) => {
    set({ dragRefusalKey });
  },
});
