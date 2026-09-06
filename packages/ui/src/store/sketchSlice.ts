/**
 * スケッチのスライス(道具・派生の控え・下書き・指標・断りの理由)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import {
  type CoordinateInput,
  removeFeature,
  replaceFeature,
  replaceSketch,
  type ResolvedSketch,
  type SketchDocument,
  type SketchError,
  type SketchFeature,
  type SketchMesh,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { MessageKey } from '../i18n/t.js';
import { commitRemoveConstraints, constraintsReferencing } from '../sketch/constraintCommands.js';
import type { InferredConstraintPreview } from '../sketch/inferredConstraints.js';
import type { NumericInputState, NumericInputToolId } from '../sketch/numericInput.js';
import { EMPTY_REFERENCE_DRAFT, type ReferenceDraft } from '../sketch/referenceCommands.js';
import { EMPTY_SHAPE_DRAFT, type ShapeDraft } from '../sketch/shapeCommands.js';
import type { SnapKind } from '../sketch/snapMath.js';
import type { TrackCandidate } from '../sketch/trackMath.js';
import type { EditPreview } from '../sketch/trimPreview.js';
import { keepsSelectionKind, selectionKindForTool } from '../solid/subShapeSelection.js';
import type { AppState } from './appState.js';
import { filterSelectionForFaceTool, NO_CONSTRAINT_TARGETS } from './documentDerived.js';

/** いま吸い付いている場所。印を出すのに使う(FR-107)。 */
export interface SnapIndicator {
  /** ビューポートの左上を原点とした画面座標(画素)。 */
  readonly screen: readonly [number, number];
  readonly kind: SnapKind;
  /** 吸い付いた先の要素。方眼の交点は要素を持たないので null。 */
  readonly elementId: string | null;
}

/** スケッチのスライスが持つ欄と操作。 */
export interface SketchSlice {
  /**
   * 選んでいる道具(FR-301〜309、FR-401〜403、FR-405〜408、FR-411、FR-412)。スケッチの道具に
   * 加えて、数値を聞くソリッドの道具(押し出し・回転・縫合)と、P3 の加工の道具(穴・ねじ穴・
   * R 面取り・C 面取り・直線/円形パターン)も入る。和・差・積は押した瞬間に作って
   * 終わるので、道具として選ばれた状態にはならない(§0.a-0.6)。
   *
   * タスク24 が加工6種+ばねを `NumericInputToolId`(`numericInput.ts` の `SolidToolId`)へ
   * 足したので、型はこれ1本(以前の一時型 `P3SolidToolId` はタスク26 で消した)。
   */
  readonly activeTool: NumericInputToolId;
  /**
   * 派生の控え(§0.a-0.4)。`document.sketches` のうち `activeSketchId` のもの。
   * 正本は `document` の 1 つだけで、ここは `applyDocument` が同期する。**直接 set しない。**
   * P1 からの読み手(`shell` / `viewport` / `sketch` の 13 ファイル)をそのまま生かすために残す。
   */
  readonly sketch: SketchDocument;
  /** 解決済みの幾何。履歴から導ける実行時の控え(保存しない)。 */
  readonly resolvedSketch: ResolvedSketch;
  /** 面の三角形。カーネルが返したもの。面が無ければ null。 */
  readonly sketchMesh: SketchMesh | null;
  /** いま編集しているスケッチの失敗(FR-504)。部品全体の失敗は `partErrors`。 */
  readonly sketchErrors: readonly SketchError[];
  /** スナップの入り切りと、有効な種別(FR-107、§0.a-0.10)。 */
  readonly snapEnabled: boolean;
  readonly snapKinds: readonly SnapKind[];
  /** 連続描画(FR-307)。 */
  readonly chaining: boolean;
  /** その場数値入力の状態。開いていなければ null(NFR-UX-2)。 */
  readonly numericInput: NumericInputState | null;
  /** ポップアップを出す画面座標。 */
  readonly numericInputAnchor: readonly [number, number] | null;
  /** 線分の始点・円弧の中心・点列の基準として先に決めた座標。まだ無ければ null。 */
  readonly pendingStart: CoordinateInput | null;
  /**
   * P4 の新しい図形(矩形・長穴・楕円・スプライン等)の途中経過(FR-314〜318、タスク12)。
   * 置いた点と前の段の欄の値を積む。道具を変える・ポップアップを閉じると空へ戻る。
   */
  readonly shapeDraft: ShapeDraft;
  /**
   * 図形を作れなかった理由(FR-314〜318、NFR-UX-5)。`faceErrorKey` / `solidErrorKey` と
   * 同じ扱いだが、限界値(点の数・半径)を差し込んだ文になるので文言キーではなく文で持つ
   * (`numericInput.ts` の `describeRange` と同じ事情)。ステータスバーが
   * 「図形を作れませんでした:」の言い回しで出す。
   */
  readonly shapeErrorMessage: string | null;
  /**
   * 基準ジオメトリ(作業平面・基準軸・基準点・座標系)の途中経過(FR-328、FR-329、タスク13)。
   * 置いた点とこれまでの段で選んだ決め方を積む。道具を変える・ポップアップを閉じると空へ戻る。
   */
  readonly referenceDraft: ReferenceDraft;
  /**
   * 基準ジオメトリを作れなかった理由(FR-328、FR-329、NFR-UX-5)。`shapeErrorMessage` と
   * 同じ扱いで、ステータスバーが「基準ジオメトリを作れませんでした:」の言い回しで出す。
   */
  readonly referenceErrorMessage: string | null;
  /** いま吸い付いている場所。無ければ null(FR-107)。 */
  readonly snapIndicator: SnapIndicator | null;
  /**
   * いま出している向きの吸着の案内線(FR-110、P4b タスク16)。無ければ null。
   *
   * ビューポートが細い破線で画面いっぱいに引き、ステータスバーが「15° に合わせています」
   * 「線分1 の延長線」の一言を組み立てる材料にする。同時に出すのは最大 2 本(§0.14)。
   * `snapIndicator` と同じく、作るのは React の外(`attachSketchInteraction.ts`)なので
   * ここに置く(rules/04-設計の規律.md「フロントの状態は Zustand 1 本」)。
   */
  readonly trackIndicator: readonly TrackCandidate[] | null;
  /**
   * 線を引いている最中に推定した拘束の予告(FR-333、P6 タスク41)。無ければ null。
   *
   * **形にも保存にも影響しない一時状態**で、`.pcad` には書かない(`affectsShape` を
   * 通らない)。線を引き終えた瞬間に `commitToStore.ts` がこれを読んで拘束を足し、
   * すぐ null へ戻す。`snapIndicator` / `trackIndicator` と同じく、作るのは React の外
   * (`attachSketchInteraction.ts`)なのでここに置く(rules/04「フロントの状態は
   * Zustand 1 本」)。
   */
  readonly inferredConstraints: InferredConstraintPreview | null;
  /**
   * トリム・延長の道具でマウスを乗せているときの予告(FR-322、タスク22)。
   * 消える区間・伸びる区間の折れ線で、ビューポートがもとの線の上へ重ねて描く。
   *
   * ホバーと同じ「表示だけの一時状態」だが、作るのは React の外
   * (`attachSketchInteraction.ts`)なので、`snapIndicator` と同じくストアに置く
   * (rules/04-設計の規律.md「フロントの状態は Zustand 1 本」)。
   */
  readonly editPreview: EditPreview | null;
  /**
   * 面を張れなかった理由の文言キー(FR-309、NFR-UX-5)。履歴には何も積まれていないので
   * `sketchErrors` には出てこない。計算そのものの失敗(`errorMessage`)とは別に持ち、
   * ステータスバーが「面を作れませんでした:」の言い回しで出す。
   */
  readonly faceErrorKey: MessageKey | null;
  /**
   * 立体を作れなかった理由の文言キー(FR-401〜404、NFR-UX-5)。`faceErrorKey` と同じ扱いで、
   * 履歴には何も積まれていないので `partErrors` には出てこない。ステータスバーが
   * 「立体を作れませんでした:」の言い回しで出す。
   */
  readonly solidErrorKey: MessageKey | null;
  /**
   * 整形系の道具(オフセット、FR-321、タスク21)を作れなかった理由の文言キー。
   * `faceErrorKey` / `solidErrorKey` と同じ扱いで、ステータスバーが
   * 「オフセットを作れませんでした:」の言い回しで出す。
   */
  readonly editErrorKey: MessageKey | null;
  /**
   * 整形系の道具が**成功したときに添える案内**の文言キー(FR-323、タスク23)。
   *
   * 断り(`editErrorKey`)と分けてあるのは、赤い帯で「できませんでした」と出すのが
   * 事実に反するため。いまの使い道は 1 つで、角を丸めた 2 本を境界に使っている面が
   * あったときに「面の境界に足した曲線を入れ直してください」と伝える(t18 の申し送り)。
   * 文書が変われば用済みなので `applyDocument` が落とす。
   */
  readonly editNoticeKey: MessageKey | null;
  /**
   * 原点を移したときに帯へ出す一言(FR-331、P4 タスク35b)。
   *
   * `editNoticeKey` と同じ「うまくいったときの知らせ」だが、もとの原点の座標の**式**を
   * 差し込んだ文になるので、文言キーではなく組み立て済みの文で持つ
   * (`shapeErrorMessage` と同じ事情)。文書が変われば用済みなので `applyDocument` が落とす。
   */
  readonly originNoticeMessage: string | null;
  /**
   * 最後にビューポートで何かを選んだ場所(canvas の左上を原点とした画素)。
   * ソリッドの道具のその場入力を、選んだものの近くへ出すのに使う(NFR-UX-2)。
   * まだ何も選んでいなければ null で、そのときはビューポートの中央に出す。
   */
  readonly pickAnchor: readonly [number, number] | null;
  readonly setActiveTool: (tool: NumericInputToolId) => void;
  /**
   * 履歴の 1 つを差し替える(FR-311)。式を直したときに 1 文字ごとに呼ばれる。
   * 下流は再計算で追従し、壊れたものは `sketchErrors` に出る(FR-504)。
   */
  readonly replaceSketchFeature: (featureId: string, feature: SketchFeature) => void;
  /**
   * 履歴の 1 つを取り除く。参照していた要素が壊れても止めず、理由を出すだけにする
   * (FR-504、NFR-RE-1)。消えたものは選択とホバーからも外れる。
   */
  readonly removeSketchFeature: (featureId: string) => void;
  readonly setSnapEnabled: (enabled: boolean) => void;
  readonly toggleSnapKind: (kind: SnapKind) => void;
  readonly setChaining: (chaining: boolean) => void;
  readonly openNumericInput: (
    state: NumericInputState,
    anchor: readonly [number, number],
  ) => void;
  readonly updateNumericInput: (state: NumericInputState) => void;
  readonly closeNumericInput: () => void;
  readonly setPendingStart: (start: CoordinateInput | null) => void;
  /** 新しい図形の途中経過を置き換える(タスク12)。 */
  readonly setShapeDraft: (draft: ShapeDraft) => void;
  /** 図形を作れなかった理由を出す・消す(NFR-UX-5)。 */
  readonly setShapeError: (message: string | null) => void;
  /** 基準ジオメトリの途中経過を置き換える(タスク13)。 */
  readonly setReferenceDraft: (draft: ReferenceDraft) => void;
  /** 基準ジオメトリを作れなかった理由を出す・消す(NFR-UX-5)。 */
  readonly setReferenceError: (message: string | null) => void;
  readonly setSnapIndicator: (indicator: SnapIndicator | null) => void;
  /** 向きの吸着の案内線を出す・消す(FR-110、タスク16)。 */
  readonly setTrackIndicator: (lines: readonly TrackCandidate[] | null) => void;
  /** 推定した拘束の予告を出す・消す(FR-333、P6 タスク41)。 */
  readonly setInferredConstraints: (preview: InferredConstraintPreview | null) => void;
  /** トリム・延長の予告を出す・消す(FR-322、タスク22)。 */
  readonly setEditPreview: (preview: EditPreview | null) => void;
  /** 面を張れなかった理由を出す・消す。 */
  readonly setFaceError: (key: MessageKey | null) => void;
  /** 立体を作れなかった理由を出す・消す(FR-401〜404)。 */
  readonly setSolidError: (key: MessageKey | null) => void;
  /** 整形系の道具(オフセット等)を作れなかった理由を出す・消す(FR-321、NFR-UX-5)。 */
  readonly setEditError: (key: MessageKey | null) => void;
  /** 整形系の道具が成功したときの案内を出す・消す(FR-323、タスク23)。 */
  readonly setEditNotice: (key: MessageKey | null) => void;
  /** 原点を移したときの一言を出す・消す(FR-331、タスク35b)。 */
  readonly setOriginNotice: (message: string | null) => void;
  /** ビューポートで選んだ場所を覚える・忘れる。 */
  readonly setPickAnchor: (anchor: readonly [number, number] | null) => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(スケッチ)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type SketchInitialState = Pick<
  SketchSlice,
  | 'activeTool'
  | 'sketch'
  | 'resolvedSketch'
  | 'sketchMesh'
  | 'sketchErrors'
  | 'snapEnabled'
  | 'snapKinds'
  | 'chaining'
  | 'numericInput'
  | 'numericInputAnchor'
  | 'pendingStart'
  | 'shapeDraft'
  | 'shapeErrorMessage'
  | 'referenceDraft'
  | 'referenceErrorMessage'
  | 'snapIndicator'
  | 'trackIndicator'
  | 'inferredConstraints'
  | 'editPreview'
  | 'faceErrorKey'
  | 'solidErrorKey'
  | 'editErrorKey'
  | 'editNoticeKey'
  | 'originNoticeMessage'
  | 'pickAnchor'
>;

export const createSketchSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<SketchSlice, keyof SketchInitialState>
> = (set, get) => ({
  setActiveTool: (activeTool) => {
    // 道具を変えたら入力中のポップアップを閉じ、取りかけの始点と吸着の印も落とす
    // (取りかけの操作を持ち越さない、NFR-UX-3)。選ぶ部分形状の種類(§0.a-0.6)も
    // 道具に応じて自動で切り替える(selectionKindForTool は subShapeSelection.ts の
    // 1 か所だけに置き、ここで対応表を作り直さない)。
    set((state) => {
      /*
        いま選んでいるものをそのまま材料にする道具(面をつなぐ・ロフト。§2.15 の「測る」と
        同じ扱い)では種類を切り替えない。切り替えると下の `kindChanged` が真になり、押した
        瞬間に材料の選択が消えてしまう(`keepsSelectionKind` の注釈、2026-09-05 の実測)。
      */
      const selectionKind = keepsSelectionKind(activeTool)
        ? state.selectionKind
        : selectionKindForTool(activeTool);
      const kindChanged = selectionKind !== state.selectionKind;
      return {
        activeTool,
        selectionKind,
        numericInput: null,
        numericInputAnchor: null,
        pendingStart: null,
        // 新しい図形の取りかけ(置いた点・前の段の値)も持ち越さない(タスク12)。
        shapeDraft: EMPTY_SHAPE_DRAFT,
        shapeErrorMessage: null,
        // 基準ジオメトリの取りかけ(置いた点・選んだ決め方)も持ち越さない(タスク13)。
        referenceDraft: EMPTY_REFERENCE_DRAFT,
        referenceErrorMessage: null,
        // 3D スケッチで押した場所の面も持ち越さない(タスク14)。
        freeSketchPlane: null,
        snapIndicator: null,
        // 案内線も持ち越さない(道具が変われば向きを合わせる相手も変わる、FR-110)。
        trackIndicator: null,
        // 推定した拘束の予告も持ち越さない(線の道具をやめたら予告する相手がいない、FR-333)。
        inferredConstraints: null,
        // 拘束の道具も持ち越さない(別の道具を押したらやめる、NFR-UX-3。P4b タスク13)。
        activeConstraintKind: null,
        constraintTargets: NO_CONSTRAINT_TARGETS,
        constraintErrorMessage: null,
        constraintPrompt: null,
        editPreview: null,
        faceErrorKey: null,
        solidErrorKey: null,
        editErrorKey: null,
        appearanceErrorKey: null,
        editNoticeKey: null,
        originNoticeMessage: null,
        // 種類が変わったら、違う種類の選択が加工の対象に紛れ込まないよう選択を空にする
        // (§0.a-0.6)。種類が変わらないときだけ、面の道具の掃除(§0.a-0.23 ⑨)を従来どおり行う。
        selection: kindChanged
          ? []
          : activeTool === 'face'
            ? filterSelectionForFaceTool(state.sketch, state.selection)
            : state.selection,
      };
    });
  },
  replaceSketchFeature: (featureId, feature) => {
    const state = get();
    // 同じ要素への続けざまの書き換え(プロパティ欄の 1 文字ごと)は Undo の 1 段に
    // まとめる(§0.a-0.13)。まとめないと Ctrl+Z が 1 文字ずつ戻る。
    state.applyDocument(
      replaceSketch(state.document, replaceFeature(state.sketch, featureId, feature)),
      { coalesceKey: `sketchFeature:${featureId}` },
    );
  },
  removeSketchFeature: (featureId) => {
    const state = get();
    /*
     * 要素を消したら、それを指している拘束も一緒に消す(FR-313、P4b タスク13)。
     *
     * 残しておくと「指している要素がありません」の拘束が一覧に溜まり、診断の
     * `dangling` として毎回数えられる。取り消し(Ctrl+Z)は文書ごと 1 段で戻るので、
     * 要素と拘束が同じ 1 回の取り消しで戻る(NFR-UX-3)。
     */
    const withoutFeature = removeFeature(state.sketch, featureId);
    const orphaned = constraintsReferencing(withoutFeature, featureId);
    const outcome =
      orphaned.length === 0 ? null : commitRemoveConstraints(withoutFeature, orphaned);
    const nextSketch = outcome !== null && outcome.ok ? outcome.document : withoutFeature;
    state.applyDocument(replaceSketch(state.document, nextSketch));
  },
  setSnapEnabled: (snapEnabled) => {
    set({ snapEnabled });
  },
  toggleSnapKind: (kind) => {
    set((state) => ({
      snapKinds: state.snapKinds.includes(kind)
        ? state.snapKinds.filter((enabled) => enabled !== kind)
        : [...state.snapKinds, kind],
    }));
  },
  setChaining: (chaining) => {
    set({ chaining });
  },
  openNumericInput: (numericInput, numericInputAnchor) => {
    set({ numericInput, numericInputAnchor });
  },
  updateNumericInput: (numericInput) => {
    /*
      欄を打ち直したら、推定した拘束の予告(FR-333、P6 タスク41)を捨てる。

      **予告はポインタが指している終点から作る**ので、そのあと利用者が欄へ別の座標を
      打ち込むと、予告した拘束(「水平」など)が打ち込んだ線に当てはまらなくなる。
      間違った線に拘束を付けるくらいなら付けないほうがよい。ポインタで置き直せば
      次の `pointermove` で予告は入り直す。

      **ポインタで置く道は `openNumericInput`(欄を開き直す)を通る**ので、こちらは
      通らない——押した場所を欄へ入れる `openInputAt` は開き直す側だから、
      「クリックで置く → Enter で確定」の道筋では予告はそのまま残る。
    */
    set({ numericInput, inferredConstraints: null });
  },
  closeNumericInput: () => {
    // 取りかけの図形(置いた点・前の段の値)も一緒に捨てる。ポップアップが閉じたあとに
    // 別の道具で置いた点と混ざらないようにするため(NFR-UX-3、タスク12)。
    set({
      numericInput: null,
      numericInputAnchor: null,
      shapeDraft: EMPTY_SHAPE_DRAFT,
      referenceDraft: EMPTY_REFERENCE_DRAFT,
    });
  },
  setPendingStart: (pendingStart) => {
    set({ pendingStart });
  },
  setShapeDraft: (shapeDraft) => {
    set({ shapeDraft });
  },
  setShapeError: (shapeErrorMessage) => {
    set({ shapeErrorMessage });
  },
  setReferenceDraft: (referenceDraft) => {
    set({ referenceDraft });
  },
  setReferenceError: (referenceErrorMessage) => {
    set({ referenceErrorMessage });
  },
  setSnapIndicator: (snapIndicator) => {
    set({ snapIndicator });
  },
  setTrackIndicator: (trackIndicator) => {
    set({ trackIndicator });
  },
  setInferredConstraints: (inferredConstraints) => {
    set({ inferredConstraints });
  },
  setEditPreview: (editPreview) => {
    set({ editPreview });
  },
  setFaceError: (faceErrorKey) => {
    set({ faceErrorKey });
  },
  setSolidError: (solidErrorKey) => {
    set({ solidErrorKey });
  },
  setEditError: (editErrorKey) => {
    set({ editErrorKey });
  },
  setEditNotice: (editNoticeKey) => {
    set({ editNoticeKey });
  },
  setOriginNotice: (originNoticeMessage) => {
    set({ originNoticeMessage });
  },
  setPickAnchor: (pickAnchor) => {
    set({ pickAnchor });
  },
});
