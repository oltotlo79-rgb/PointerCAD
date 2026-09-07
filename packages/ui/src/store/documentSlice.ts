/**
 * 文書操作の共通入口と部品文書のスライス(document、つまみ、作図面、パラメータ)。
 * Undo / Redo はいまの文書種別で分岐し、部品の編集と明示的な文書切替をここで受ける。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import type { ImportedMeshBytes } from '@pointercad/io';
import {
  affectsShape,
  createUndoStack,
  findSketch,
  type ParameterAnalysis,
  type PartDocument,
  pruneDocumentAppearance,
  pushUndo,
  redo as redoStep,
  replaceSketch,
  type ResolvedReferences,
  setActiveSketch as activateSketch,
  type SketchDocument,
  type SketchRecomputeResult,
  undo as undoStep,
  type UndoStack,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import { placeNewFeatures } from '../shell/timelineMove.js';
import { EMPTY_REFERENCE_DRAFT } from '../sketch/referenceCommands.js';
import { EMPTY_SHAPE_DRAFT } from '../sketch/shapeCommands.js';
import type { OrbitState } from '../viewport/cameraMath.js';
import type { CanvasPixelSize } from '../viewport/canvasLayer.js';
import type { AppState, DocumentStateUpdate } from './appState.js';
import { activeDocumentKind } from './documentKind.js';
import {
  constraintSummaryPatch,
  documentPatch,
  NO_CONSTRAINT_SUMMARIES,
  NO_CONSTRAINT_TARGETS,
  referencePatch,
  timelineNoticeFor,
  workPlaneForOrbit,
  workPlaneOfSketch,
} from './documentDerived.js';

/** 文書を差し替えるときの添え物(§0.a-0.4、§0.a-0.13)。 */
export interface ApplyDocumentOptions {
  /**
   * 同じ鍵の変更が続いたら Undo の 1 段にまとめる(§0.a-0.13)。
   * 鍵があるときは「打っている途中」とみなし、計算中の札も立てない
   * (立てるとプロパティ欄で 1 文字打つたびに札が点滅する)。
   */
  readonly coalesceKey?: string;
  /**
   * Undo に段を積むか。既定は積む(true)。計算結果の反映のように
   * 利用者の操作ではない差し替えでは false にする。
   */
  readonly undoable?: boolean;
  /**
   * 文書をまるごと差し替える呼び出しか(ファイルを開く等)。既定は false(いまの編集の続き)。
   * true のときだけ `documentVersion` を進める(§0.a-0.1〜、docs/報告記録.md 2026-09-04
   * 14:05 の 9b)。プロパティ欄の打ちかけの下書き(`FieldDraft` 等)は、選択している
   * フィーチャーの id が変わらないまま文書だけが差し替わると `key` での作り直しが起きず
   * 古い下書きが残ってしまうため、この数の変化を見て下書きを捨てる。
   */
  readonly replacesDocument?: boolean;
}

/** 文書・履歴・つまみのスライスが持つ欄と操作。 */
export interface DocumentSlice {
  readonly documentName: string;
  readonly featureNames: readonly string[];
  /** 再計算(解決とカーネル)の最中か。計算中の札を出すのに使う。 */
  readonly isComputing: boolean;
  /**
   * 幾何カーネル(約 50MB)をまだ一度も読み込んでいないか(P3 §0.a-0.23 ⑨)。
   * 初回の再計算だけ帯と札に「形の計算部を読み込んでいます…」と出し、
   * 2 回目以降は「形を計算しています…」に戻す(実測で初回は 3〜7 秒かかる)。
   * 部品を作り直しても幾何カーネル自体は積み直さないので、`resetDocument` では戻さない。
   */
  readonly kernelLoaded: boolean;
  /** 再計算そのものが投げた失敗。ステータスバーがそのまま見せる(FR-504)。 */
  readonly errorMessage: string | null;
  /** 作図面(要件§4.3、§0.a-0.3)。既定は XY。任意の作業平面はその id(FR-328)。 */
  readonly workPlaneId: WorkPlaneId;
  /**
   * `workPlaneId` を実際の面(原点・2 軸・法線)まで解いた控え(FR-328、タスク13)。
   * 基準の 3 面は決め打ちで引けるが、任意の作業平面は部品文書を見ないと決まらないので、
   * **文書か作図面が変わるたびにここで 1 度だけ解いて**、ビューポート・当たり判定・
   * その場入力が同じ 1 つを読む(同じ計算を各所でやり直さない)。
   */
  readonly workPlane: WorkPlane;
  /**
   * 3D スケッチ(FR-330、タスク14)で最後に押した場所の面。押した場所を世界座標へ直した
   * 面(`freeSketch.ts` の `freeClickPlane`。直前の点を通り画面に正対する面)をそのまま
   * 覚えておき、**その続きで決まる円弧の向き**(`freeOrientation`)に使う。作図面が無い
   * スケッチだけの一時的な控えなので、道具や作図面を変えたら捨てる。まだ一度も押して
   * いなければ null。
   */
  readonly freeSketchPlane: WorkPlane | null;
  /**
   * 基準ジオメトリ(作業平面・基準軸・基準点・座標系)を解いた控え(FR-328、FR-329)。
   * 3D 表示と一覧が読む。文書から導けるので保存しない(rules/04)。
   */
  readonly resolvedReferences: ResolvedReferences;
  /**
   * パラメータ表(名前を付けた数値)を解いた控え(FR-207、P4b タスク11)。文書から
   * 導けるので保存しない(`resolvedReferences` と同じ扱い、rules/04-設計の規律.md)。
   *
   * **`variables`(変数表)は式を受け付ける 3 つの入口が共通で読む**。プロパティの欄
   * (`PropertyPanel.tsx`)・その場入力(`NumericInputPopover.tsx`)・コマンドラインの欄
   * (`shell/commandLineActions.ts`)のどれか 1 つにだけ渡すと、同じ式が打つ場所によって
   * 通ったり通らなかったりする(タスク18 の申し送り)。ここを唯一の出どころにする。
   */
  readonly parameterAnalysis: ParameterAnalysis;
  /**
   * 長さでないパラメータ(角度・無次元)の名前(P6 タスク3b、§0.a-0.63)。
   *
   * 表示が inch のとき、式は inch の空間で評価される(`(w+10)in`)。そのとき**長さの
   * パラメータだけ**を倍率で割る必要があり、個数や角度まで割ると `n+10`(n = 5 個)が
   * 意味の無い値になる。`parameterAnalysis.variables` と同じく**式を受け付ける 3 つの
   * 入口が共通で読む唯一の出どころ**にする(片方だけに渡すと打つ場所で値が変わる)。
   *
   * 文書から導けるので保存しない(`parameterAnalysis` と同じ扱い、rules/04)。
   */
  readonly nonLengthVariables: ReadonlySet<string>;
  /**
   * 部品文書。**これが唯一の正本**で、`.pcad` に保存されるのもこれだけ(要件§8、§0.a-0.4)。
   * 差し替える口は `applyDocument` の 1 つだけにし、下の控えはそこで作り直す。
   */
  readonly document: PartDocument;
  /**
   * 文書がまるごと差し替わった回数(開く・新規・復元・Undo/Redo)。プロパティ欄の
   * 打ちかけの下書きを、この数の変化で捨てる判定に使う(`shell/fieldDraft.ts`、
   * docs/報告記録.md 2026-09-04 14:05 の 9b)。プロパティ欄の 1 文字ずつの編集
   * (`coalesceKey` を伴う `applyDocument`)では増えない。
   */
  readonly documentVersion: number;
  /** Undo / Redo の履歴(FR-505)。`present` は常に `document` と同じものを指す。 */
  readonly undoStack: UndoStack<PartDocument>;
  /** 戻せる段・進める段があるか。ツールバーのボタンの入り切りに使う(FR-505)。 */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** 再計算が投げた失敗を出す・消す。計算中の印はここで下ろす。 */
  readonly setError: (message: string | null) => void;
  /**
   * 幾何カーネルを読み込み終えたと記録する(P3 §0.a-0.23 ⑨)。
   * `applyRecompute` は購読通知の中で `set` を入れ子にしないため、この口を呼ばずに
   * 自分の `set` へ `kernelLoaded: true` を直接含める。ここは単体で呼びたいとき用に残す。
   */
  readonly markKernelLoaded: () => void;
  readonly setWorkPlane: (id: WorkPlaneId) => void;
  /** 今の視点に最も近い作図面へ移してほしい、とビューポートへ頼む(§0.a-0.3)。 */
  readonly requestMatchWorkPlaneToView: () => void;
  /** 今の視点に最も近い作図面へ移る(§0.a-0.3 の「視点に合わせる」)。 */
  readonly matchWorkPlaneToView: (orbit: OrbitState) => void;
  /**
   * 部品文書を差し替える(§0.a-0.4)。**文書を差し替えるのはこの口だけ**で、
   * 派生の控えの同期と Undo の積み方をここ 1 箇所で決める。
   */
  readonly applyDocument: (next: PartDocument, options?: ApplyDocumentOptions) => void;
  /** 編集中のスケッチを切り替える。形は変わらないので Undo の段は作らない。 */
  readonly setActiveSketch: (sketchId: string) => void;
  /** 履歴を差し替える。計算中の印を立てるだけで、解決はしない。 */
  readonly setSketch: (sketch: SketchDocument) => void;
  /** スケッチ 1 本ぶんの再計算の結果を反映する(P1 からの口。呼び出し側は変えない)。 */
  readonly applySketch: (sketch: SketchDocument, result: SketchRecomputeResult) => void;
  /** 1 段戻す・1 段進める(FR-505)。戻せる段が無ければ何も起きない。 */
  readonly undo: () => void;
  readonly redo: () => void;
  /** 3D スケッチで押した場所の面を覚える・捨てる(FR-330、タスク14)。 */
  readonly setFreeSketchPlane: (plane: WorkPlane | null) => void;
  /**
   * 部品文書を新しくやり直す(FR-806 の「新規」)。`applyDocument` と違い
   * **履歴のスタックを作り直す**ので、新規の前へは戻れない。取りかけの操作・選択・
   * 断りの理由も持ち越さない(NFR-UX-3)。
   */
  readonly resetDocument: (next: PartDocument) => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(文書・履歴・つまみ)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type DocumentInitialState = Pick<
  DocumentSlice,
  | 'documentName'
  | 'featureNames'
  | 'isComputing'
  | 'errorMessage'
  | 'workPlaneId'
  | 'workPlane'
  | 'freeSketchPlane'
  | 'resolvedReferences'
  | 'parameterAnalysis'
  | 'nonLengthVariables'
  | 'document'
  | 'documentVersion'
  | 'undoStack'
  | 'canUndo'
  | 'canRedo'
>;

export const createDocumentSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<DocumentSlice, keyof DocumentInitialState>
> = (set, get) => ({
  // 幾何カーネルは部品を作り直しても積み直さないので、文書まわりの初期値には含めない
  // (createInitialDocumentState は resetDocument の後には呼ばれない、§0.a-0.23 ⑨)。
  kernelLoaded: false,
  setError: (errorMessage) => {
    set({ errorMessage, isComputing: false, recomputeProgress: null });
  },
  markKernelLoaded: () => {
    set({ kernelLoaded: true });
  },
  setWorkPlane: (workPlaneId) => {
    // 作図面が変われば、解いた面(`workPlane`)も引き直す(FR-328、タスク13)。
    // 3D スケッチで押した場所の面(タスク14)は作図面が変われば意味を失うので捨てる。
    set((state) => ({
      workPlaneId,
      freeSketchPlane: null,
      ...referencePatch(state.document, workPlaneId),
    }));
  },
  requestMatchWorkPlaneToView: () => {
    set((state) => ({ matchWorkPlaneRequestCount: state.matchWorkPlaneRequestCount + 1 }));
  },
  matchWorkPlaneToView: (orbit) => {
    set((state) => {
      const workPlaneId = workPlaneForOrbit(orbit);
      return { workPlaneId, ...referencePatch(state.document, workPlaneId) };
    });
  },
  applyDocument: (incoming, options) => {
    // アセンブリ中の部品編集は行わない。開く等の明示的な文書切替だけを受ける。
    if (activeDocumentKind(get()) === 'assembly' && options?.replacesDocument !== true) return;
    const update: DocumentStateUpdate = (state) => {
      if (incoming === state.document) {
        return {};
      }
      /*
       * タイムラインのつまみ(FR-507、タスク19・20)の面倒を見る。
       *
       * ①文書をまるごと差し替えたとき(開く)は、つまみを末尾へ戻す。前の部品のつまみを
       *   持ち越さないため(§0.a-0.19「開いた直後は常に末尾」)。
       * ②途中まで戻したまま履歴が伸びたときは、**つまみの位置へ差し込む**(タスク20)。
       *   末尾へ積んだままだと戻した画面に作ったものが出てこないので、差し込んだうえで
       *   つまみをその段へ進めて見せる。止めて断ることはしない
       *   (rules/04-設計の規律.md「操作をブロックするゲートも作らない」)。
       * ③それ以外(名前の変更・削除・順序の入れ替え)は、つまみをそのままにする。
       *
       * 差し込みは `placeNewFeatures` が行い、差し込んだ後の文書を以降でそのまま使う
       * (Undo に積むのも保存されるのも差し込んだ後の並び)。
       */
      const placement =
        options?.replacesDocument === true
          ? { document: incoming, timelineIndex: null, inserted: false }
          : placeNewFeatures(state.document, incoming, state.timelineIndex);
      /*
       * フィーチャーが消えたときは、そのボディを指す外観の割り当ても一緒に落とす
       * (FR-1106、model の `pruneDocumentAppearance`)。押し出しを消したのに色の割り当て
       * だけが文書に残ると、保存したファイルに行き先の無い割り当てが溜まっていく。
       *
       * **履歴が短くなったときだけ掃除する。** 掃除の判定材料は「いま画面に出るボディ」
       * なので、抑制(一時的に外す)やブーリアンで消費された立体もそのままでは対象に
       * 入ってしまう。どちらも元へ戻せる操作で、そこで割り当てを捨てると戻したときに
       * 色が失われる。消えたことが確かなとき(段の数が減ったとき)だけに限る。
       * 文書を丸ごと差し替える経路(新規・開く・復元)も対象外にする(読み込んだ文書の
       * 割り当てを、まだ計算していない段階で削らない)。
       *
       * 掃除は取り消しに積む前に行うので、**取り消し 1 回で立体も色も一緒に戻る**
       * (NFR-UX-3)。
       */
      const placed = placement.document;
      const next =
        options?.replacesDocument !== true && placed.solids.length < state.document.solids.length
          ? pruneDocumentAppearance(placed)
          : placed;
      const coalesceKey = options?.coalesceKey;
      const stack =
        options?.undoable === false
          ? // 段は増やさないが、present は常に document と同じものにしておく。
            { ...state.undoStack, present: next }
          : pushUndo(state.undoStack, next, { coalesceKey });
      return {
        // 丸ごとの差し替え(開く・復元)では 3D スケッチも降ろす(タスク22b-(i))。
        ...documentPatch(state, next, stack, options?.replacesDocument === true),
        // 文書をまるごと差し替える呼び出し(開く等)のときだけ進める(§0.a-0.1〜)。
        documentVersion:
          options?.replacesDocument === true ? state.documentVersion + 1 : state.documentVersion,
        timelineIndex: placement.timelineIndex,
        // 知らせは「差し込みました」か、つまみの初回の案内(タスク22b-(a))か、無しの 3 通り。
        timelineNoticeKey: timelineNoticeFor(state, next, placement.inserted),
        // 順序の入れ替えの断りは、形が変われば用済み(FR-504)。
        timelineRefusal: null,
        // 束ねる変更(プロパティ欄の 1 文字ごと)では計算中の札を立てない。立てると
        // 打つたびに札が点滅する。再計算は attachPartRecompute が拾い、終わり次第
        // そのまま形が動く(NFR-PF-1)。
        //
        // **形に影響しない変更(外観の割り当てだけ、FR-1106〜1110)でも立てない**
        // (P5 §2.3.2)。下の `attachPartRecompute` の購読も `affectsShape` を見て
        // 再計算を投げないので、ここで立てると誰も下ろせない札が残る。要件§4.12の
        // 「外観を変えても再計算は起きず、描画だけが変わる」はこの 2 か所で守られる。
        isComputing:
          coalesceKey === undefined && affectsShape(state.document, next)
            ? true
            : state.isComputing,
        // 形が変わったら「保存しました」等の知らせは用済み(FR-806)。
        fileMessage: null,
        // 中止の知らせも、次の計算が始まる時点で用済み(NFR-PF-4)。
        recomputeCancelled: false,
        // 古い「面/立体/図形を作れませんでした」の断りも文書が変われば用済み(§0.a-0.23 ⑦)。
        faceErrorKey: null,
        solidErrorKey: null,
        editErrorKey: null,
        appearanceErrorKey: null,
        // 「測れませんでした」の断りも、文書が変われば用済み(FR-1102、タスク32)。
        measureErrorKey: null,
        editNoticeKey: null,
        shapeErrorMessage: null,
        referenceErrorMessage: null,
        // 拘束の断りも文書が変われば用済み(FR-504、タスク13)。
        constraintErrorMessage: null,
        // 引っぱれなかった理由も、形が変われば用済み(タスク14)。
        dragRefusalKey: null,
        // 原点を移した知らせも、次に形が変われば用済み(FR-331、タスク35b)。
        // 原点の再設定そのものは applyDocument のあとで setOriginNotice を呼んで立て直す。
        originNoticeMessage: null,
        // トリム・延長の予告は「いまの形」の上の区間なので、形が変われば描き直し
        // (次にマウスが動いたときに出し直す。タスク22)。
        editPreview: null,
        // 測定は**形が変わったときだけ**消す(FR-1102「モデルを変更するまで残る」、
        // §0.a-0.29。外観だけの変更では形が 1 ミリも動かないので測った値は正しいまま)。
        measurement: affectsShape(state.document, next) ? null : state.measurement,
        // 質量特性も測定と同じ条件で消す(体積・重心は形そのものの値なので、
        // 形が変われば測り直し。外観だけの変更では材料が変わっても残る)。
        massProperties: affectsShape(state.document, next) ? null : state.massProperties,
      };
    };
    if (options?.replacesDocument === true) get().resetAssembly(update);
    else set(update);
    /*
      つまみの初回の案内を出したら、二度と出さないよう端末に覚える(P4b タスク22b-(a)、
      利用者の決定①)。`set` の中は副作用を持たない純粋な差分にしたいので、
      `localStorage` への書き込みはここで 1 回だけ行う。
    */
    const after = get();
    if (after.timelineNoticeKey === 'timeline.hint' && !after.displaySettings.timelineHintSeen) {
      after.setDisplaySettings({ ...after.displaySettings, timelineHintSeen: true });
    }
  },
  setActiveSketch: (sketchId) => {
    const state = get();
    if (state.document.activeSketchId === sketchId) {
      // すでにそれを編集している。文書を作り直すと再計算まで走ってしまう(NFR-PF-1)。
      return;
    }
    const next = activateSketch(state.document, sketchId);
    if (next === state.document) {
      // 実在しない id。何も変えない(model の setActiveSketch と同じ扱い)。
      return;
    }
    // 切り替えた先のスケッチが使っていた作図面へ、札とビューポートを合わせる
    // (P4 仕上げ (g))。まだ何も置いていないスケッチは面が決まらないので今のままにする。
    // `applyDocument` より先に立てるのは、その中の `documentPatch` が新しい作図面で
    // 基準ジオメトリを解き直せるようにするため。
    const planeId = workPlaneOfSketch(findSketch(next, sketchId));
    if (planeId !== null && planeId !== state.workPlaneId) {
      // 3D スケッチで押した場所の面(タスク14)は作図面が変われば意味を失うので捨てる。
      set({ workPlaneId: planeId, freeSketchPlane: null, ...referencePatch(next, planeId) });
    }
    // 編集する対象を変えるだけで形は変わらないので、Undo の段は作らない(§0.a-0.13)。
    state.applyDocument(next, { undoable: false });
  },
  setSketch: (sketch) => {
    // 解決はここではしない。attachPartRecompute が非同期に行い applyRecompute で戻す。
    const state = get();
    state.applyDocument(replaceSketch(state.document, sketch));
  },
  applySketch: (sketch, result) => {
    set((state) => {
      const next = replaceSketch(state.document, sketch);
      return {
        // 計算結果の反映は利用者の操作ではないので Undo の段を作らない。
        ...documentPatch(state, next, { ...state.undoStack, present: next }),
        resolvedSketch: result.resolved,
        sketchMesh: result.mesh,
        sketchErrors: result.errors,
        // 拘束の診断(FR-313、タスク13)。拘束が無ければ model が null を返す。
        constraintDiagnosis: result.diagnosis,
        ...constraintSummaryPatch(sketch, result.resolved, result.diagnosis),
        // 確定した形が届いたので、引っぱっている間の仮の形は用済み(タスク14)。
        dragResolved: null,
        isComputing: false,
        recomputeProgress: null,
      };
    });
  },
  undo: () => {
    if (activeDocumentKind(get()) === 'assembly') {
      get().undoAssembly();
      return;
    }
    set((state) => {
      const stack = undoStep(state.undoStack);
      if (stack === state.undoStack) {
        return {};
      }
      return {
        ...documentPatch(state, stack.present, stack),
        // 時をまたぐ差し替えなので、プロパティ欄の打ちかけの下書きは捨てる(§0.a-0.1〜)。
        documentVersion: state.documentVersion + 1,
        // 外観だけの取り消し(FR-1110、FR-505)では再計算が投げられないので札も立てない
        // (立てると下ろす者がいない。上の applyDocument と同じ理由、P5 §2.3.2)。
        isComputing: affectsShape(state.document, stack.present) ? true : state.isComputing,
        fileMessage: null,
        recomputeCancelled: false,
        // 「原点を移しました」は取り消した後には嘘になるので落とす(FR-331、タスク35b)。
        originNoticeMessage: null,
        // 測定も、形が戻ったのなら測り直し(FR-1102。外観だけの取り消しでは残す)。
        measurement: affectsShape(state.document, stack.present) ? null : state.measurement,
        massProperties: affectsShape(state.document, stack.present) ? null : state.massProperties,
        // つまみは末尾へ戻す(FR-507、タスク19)。取り消し・やり直しで履歴の件数が
        // 変わりうるので、同じ通し番号が前と同じ段を指すとは限らない。
        timelineIndex: null,
        timelineNoticeKey: null,
        // 順序の入れ替えの断りも、時をまたぐ差し替えの後には合わないので落とす(FR-504)。
        timelineRefusal: null,
      };
    });
  },
  redo: () => {
    if (activeDocumentKind(get()) === 'assembly') {
      get().redoAssembly();
      return;
    }
    set((state) => {
      const stack = redoStep(state.undoStack);
      if (stack === state.undoStack) {
        return {};
      }
      return {
        ...documentPatch(state, stack.present, stack),
        documentVersion: state.documentVersion + 1,
        // 取り消し(`undo`)と同じ理由で、形に影響しない差し替えでは札を立てない。
        isComputing: affectsShape(state.document, stack.present) ? true : state.isComputing,
        fileMessage: null,
        recomputeCancelled: false,
        // やり直しでも同じ(取り消しの `undo` と揃える。FR-331、タスク35b)。
        originNoticeMessage: null,
        measurement: affectsShape(state.document, stack.present) ? null : state.measurement,
        massProperties: affectsShape(state.document, stack.present) ? null : state.massProperties,
        timelineIndex: null,
        timelineNoticeKey: null,
        // 順序の入れ替えの断りも、時をまたぐ差し替えの後には合わないので落とす(FR-504)。
        timelineRefusal: null,
      };
    });
  },
  setFreeSketchPlane: (freeSketchPlane) => {
    set({ freeSketchPlane });
  },
  resetDocument: (next) => {
    if (activeDocumentKind(get()) === 'assembly') get().fileGateway.clearSaveTarget?.();
    get().resetAssembly((state) => ({
      // 新規・復元は丸ごとの差し替え(タスク22b-(i))。3D スケッチのままなら XY へ戻す。
      ...documentPatch(state, next, createUndoStack(next), true),
      // 新規・復元も文書の丸ごとの差し替え(§0.a-0.1〜)。
      documentVersion: state.documentVersion + 1,
      // 新しい部品のつまみは常に末尾から(§0.a-0.19、FR-507)。
      timelineIndex: null,
      timelineNoticeKey: null,
      timelineRefusal: null,
      isComputing: true,
      // 新しい部品に、前の部品の取りかけ・選択・断りの理由を持ち越さない(NFR-UX-3)。
      activeTool: 'select',
      selectionKind: 'body',
      selection: [],
      hoveredElementId: null,
      numericInput: null,
      numericInputAnchor: null,
      pendingStart: null,
      shapeDraft: EMPTY_SHAPE_DRAFT,
      shapeErrorMessage: null,
      referenceDraft: EMPTY_REFERENCE_DRAFT,
      referenceErrorMessage: null,
      freeSketchPlane: null,
      // 断面表示も持ち越さない(FR-111、P6 タスク35)。切る面の指定が前の部品の面を
      // 指したままになり、新しい部品では解けない面で切ろうとすることになるため。
      sectionView: null,
      // 点検の結果も持ち越さない(FR-815、P6 タスク42・43・46)。三角形の並びは形ごとに
      // 変わるので、前の部品の結果を新しい部品の三角形に当てると別の場所が色づく。
      printability: null,
      printabilityOffsets: null,
      /*
        下絵も持ち越さない(FR-332、P6 タスク39)。画像の鍵(`imageId`)は文書ごとに
        `canvas-1` から振り直されるので、前の部品の画像が新しい部品の別物の同じ鍵に
        当たってしまう(rules/06 10.17 と同じ形の取り違え)。
        **開いた部品の画像は、この後に `setCanvasImages` で入れ直す**(順序が逆だと消える)。
      */
      canvases: new Map<string, Uint8Array>(),
      canvasPixelSizes: new Map<string, CanvasPixelSize>(),
      /*
        読み込んだ形も持ち越さない(FR-802、P6 タスク32)。理由は下絵とまったく同じで、
        参照(`shapeRef` / `meshRef`)は文書ごとにフィーチャーの id から振り直されるため、
        前の部品の形が新しい部品の別物の同じ参照に当たってしまう(rules/06 10.17)。
        **開いた部品の形は、この後に `setImportedAttachments` で入れ直す**(順序が逆だと消える)。
      */
      importedShapes: new Map<string, Uint8Array>(),
      importedMeshes: new Map<string, ImportedMeshBytes>(),
      canvasScale: null,
      canvasMessage: null,
      snapIndicator: null,
      trackIndicator: null,
      inferredConstraints: null,
      editPreview: null,
      // 拘束まわりの一時状態も持ち越さない(FR-313、タスク13)。診断は次の計算で入り直す。
      constraintDiagnosis: null,
      constraintSummaries: NO_CONSTRAINT_SUMMARIES,
      activeConstraintKind: null,
      constraintTargets: NO_CONSTRAINT_TARGETS,
      constraintErrorMessage: null,
      constraintPrompt: null,
      selectedConstraintId: null,
      // 引っぱりの途中で新しい部品に切り替わっても、掴んだ点を持ち越さない(タスク14)。
      sketchDrag: null,
      dragResolved: null,
      dragRefusalKey: null,
      faceErrorKey: null,
      solidErrorKey: null,
      editErrorKey: null,
      appearanceErrorKey: null,
      editNoticeKey: null,
      originNoticeMessage: null,
      // 前の部品で測った値は、別の部品には当てはまらない(FR-1102、タスク31・32)。
      measurement: null,
      massProperties: null,
      measureErrorKey: null,
      errorMessage: null,
      fileMessage: null,
      recomputeCancelled: false,
      /*
        新しい部品を作ったら、開いていたアセンブリは閉じる(P7 §0.a-0.10、タスク5)。
        1 つの窓で開く文書は 1 つだけなので、ここを残したままにすると
        `activeDocumentKind` がアセンブリのままになり、作ったばかりの部品が画面に出ない。
      */
      assembly: null,
    }));
  },
});
