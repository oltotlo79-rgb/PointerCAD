import type { AutoSaver } from '@pointercad/io';
import {
  affectsShape,
  analyzeParameters,
  canRedo as stackCanRedo,
  baseWorkPlane,
  canUndo as stackCanUndo,
  collectExpressionSources,
  createEmptyPartDocument,
  createUndoStack,
  DEFAULT_WORK_PLANE_ID,
  documentUpTo,
  dotVec3,
  findFeature,
  findSketch,
  isFreeWorkPlaneId,
  moveHistoryItem,
  pushUndo,
  redo as redoStep,
  removeFeature,
  replaceFeature,
  replaceSketch,
  resolveSketch,
  setActiveSketch as activateSketch,
  sketchConstraints,
  undo as undoStep,
  WORK_PLANE_IDS,
  WORK_PLANES,
  pruneDocumentAppearance,
  type AppearanceMatchEntry,
  type AppearanceSpec,
  type ConstraintDiagnosis,
  type ConstraintTarget,
  type CoordinateInput,
  type PartDocument,
  type PartProgress,
  type PartRecomputeError,
  type PartRecomputeOptions,
  type ParameterAnalysis,
  type PartRecomputeResult,
  type PartSketchResult,
  type ResolvedReferences,
  type ResolvedSketch,
  type SketchDocument,
  type SketchError,
  type SketchFeature,
  type SketchFeatureKind,
  type SketchMesh,
  type SketchRecomputeResult,
  type SketchConstraintKind,
  type SolidBody,
  type UndoStack,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';
import { create } from 'zustand';

import {
  assignAppearanceToSelection,
  clearAllAppearance,
  removeAppearanceAt,
} from '../appearance/appearanceCommands.js';
import { createBrowserFileGateway, type FileGateway } from '../file/fileGateway.js';
import type { MessageKey } from '../i18n/t.js';
import { loadSettings, saveSettings, type DisplaySettings } from '../settings/settings.js';
// タイムラインのつまみ(FR-507、P4b タスク19・20)の判断は shell の純関数 1 か所に置く。
// 描く側(Timeline.tsx / FeatureTree.tsx)と同じ規則をここでも使い、2 か所に書かない。
import { placeNewFeatures, type TimelineRefusal } from '../shell/timelineMove.js';
import { shouldShowTimelineHint } from '../shell/timelineHint.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import type { NumericInputState, NumericInputToolId } from '../sketch/numericInput.js';
import {
  EMPTY_REFERENCE_DRAFT,
  resolveReferencesOf,
  resolveWorkPlaneOf,
  type ReferenceDraft,
} from '../sketch/referenceCommands.js';
import {
  commitRemoveConstraints,
  constraintsReferencing,
} from '../sketch/constraintCommands.js';
import type { ConstraintValuePrompt } from '../sketch/constraintPicking.js';
import { summarizeConstraints, type ConstraintSummary } from '../sketch/constraintSummary.js';
import { EMPTY_SHAPE_DRAFT, type ShapeDraft } from '../sketch/shapeCommands.js';
import { DEFAULT_SNAP_KINDS, type SnapKind } from '../sketch/snapMath.js';
import type { TrackCandidate } from '../sketch/trackMath.js';
import type { EditPreview } from '../sketch/trimPreview.js';
import {
  keepsSelectionKind,
  selectionKindForTool,
  subShapeBodiesOf,
  type SelectionKind,
} from '../solid/subShapeSelection.js';
import { viewDirection, type OrbitState } from '../viewport/cameraMath.js';
import type { MeasurementState } from '../viewport/createMeasureLayer.js';
import type { SketchDrag } from '../viewport/dragSketch.js';

/** 透視投影 / 平行投影(FR-102)。 */
export type ProjectionMode = 'perspective' | 'orthographic';

/** 表示スタイル 3 種(FR-105)。 */
export type DisplayStyle = 'shaded' | 'shadedWithEdges' | 'wireframe';

/** いま吸い付いている場所。印を出すのに使う(FR-107)。 */
export interface SnapIndicator {
  /** ビューポートの左上を原点とした画面座標(画素)。 */
  readonly screen: readonly [number, number];
  readonly kind: SnapKind;
  /** 吸い付いた先の要素。方眼の交点は要素を持たないので null。 */
  readonly elementId: string | null;
}

/**
 * ファイル操作の結果を帯へ 1 行で出すための知らせ(FR-806、NFR-UX-5)。
 *
 * 成功(`failed: false`)は「保存しました」のような短い一言、失敗(`failed: true`)は
 * 理由そのもの(`file.error.*` など)を入れる。理由の文はそれだけで何が起きたかが
 * 分かる書き方にしてあるので、見出しを足して二重に言わない。
 * 文書が変わったら用済みなので消す(`applyDocument` / `undo` / `redo` / `resetDocument`)。
 */
export interface FileMessage {
  readonly key: MessageKey;
  readonly failed: boolean;
}

/**
 * 起動時に出す「前回の作業が残っています」の案内(FR-805、§0.a-0.12)。
 *
 * 中身そのもの(控えの `.pcad`)はここへ持たない。案内に出すのは時刻と名前だけで、
 * 実際の読み直しは「復元する」を押したときに保管庫から改めて行う(`attachAutoSave.ts`)。
 * 出していないものを記憶に抱え込まないため。
 */
export interface RestorePrompt {
  /** 控えを書いた時刻(ISO 8601)。表示は現地時刻に直す。 */
  readonly savedAt: string;
  /** 控えの部品の名前。 */
  readonly documentName: string;
}

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

export interface AppState {
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
  readonly projection: ProjectionMode;
  readonly displayStyle: DisplayStyle;
  readonly showGrid: boolean;
  /**
   * 表示テーマと拡大率(FR-908、FR-909、§0.a-0.1〜0.3)。端末(`localStorage`)へ保存され、
   * 部品文書とは無関係な利用者・端末の好みなので `resetDocument`(新規)では戻さない。
   * ルート要素への反映(`data-theme` / `--pcad-scale`)は `shell/applyDisplaySettings.ts`。
   */
  readonly displaySettings: DisplaySettings;
  /** ホーム視点への復帰要求を数える(FR-108)。増えるたびにビューポートが反応する。 */
  readonly homeViewRequestCount: number;
  /**
   * 「視点に合わせる」の要求を数える(§0.a-0.3)。視点の正本は `attachCameraControls` に
   * あってストアからは読めないので、ビューポートが増加に気づいて今の視点を渡し返す。
   */
  readonly matchWorkPlaneRequestCount: number;
  /**
   * ビューポートへ焦点を戻す要求を数える。canvas を持っているのは
   * `attachSketchInteraction` だけなので、増加に気づいた向こう側が焦点を移す。
   * 道具を選んだ直後に Enter が効くようにするため(NFR-UX-1、NFR-UX-4)。
   */
  readonly focusViewportRequestCount: number;
  /**
   * コマンドラインの欄(FR-208、P4b タスク18)へ焦点を移す要求を数える。欄を持っているのは
   * `shell/CommandLine.tsx` だけなので、増加に気づいた向こう側が焦点を移す
   * (`focusViewportRequestCount` と対になる仕組み)。`AppShell.tsx` の `Space` が増やす。
   */
  readonly commandLineFocusRequestCount: number;
  /**
   * コマンドラインの欄に焦点があるか(FR-208、P4b タスク18)。
   *
   * ビューポート(`attachSketchInteraction.ts`)は React の外にいて、どこに焦点があるかを
   * props からは知れない。欄に焦点があるあいだの押下は「欄から出るための押下」として
   * 当たり判定を飛ばすので、その判定材料をここに置く(rules/04-設計の規律.md
   * 「フロントの状態は Zustand 1 本」。DOM を直接探しに行かない)。
   */
  readonly commandLineFocused: boolean;
  /** ビューポート区画の大きさ(画素)。その場入力を端で折り返すのに使う。 */
  readonly viewportSize: readonly [number, number];

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
   * いま選ぶ部分形状の種類(FR-106、§0.a-0.6)。道具を選ぶと `setActiveTool` が自動で
   * 切り替える。手動の切替は `setSelectionKind`(`1`〜`4` キーの受け口はタスク26)。
   */
  readonly selectionKind: SelectionKind;
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
  /**
   * タイムラインのつまみの位置(FR-507、FR-506、P4b タスク19)。帯の通し番号で、
   * `null` が末尾(全部作られた状態)。**保存しない**(§0.a-0.19)ので `.pcad` には
   * 入らず、開く・新規・復元・Undo / Redo のたびに `null` へ戻す。
   *
   * 形の正本はあくまで `document`(全体)で、ここが変わっても `document` は 1 バイトも
   * 変わらない。3D へ出す形だけが `documentUpTo(document, timelineIndex)` で切られる。
   * `null` のときは `documentUpTo` が同じ文書をそのまま返す(`===`)ので、これまでの
   * 経路も性能も何も変わらない(NFR-PF-3)。
   */
  readonly timelineIndex: number | null;
  /**
   * つまみについての知らせの文言キー(P4b タスク19)。断りではないので帯を赤くしない。
   * いまの使い道は 1 つで、途中まで戻したまま新しいものを作ったときに
   * 「新しく作ったものを出すため、最後まで戻しました」と伝える。
   * 文書が次に変われば用済みなので `applyDocument` が落とす。
   */
  readonly timelineNoticeKey: MessageKey | null;
  /**
   * 順序の入れ替えを断った理由(FR-504、FR-507。P4b タスク20)。断らなかったときは null。
   *
   * 理由の文は model(`moveHistoryItem` の `reason`)が相手の名前つきで組み立てたものを
   * そのまま持つ。`blockingFeatureId` は**壊れる側**(指している方)なので、木のその行に
   * 印を出す。文書が次に変われば用済みなので `applyDocument` が落とす。
   */
  readonly timelineRefusal: TimelineRefusal | null;
  /** Undo / Redo の履歴(FR-505)。`present` は常に `document` と同じものを指す。 */
  readonly undoStack: UndoStack<PartDocument>;
  /** 戻せる段・進める段があるか。ツールバーのボタンの入り切りに使う(FR-505)。 */
  readonly canUndo: boolean;
  readonly canRedo: boolean;

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

  /** 選択中の要素 id(FR-106)。面を張るときは選んだ順に意味がある(FR-309)。 */
  readonly selection: readonly string[];
  /** ホバー中の要素 id(FR-106)。 */
  readonly hoveredElementId: string | null;
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
   * 外観を割り当てられなかった理由の文言キー(FR-1106〜1110、NFR-UX-5。P5 タスク11)。
   *
   * 断りは 4 通りで、いずれも**割り当てを作る前**に決まる(`appearanceCommands.ts`):
   * 選んでいるものが無い / 値が 0〜100 の外 / そのボディの材質が 9 種以上 /
   * まとまりが 33 個以上。`faceErrorKey` / `solidErrorKey` と同じ扱いで、
   * ステータスバーが理由の文をそのまま出す(それだけで通じる 1 文なので頭の言葉は付けない)。
   * 文書が変われば用済みなので `applyDocument` が落とす。
   */
  readonly appearanceErrorKey: MessageKey | null;
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
   * いま画面に出している測定の結果(FR-1102、P5 タスク31)。無ければ null。
   *
   * ビューポートの層(`createMeasureLayer.ts`)が線・弧・端の丸・値の札を出し、
   * プロパティ欄(タスク32)が同じものを数字で出す。**測る・消すの操作はタスク32** で、
   * ここは「結果を持つ欄」と「いつ消えるか」だけを決める。
   *
   * **形が変わったら消す**(FR-1102「モデルを変更するまで残る」、§0.a-0.29)。判定は
   * `affectsShape` で、`applyDocument` / `undo` / `redo` の 3 か所が落とす。**外観だけの
   * 変更(FR-1106〜1110)では消えない**(形は 1 ミリも動いていないので、測った値は
   * そのまま正しい)。
   */
  readonly measurement: MeasurementState | null;
  /**
   * 最後にビューポートで何かを選んだ場所(canvas の左上を原点とした画素)。
   * ソリッドの道具のその場入力を、選んだものの近くへ出すのに使う(NFR-UX-2)。
   * まだ何も選んでいなければ null で、そのときはビューポートの中央に出す。
   */
  readonly pickAnchor: readonly [number, number] | null;

  /**
   * ファイルの読み書きの口(§2.10)。既定はブラウザ用で、デスクトップ版が
   * `setFileGateway` で差し替える(UI から `apps/` を import できないため)。
   */
  readonly fileGateway: FileGateway;
  /** 開いている(または保存した)ファイルの名前。まだ保存していなければ null。 */
  readonly fileName: string | null;
  /**
   * 最後に保存した文書。これと `document` の中身が違えば「保存していない変更がある」
   * (判定は `hasUnsavedChanges`)。一度も保存していなければ null。
   */
  readonly savedDocument: PartDocument | null;
  /**
   * いまの絵をサムネイルの PNG にする手立て(§0.a-0.18)。ビューポートが自分を
   * 差し出し、片付けで null へ戻す。用意できていなければサムネイルなしで保存する。
   */
  readonly captureThumbnail: (() => Uint8Array | null) | null;
  /** ファイル操作の結果の知らせ。出すものが無ければ null。 */
  readonly fileMessage: FileMessage | null;
  /**
   * 自動保存の控えを書く人(FR-805)。起動時に `startAutoSave` が差し出し、
   * 片付けで取り下げる。まだ用意できていなければ null。
   *
   * ストアへ置くのは、手で保存できたときに控えを消す(`savePart`)のと、復元の案内カードの
   * ボタン(`AppShell.tsx`)が同じ 1 人を使う必要があるため。口を配り歩くと、どこかで
   * 別の控えを掴んで「消したはずのものが残る」ことになる。
   */
  readonly autoSaver: AutoSaver | null;
  /** 起動時の復元の案内(§0.a-0.12)。出すものが無ければ null。 */
  readonly restorePrompt: RestorePrompt | null;

  // 動作を変える口はメソッド宣言ではなくプロパティ関数型で書く。メソッド宣言だと
  // useAppStore((state) => state.setX) のように取り出したとき @typescript-eslint/unbound-method
  // に触れるため(計画書 P1 §0.a-0.12、docs/報告記録.md 2026-09-02 15:28 の残件②)。
  /** 再計算が投げた失敗を出す・消す。計算中の印はここで下ろす。 */
  readonly setError: (message: string | null) => void;
  /**
   * 幾何カーネルを読み込み終えたと記録する(P3 §0.a-0.23 ⑨)。
   * `applyRecompute` は購読通知の中で `set` を入れ子にしないため、この口を呼ばずに
   * 自分の `set` へ `kernelLoaded: true` を直接含める。ここは単体で呼びたいとき用に残す。
   */
  readonly markKernelLoaded: () => void;
  readonly setProjection: (projection: ProjectionMode) => void;
  readonly setDisplayStyle: (displayStyle: DisplayStyle) => void;
  readonly setShowGrid: (showGrid: boolean) => void;
  /** 表示テーマ・拡大率を差し替え、`localStorage` へ保存する(FR-908、FR-909)。 */
  readonly setDisplaySettings: (settings: DisplaySettings) => void;
  readonly requestHomeView: () => void;
  /** ビューポート(canvas)へ焦点を戻してほしい、と頼む。 */
  readonly requestViewportFocus: () => void;
  /** コマンドラインの欄へ焦点を移してほしい、と頼む(FR-208。`Space` の受け口)。 */
  readonly requestCommandLineFocus: () => void;
  /** コマンドラインの欄が焦点を得た・失ったことを知らせる(FR-208)。 */
  readonly setCommandLineFocused: (focused: boolean) => void;
  readonly setViewportSize: (size: readonly [number, number]) => void;

  readonly setActiveTool: (tool: NumericInputToolId) => void;
  /**
   * 選ぶ部分形状の種類を手動で切り替える(§0.a-0.6)。種類が変わったら、いまの選択のうち
   * 種類の合わないものを外す(違う種類の選択が加工の対象に紛れ込むのを防ぐ、NFR-UX-1)。
   */
  readonly setSelectionKind: (kind: SelectionKind) => void;
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
  /** 部品まるごとの再計算の結果を反映する(要件§6.3)。 */
  readonly applyRecompute: (document: PartDocument, result: PartRecomputeResult) => void;
  /** 1 段戻す・1 段進める(FR-505)。戻せる段が無ければ何も起きない。 */
  readonly undo: () => void;
  readonly redo: () => void;
  /** 計算の進み具合を出す・消す(NFR-PF-4)。 */
  readonly setRecomputeProgress: (progress: PartProgress | null) => void;
  /** 計算を止めるよう頼む(NFR-PF-4)。段と段の間でしか止まらない(§2.6 の限界)。 */
  readonly cancelRecompute: () => void;
  /**
   * タイムラインのつまみを置き直す(FR-507、FR-506)。`null` で末尾へ戻す。
   * **文書は変えない**ので Undo の段も作らない(つまみを動かすのは形を変える操作ではない)。
   * 3D へ出す形の切り直しは `attachPartRecompute` がこの値の変化に気づいて行う。
   */
  readonly setTimelineIndex: (index: number | null) => void;
  /**
   * 履歴の順序を入れ替える(FR-507、FR-504。P4b タスク20)。`toIndex` は帯の通し番号。
   *
   * 動かせるなら文書を 1 回だけ積むので、取り消し(Ctrl+Z)1 回で元の順序に戻る
   * (NFR-UX-3)。依存を壊すなら**文書は 1 バイトも変えず**、理由を `timelineRefusal` へ
   * 置いて帯と木の行で知らせる(rules/04-設計の規律.md「止めずに警告する」)。
   */
  readonly moveTimelineItem: (featureId: string, toIndex: number) => void;
  /** 順序の入れ替えの断りを出す・消す(FR-504)。 */
  readonly setTimelineRefusal: (refusal: TimelineRefusal | null) => void;
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
  readonly setSelection: (ids: readonly string[]) => void;
  readonly toggleSelection: (id: string) => void;
  readonly setHovered: (id: string | null) => void;
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
  /** 3D スケッチで押した場所の面を覚える・捨てる(FR-330、タスク14)。 */
  readonly setFreeSketchPlane: (plane: WorkPlane | null) => void;
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
  /** トリム・延長の予告を出す・消す(FR-322、タスク22)。 */
  readonly setEditPreview: (preview: EditPreview | null) => void;
  /** 面を張れなかった理由を出す・消す。 */
  readonly setFaceError: (key: MessageKey | null) => void;
  /** 立体を作れなかった理由を出す・消す(FR-401〜404)。 */
  readonly setSolidError: (key: MessageKey | null) => void;
  /** 整形系の道具(オフセット等)を作れなかった理由を出す・消す(FR-321、NFR-UX-5)。 */
  readonly setEditError: (key: MessageKey | null) => void;
  /** 外観を割り当てられなかった理由を出す・消す(FR-1106〜1110、NFR-UX-5)。 */
  readonly setAppearanceError: (key: MessageKey | null) => void;
  /**
   * いま選んでいる立体・面へ外観を割り当てる(FR-1106、FR-1107、FR-1109)。
   *
   * 判断は `appearance/appearanceCommands.ts` の純関数 1 か所に置き、ここは
   * 「文書を渡す」「断りを置く」だけにする。確定は `applyDocument` を通すので、
   * **取り消し(FR-505)と保存は 1 行も足さずに効く**。形は変わらないので
   * `affectsShape` が偽になり、再計算も計算中の札も起きない(§2.3)。
   */
  readonly assignAppearance: (spec: AppearanceSpec) => void;
  /** 割り当てを 1 つ外す(FR-1110)。 */
  readonly removeAppearance: (id: string) => void;
  /** すべての割り当てを外して既定の外観に戻す(FR-1110)。 */
  readonly clearAppearance: () => void;
  /** 整形系の道具が成功したときの案内を出す・消す(FR-323、タスク23)。 */
  readonly setEditNotice: (key: MessageKey | null) => void;
  /** 原点を移したときの一言を出す・消す(FR-331、タスク35b)。 */
  readonly setOriginNotice: (message: string | null) => void;
  /** ビューポートで選んだ場所を覚える・忘れる。 */
  readonly setPickAnchor: (anchor: readonly [number, number] | null) => void;

  /** ファイルの読み書きの口を差し替える(デスクトップ版の入口が呼ぶ)。 */
  readonly setFileGateway: (gateway: FileGateway) => void;
  /** 開いているファイルの名前と、最後に保存した文書を差し替える。 */
  readonly setFileState: (fileName: string | null, savedDocument: PartDocument | null) => void;
  /** サムネイルの作り手を差し出す・取り下げる(ビューポートが呼ぶ)。 */
  readonly setCaptureThumbnail: (capture: (() => Uint8Array | null) | null) => void;
  /** ファイル操作の結果を帯へ出す・消す。 */
  readonly setFileMessage: (message: FileMessage | null) => void;
  /** 自動保存の控えを書く人を差し出す・取り下げる(`startAutoSave` が呼ぶ)。 */
  readonly setAutoSaver: (saver: AutoSaver | null) => void;
  /** 復元の案内を出す・閉じる。 */
  readonly setRestorePrompt: (prompt: RestorePrompt | null) => void;
  /**
   * 部品文書を新しくやり直す(FR-806 の「新規」)。`applyDocument` と違い
   * **履歴のスタックを作り直す**ので、新規の前へは戻れない。取りかけの操作・選択・
   * 断りの理由も持ち越さない(NFR-UX-3)。
   */
  readonly resetDocument: (next: PartDocument) => void;
}

/**
 * 同点とみなす傾きの差。等角のホーム視点では 3 面が等しく傾くが、三角関数の丸めで
 * 最下位桁だけが違う値になる。その 1 桁で選ばれる面が変わると、同じ見え方から
 * 違う結果が出て説明できない(NFR-UX-1)。差がこれ以下なら同点として先頭を採る。
 */
const ALIGNMENT_EPSILON = 1e-9;

/**
 * 今の視点に最も近い作図面を選ぶ(§0.a-0.3)。
 *
 * 画面に正対して見えている面ほど、その法線が視線と平行になる。だから法線と視線の
 * 内積の絶対値が最大の面を採る(手前から見ているか奥から見ているかは問わない)。
 * 等角のように 3 面が並ぶときは XY → XZ → YZ の先頭、つまり既定の XY を採る。
 * ビューキューブは視点だけを変え、作図面は変えない。作図面が変わるのはこの関数を
 * 呼ぶ「視点に合わせる」を押したときだけ(NFR-UX-1 操作文法の一貫性)。
 */
export function workPlaneForOrbit(orbit: OrbitState): WorkPlaneId {
  const direction = viewDirection(orbit);
  let best: WorkPlaneId = DEFAULT_WORK_PLANE_ID;
  let bestAlignment = -1;
  for (const id of WORK_PLANE_IDS) {
    const alignment = Math.abs(dotVec3(direction, WORK_PLANES[id].normal));
    if (alignment > bestAlignment + ALIGNMENT_EPSILON) {
      bestAlignment = alignment;
      best = id;
    }
  }
  return best;
}

/** いま編集しているスケッチ(§0.a-0.4)。指し先が消えていたら先頭を使う。 */
function activeSketchOf(document: PartDocument): SketchDocument {
  return findSketch(document, document.activeSketchId) ?? document.sketches[0];
}

/**
 * そのスケッチが使っている作図面(P4 仕上げ (g)、FR-328、FR-501)。
 *
 * スケッチ文書そのものは作図面を持たない(持つのは要素 1 つ 1 つの `planeId`)。
 * だからスケッチを切り替えたときに札とビューポートを合わせる先は、**最後に置いた要素の
 * 作図面**から引く。文書から導ける値なので新しい控えを持たずに済み(rules/04「導出できる
 * ものは保存しない」)、ファイルを開き直しても同じ面へ戻る。
 *
 * まだ 1 つも要素が無いスケッチは面を決めようがないので null を返し、呼び出し側は
 * いまの作図面のままにする(新しく足した直後のスケッチがこれにあたる)。
 */
export function workPlaneOfSketch(sketch: SketchDocument | undefined): WorkPlaneId | null {
  if (sketch === undefined || sketch.features.length === 0) {
    return null;
  }
  return sketch.features[sketch.features.length - 1].planeId;
}

/**
 * 面の境界に使える要素の種類(§0.a-0.23 ⑨)。
 * `packages/ui/src/sketch/sketchCommands.ts` の `commitFace`(実体は `boundaryElementKind`)が
 * 受け付ける種類にそろえる。面フィーチャー自身は境界に使えない。
 *
 * P4 タスク12 で新しい図形(矩形・正多角形・長穴・楕円・スプライン)を足した。いずれも
 * 曲線を生むので面の囲みに使える(矩形・正多角形・長穴は 1 フィーチャーが複数の曲線を生み、
 * `resolveFace` が全周を展開する。§0.a-0.8)。
 * P4 タスク21 でオフセット(複製の曲線列)を足した。結果は元と同じ曲線なので同様に使える
 * (§2「結果の曲線は…面の境界に使える」)。
 */
const FACE_BOUNDARY_KINDS: ReadonlySet<SketchFeatureKind> = new Set([
  'point',
  'line',
  'arc',
  'pointArray',
  'rectangle',
  'polygon',
  'slot',
  'ellipse',
  'spline',
  'offset',
  // P4 タスク20 で複製(ミラー・複写・配列複写)を足した。複製の結果は元と同じ形の
  // 曲線・点なので、面の囲みにもそのまま使える(FR-324)。
  'copy',
  // P4 タスク25 で投影・交差を足した。取り込んだ輪郭は普通の線・円弧として扱えるので、
  // 面の囲みにも押し出しの材料にも使える(FR-325、計画書 §2「結果の曲線は…使える」)。
  'projectedCurve',
  'planeSection',
]);

/**
 * 面の道具を選んだときに、境界に使えない要素(面フィーチャー・立体・部分形状)を
 * 選択から外す(§0.a-0.23 ⑨)。計算中(幾何カーネルの初回読み込み中)に速い操作で
 * 面を張ろうとすると、選択に残った面や立体が境界へ混じって断られる不具合の対策。
 * 判定は `featureIdOf` で元の要素 id に戻し、いまのスケッチにその id の点・線・円弧・
 * 点列フィーチャーがあるかどうかで行う(立体の id はスケッチに無いのでここで外れる)。
 */
export function filterSelectionForFaceTool(
  sketch: SketchDocument,
  selection: readonly string[],
): readonly string[] {
  const kept = selection.filter((elementId) => {
    const feature = findFeature(sketch, featureIdOf(elementId));
    return feature !== undefined && FACE_BOUNDARY_KINDS.has(feature.kind);
  });
  return kept.length === selection.length ? selection : kept;
}

/** 文書を差し替えたときに一緒に作り直す控え(§0.a-0.4)。 */
type DocumentPatch = Pick<
  AppState,
  | 'document'
  | 'undoStack'
  | 'canUndo'
  | 'canRedo'
  | 'sketch'
  | 'documentName'
  | 'featureNames'
  | 'selection'
  | 'hoveredElementId'
  | 'workPlaneId'
  | 'workPlane'
  | 'resolvedReferences'
  | 'parameterAnalysis'
>;

/**
 * 作図面 id が、その文書でまだ有効か(統括の指示、2026-09-05。P4b タスク22a-(5)・22b-(i))。
 *
 * 基準の3面(xy / xz / yz)は常に有効。任意の作業平面は、文書の `references` にその id の
 * 作業平面フィーチャーがあるときだけ有効とする。
 *
 * **3D スケッチ(`free`)の扱いは経路で分ける**(P4b タスク22b-(i)、統括の指示 2026-09-05)。
 * ・`replacesDocument`(新規・開く・復元)… 無効とし、基準の XY へ戻す。**新しい部品を
 *   3D スケッチのまま始めると、次に描く矩形が「3D スケッチではこの形をかけません」で
 *   必ず失敗する**(Electron 台本の項目 10〜13 がすべてこれで落ちた実測)。前の部品の
 *   作図面を持ち越さないのは、作業平面のときと同じ扱いにそろえる。
 * ・Undo / Redo … 有効のまま保つ。同じ部品の中の時をまたぐ移動でしかなく、利用者が
 *   選んだ 3D スケッチを勝手に降ろすと操作が飛ぶ。
 *
 * 文書を丸ごと差し替える経路で `workPlaneId` だけが古いまま残ると、次に置く矩形・線分が
 * その存在しない作図面を指して作られ、面が張れず「作図面が見つかりません」になる
 * (再現: 作業平面を作図面に切り替える → 新規 → 矩形 → 面を張る)。
 */
function isWorkPlaneIdValidFor(
  document: PartDocument,
  planeId: WorkPlaneId,
  replacesDocument = false,
): boolean {
  if (baseWorkPlane(planeId) !== null) {
    return true;
  }
  if (isFreeWorkPlaneId(planeId)) {
    return !replacesDocument;
  }
  return document.references.some(
    (reference) => reference.kind === 'referencePlane' && reference.id === planeId,
  );
}

/**
 * つまみの知らせ(FR-507)を選ぶ(P4b タスク19・22b-(a))。
 *
 * ①途中まで戻したまま作ったときは「差し込みました」(タスク19)。
 * ②そうでなく、**ソリッドが初めて 2 段以上になった**ときは、つまみの初回の案内を 1 度だけ
 *   出す(利用者の決定①(2026-09-05))。既読は端末に覚えるので同じ人に二度は出ない。
 * ③どちらでもなければ何も言わない。
 */
function timelineNoticeFor(
  state: AppState,
  next: PartDocument,
  inserted: boolean,
): MessageKey | null {
  if (inserted) {
    return 'timeline.inserted';
  }
  const show = shouldShowTimelineHint(
    state.document.solids.length,
    next.solids.length,
    state.displaySettings.timelineHintSeen,
  );
  return show ? 'timeline.hint' : null;
}

/**
 * 文書を差し替え、派生の控えを作り直す。**`document` を書き換えるのはここだけ。**
 *
 * 文書から消えたフィーチャーは選択とホバーからも外す(消えたものを指したままだと、
 * プロパティ欄が空を出し、次に同じ id が採番されたとき別物を選んで見える)。
 *
 * **部分形状の id(`extrude-1#face:0` 等)もここで一緒に掃除される**(§0.a-0.8)。
 * `liveIds.has(featureIdOf(id))` は `#` の前(ボディの id)しか見ないため、`as`
 * を使わずに済み、タスク20 が決めた id の書式(`subShapeSelection.ts`)を 1 行も
 * 変えずにそのまま効く。**ただし「ボディ自体は残っているが、面・辺・頂点の番号が
 * 再計算で範囲外になった」場合はここでは掃除されない**(ボディの id はまだ `liveIds`
 * にあるため)。この限界は表示側(タスク22 の `buildSubShapeGeometry`)が範囲外の
 * 参照を黙って描かないことで見た目の破綻を防ぐ想定(§2.11)。
 *
 * **作図面 `workPlaneId` もここで一緒に確かめる**(P4b タスク22a-(5))。`resetDocument` /
 * `applyDocument`(開く・復元)/ `undo` / `redo` はすべてここを通るので、経路ごとに同じ
 * 判定を書かずに済む。新しい文書にその作業平面が無ければ既定の XY へ戻す
 * (`referencePatch` が作り直す `workPlane` の解決先も、このあとの XY に揃う)。
 */
function documentPatch(
  state: AppState,
  next: PartDocument,
  stack: UndoStack<PartDocument>,
  /**
   * 文書を丸ごと差し替える経路(新規・開く・復元)か。3D スケッチの扱いだけが変わる
   * (`isWorkPlaneIdValidFor` の注釈)。Undo / Redo と、形を変えただけの差し替えは false。
   */
  replacesDocument = false,
): DocumentPatch {
  const sketch = activeSketchOf(next);
  const liveIds = new Set<string>(sketch.features.map((feature) => feature.id));
  for (const solid of next.solids) {
    liveIds.add(solid.id);
  }
  const hovered = state.hoveredElementId;
  // 作図面が指す作業平面が新しい文書に無ければ既定の XY へ戻す(P4b タスク22a-(5))。
  const workPlaneId = isWorkPlaneIdValidFor(next, state.workPlaneId, replacesDocument)
    ? state.workPlaneId
    : DEFAULT_WORK_PLANE_ID;
  return {
    document: next,
    undoStack: stack,
    canUndo: stackCanUndo(stack),
    canRedo: stackCanRedo(stack),
    sketch,
    documentName: sketch.name,
    featureNames: sketch.features.map((feature) => feature.name),
    selection: state.selection.filter((id) => liveIds.has(featureIdOf(id))),
    hoveredElementId: hovered !== null && !liveIds.has(featureIdOf(hovered)) ? null : hovered,
    workPlaneId,
    // 基準ジオメトリ(FR-328、FR-329)は文書から導ける控えなので、ここで作り直す。
    ...referencePatch(next, workPlaneId),
    // パラメータ表(FR-207)も同じく文書から導ける控え。
    ...parameterPatch(next),
  };
}

/**
 * パラメータ表の控えを作り直す(FR-207、タスク11)。
 *
 * **パラメータが 1 つも無い文書では解析そのものを省く**(`referencePatch` と同じ理由)。
 * 解析は文書の全ての式を集めて「使われていない名前」を数えるので、欄で 1 文字打つたびに
 * 文書を歩くことになる。名前を 1 つも付けていない部品(いまの既定)では要らない費用なので
 * 空の解析を使い回す(NFR-PF-1)。
 */
function parameterPatch(document: PartDocument): Pick<AppState, 'parameterAnalysis'> {
  if (document.parameters.length === 0) {
    return { parameterAnalysis: EMPTY_PARAMETER_ANALYSIS };
  }
  return {
    parameterAnalysis: analyzeParameters(
      document.parameters,
      collectExpressionSources(document),
    ),
  };
}

/** パラメータが 1 つも無いときの控え。作り直さずに使い回す(参照の同一性を保つ)。 */
const EMPTY_PARAMETER_ANALYSIS: ParameterAnalysis = {
  variables: new Map<string, number>(),
  circular: [],
  unused: [],
  failures: [],
};

/**
 * 作業平面と基準ジオメトリの控えを作り直す(タスク13)。
 *
 * 基準ジオメトリが 1 つも無い文書(P4 より前に作ったものを含む)では解決そのものを
 * 省く。プロパティ欄で 1 文字打つたびにここを通るので、要らない計算を積まないため
 * (NFR-PF-1)。
 */
function referencePatch(
  document: PartDocument,
  planeId: WorkPlaneId,
): Pick<AppState, 'workPlane' | 'resolvedReferences'> {
  if (document.references.length === 0) {
    return {
      workPlane: baseWorkPlane(planeId) ?? WORK_PLANES[DEFAULT_WORK_PLANE_ID],
      resolvedReferences: EMPTY_RESOLVED_REFERENCES,
    };
  }
  return {
    workPlane: resolveWorkPlaneOf(document, planeId),
    resolvedReferences: resolveReferencesOf(document),
  };
}

/** 基準ジオメトリが 1 つも無いときの控え。作り直さずに使い回す(参照の同一性を保つ)。 */
const EMPTY_RESOLVED_REFERENCES: ResolvedReferences = {
  planes: [],
  axes: [],
  points: [],
  coordinateSystems: [],
  errors: [],
};

/**
 * いま編集しているスケッチの失敗だけを控えへ写す(§0.a-0.4、FR-504)。
 *
 * 解決の失敗はスケッチごとの結果にそのまま入っている。カーネルが面を作れなかった失敗は
 * 部品全体の `errors` に混ざって届き、型の上では PartError と見分けが付かないので、
 * そのスケッチの要素 id を持ち、かつ解決の失敗として出ていないものを拾い直す。
 * 付け直す code は `recomputePart` が付けるものと同じ `kernelFailed`(強制変換を使わずに
 * 型を狭めるため、拾ったものをそのまま入れずに作り直している)。
 */
function activeSketchErrors(
  sketch: SketchDocument,
  result: PartSketchResult,
  errors: readonly PartRecomputeError[],
): readonly SketchError[] {
  const resolveErrors = result.resolved.errors;
  const reported = new Set(resolveErrors.map((error) => error.featureId));
  const featureIds = new Set(sketch.features.map((feature) => feature.id));
  const kernelErrors: SketchError[] = [];
  for (const error of errors) {
    if (featureIds.has(error.featureId) && !reported.has(error.featureId)) {
      kernelErrors.push({
        featureId: error.featureId,
        code: 'kernelFailed',
        message: error.message,
      });
    }
  }
  return kernelErrors.length === 0 ? resolveErrors : [...resolveErrors, ...kernelErrors];
}

/** 拘束の道具でまだ何も押していないときの並び。作り直さずに使い回す。 */
const NO_CONSTRAINT_TARGETS: readonly ConstraintTarget[] = [];

/** 拘束が 1 つも無いときの一覧。作り直さずに使い回す(参照の同一性を保つ)。 */
const NO_CONSTRAINT_SUMMARIES: readonly ConstraintSummary[] = [];

/**
 * 拘束の一覧の行を作り直す(FR-313、タスク13)。**拘束が 1 つも無い文書では歩き直さない**
 * (`parameterPatch` / `referencePatch` と同じ理由。いまの既定の部品は拘束を持たない)。
 *
 * 材料は「いま描いている解決結果」をそのまま使い回す。印に要るのは位置と名前だけで、
 * 動かせる数(`variableSet`)は診断(`diagnosis`)が持っているため、ここで解き直さない。
 */
function constraintSummaryPatch(
  sketch: SketchDocument,
  resolved: ResolvedSketch,
  diagnosis: ConstraintDiagnosis | null,
): Pick<AppState, 'constraintSummaries'> {
  // `constraints` は版 5 で足した任意の欄なので、古い文書では持たないことがある
  // (model の `sketchConstraints` と同じ扱い)。
  if (sketchConstraints(sketch).length === 0) {
    return { constraintSummaries: NO_CONSTRAINT_SUMMARIES };
  }
  return {
    constraintSummaries: summarizeConstraints(sketch, diagnosis, {
      resolved,
      // 位置と名前しか読まないので、作図面と動かせる数は要らない(上の注釈のとおり)。
      plane: null,
      variableSet: null,
    }),
  };
}

/** テストで元へ戻せるよう、文書まわりの初期値を1箇所にまとめる。 */
export function createInitialDocumentState(): Pick<
  AppState,
  | 'activeTool'
  | 'selectionKind'
  | 'workPlaneId'
  | 'workPlane'
  | 'freeSketchPlane'
  | 'resolvedReferences'
  | 'parameterAnalysis'
  | 'document'
  | 'documentVersion'
  | 'timelineIndex'
  | 'timelineNoticeKey'
  | 'timelineRefusal'
  | 'undoStack'
  | 'canUndo'
  | 'canRedo'
  | 'sketch'
  | 'resolvedSketch'
  | 'sketchMesh'
  | 'sketchErrors'
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
  | 'bodies'
  | 'appearanceMatches'
  | 'partErrors'
  | 'cacheHits'
  | 'recomputeProgress'
  | 'cancelRequestCount'
  | 'recomputeCancelled'
  | 'documentName'
  | 'featureNames'
  | 'isComputing'
  | 'errorMessage'
  | 'selection'
  | 'hoveredElementId'
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
  | 'editPreview'
  | 'faceErrorKey'
  | 'solidErrorKey'
  | 'editErrorKey'
  | 'appearanceErrorKey'
  | 'editNoticeKey'
  | 'originNoticeMessage'
  | 'measurement'
  | 'pickAnchor'
  | 'fileGateway'
  | 'fileName'
  | 'savedDocument'
  | 'captureThumbnail'
  | 'fileMessage'
  | 'autoSaver'
  | 'restorePrompt'
> {
  // 起動時は空のスケッチ 1 本だけを持つ部品から始める(§0.a-0.2、NFR-UX-6 の空状態ガイド)。
  const document = createEmptyPartDocument();
  const sketch = activeSketchOf(document);
  return {
    activeTool: 'select',
    // 'select' は立体を選ぶ道具(選択の種類の対応は selectionKindForTool の既定分岐、§0.a-0.6)。
    selectionKind: 'body',
    workPlaneId: DEFAULT_WORK_PLANE_ID,
    // 起動時の部品には基準ジオメトリが 1 つも無いので、作図面は基準の XY そのもの。
    workPlane: WORK_PLANES[DEFAULT_WORK_PLANE_ID],
    // 3D スケッチで押した場所の面(FR-330、タスク14)。まだ一度も押していない。
    freeSketchPlane: null,
    resolvedReferences: EMPTY_RESOLVED_REFERENCES,
    // 起動時の部品はパラメータを 1 つも持たない(FR-207、タスク11)。
    parameterAnalysis: EMPTY_PARAMETER_ANALYSIS,
    document,
    documentVersion: 0,
    // つまみは常に末尾から始まる(§0.a-0.19。保存しないので開き直しても同じ)。
    timelineIndex: null,
    timelineNoticeKey: null,
    timelineRefusal: null,
    undoStack: createUndoStack(document),
    canUndo: false,
    canRedo: false,
    sketch,
    resolvedSketch: resolveSketch(sketch),
    sketchMesh: null,
    sketchErrors: [],
    // 起動時の部品は拘束を 1 つも持たない(FR-313、P4b タスク13)。
    constraintDiagnosis: null,
    constraintSummaries: NO_CONSTRAINT_SUMMARIES,
    activeConstraintKind: null,
    constraintTargets: NO_CONSTRAINT_TARGETS,
    constraintErrorMessage: null,
    constraintPrompt: null,
    selectedConstraintId: null,
    // 引っぱり(FR-313、P4b タスク14)。起動直後は何も掴んでいない。
    sketchDrag: null,
    dragResolved: null,
    dragRefusalKey: null,
    bodies: [],
    // 起動直後の部品には外観の割り当てが 1 つも無い(FR-1106、P5 タスク10)。
    appearanceMatches: [],
    partErrors: [],
    cacheHits: 0,
    recomputeProgress: null,
    cancelRequestCount: 0,
    recomputeCancelled: false,
    documentName: sketch.name,
    featureNames: [],
    isComputing: false,
    errorMessage: null,
    selection: [],
    hoveredElementId: null,
    snapEnabled: true,
    snapKinds: DEFAULT_SNAP_KINDS,
    chaining: true,
    numericInput: null,
    numericInputAnchor: null,
    pendingStart: null,
    shapeDraft: EMPTY_SHAPE_DRAFT,
    shapeErrorMessage: null,
    referenceDraft: EMPTY_REFERENCE_DRAFT,
    referenceErrorMessage: null,
    snapIndicator: null,
    trackIndicator: null,
    editPreview: null,
    faceErrorKey: null,
    solidErrorKey: null,
    editErrorKey: null,
    appearanceErrorKey: null,
    editNoticeKey: null,
    originNoticeMessage: null,
    // 起動直後は何も測っていない(FR-1102、P5 タスク31)。
    measurement: null,
    pickAnchor: null,
    // 起動直後はまだ保存も読込もしていない。口はブラウザ用から始める(§2.10)。
    fileGateway: createBrowserFileGateway(),
    fileName: null,
    savedDocument: null,
    captureThumbnail: null,
    fileMessage: null,
    autoSaver: null,
    restorePrompt: null,
  };
}

export const useAppStore = create<AppState>()((set, get) => ({
  projection: 'perspective',
  displayStyle: 'shadedWithEdges',
  showGrid: true,
  // 部品を作り直しても(resetDocument)戻さないので、文書まわりの初期値には含めない
  // (kernelLoaded と同じ扱い)。起動時に localStorage から読む(壊れていれば既定値)。
  displaySettings: loadSettings(),
  homeViewRequestCount: 0,
  matchWorkPlaneRequestCount: 0,
  focusViewportRequestCount: 0,
  // コマンドライン(FR-208、P4b タスク18)。文書を作り直しても要求の数は戻さないので、
  // ここ(createInitialDocumentState の外)に置く。欄の打ちかけは部品側が捨てる。
  commandLineFocusRequestCount: 0,
  commandLineFocused: false,
  viewportSize: [0, 0],
  // 幾何カーネルは部品を作り直しても積み直さないので、文書まわりの初期値には含めない
  // (createInitialDocumentState は resetDocument の後には呼ばれない、§0.a-0.23 ⑨)。
  kernelLoaded: false,
  ...createInitialDocumentState(),

  setError: (errorMessage) => {
    set({ errorMessage, isComputing: false, recomputeProgress: null });
  },
  markKernelLoaded: () => {
    set({ kernelLoaded: true });
  },
  setProjection: (projection) => {
    set({ projection });
  },
  setDisplayStyle: (displayStyle) => {
    set({ displayStyle });
  },
  setShowGrid: (showGrid) => {
    set({ showGrid });
  },
  setDisplaySettings: (displaySettings) => {
    saveSettings(displaySettings);
    set({ displaySettings });
  },
  requestHomeView: () => {
    set((state) => ({ homeViewRequestCount: state.homeViewRequestCount + 1 }));
  },
  requestViewportFocus: () => {
    set((state) => ({ focusViewportRequestCount: state.focusViewportRequestCount + 1 }));
  },
  requestCommandLineFocus: () => {
    set((state) => ({
      commandLineFocusRequestCount: state.commandLineFocusRequestCount + 1,
    }));
  },
  setCommandLineFocused: (commandLineFocused) => {
    set({ commandLineFocused });
  },
  setViewportSize: (viewportSize) => {
    set({ viewportSize });
  },

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
  setSelectionKind: (selectionKind) => {
    // 変わらないときは選択を残す(手動切替でも自動切替と同じ規約、§0.a-0.6)。
    set((state) =>
      state.selectionKind === selectionKind ? {} : { selectionKind, selection: [] },
    );
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
    set((state) => {
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
      };
    });
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
  undo: () => {
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
        timelineIndex: null,
        timelineNoticeKey: null,
        // 順序の入れ替えの断りも、時をまたぐ差し替えの後には合わないので落とす(FR-504)。
        timelineRefusal: null,
      };
    });
  },
  setRecomputeProgress: (recomputeProgress) => {
    set({ recomputeProgress });
  },
  cancelRecompute: () => {
    set((state) => ({ cancelRequestCount: state.cancelRequestCount + 1 }));
  },
  setTimelineIndex: (timelineIndex) => {
    set((state) =>
      state.timelineIndex === timelineIndex
        ? {}
        : {
            timelineIndex,
            // 3D へ出す形を切り直すので、計算中の札は素直に立てる。つまみを動かした
            // だけなら段の鍵が変わらず全段がキャッシュに当たるので、すぐ下りる
            // (NFR-PF-3。§2.7「巻き戻しても再計算が起きない」)。
            isComputing: true,
            // つまみを動かしたら、前の位置についての知らせは用済み。
            timelineNoticeKey: null,
          },
    );
  },
  moveTimelineItem: (featureId, toIndex) => {
    const state = get();
    const outcome = moveHistoryItem(state.document, featureId, toIndex);
    if (!outcome.ok) {
      // 断りは文書を変えずに理由だけ置く(FR-504、NFR-RE-1)。壊れる側の行に印が出る。
      set({
        timelineRefusal: {
          message: outcome.reason,
          blockingFeatureId: outcome.blockingFeatureId,
        },
      });
      return;
    }
    // 動かす必要が無かった(同じ位置)ときは `applyDocument` が何もしないので、
    // 前の断りをここで先に落としておく。
    set({ timelineRefusal: null });
    // 文書を 1 回だけ積む。取り消し 1 回で元の順序へ戻る(NFR-UX-3)。
    state.applyDocument(outcome.document);
  },
  setTimelineRefusal: (timelineRefusal) => {
    set({ timelineRefusal });
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
  setSelection: (selection) => {
    // 選び直したら、直前に断られた面・立体・オフセットの理由は用済みなので消す(NFR-UX-5)。
    set({
      selection,
      faceErrorKey: null,
      solidErrorKey: null,
      editErrorKey: null,
      appearanceErrorKey: null,
      editNoticeKey: null,
    });
  },
  toggleSelection: (id) => {
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((selected) => selected !== id)
        : [...state.selection, id],
      faceErrorKey: null,
      solidErrorKey: null,
      editErrorKey: null,
      appearanceErrorKey: null,
      editNoticeKey: null,
    }));
  },
  setHovered: (hoveredElementId) => {
    set({ hoveredElementId });
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
    set({ numericInput });
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
  setPendingStart: (pendingStart) => {
    set({ pendingStart });
  },
  setFreeSketchPlane: (freeSketchPlane) => {
    set({ freeSketchPlane });
  },
  setSnapIndicator: (snapIndicator) => {
    set({ snapIndicator });
  },
  setTrackIndicator: (trackIndicator) => {
    set({ trackIndicator });
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
  setAppearanceError: (appearanceErrorKey) => {
    set({ appearanceErrorKey });
  },
  assignAppearance: (spec) => {
    const state = get();
    const outcome = assignAppearanceToSelection(
      {
        document: state.document,
        bodies: subShapeBodiesOf(state.bodies),
        selection: state.selection,
        selectionKind: state.selectionKind,
        matches: state.appearanceMatches,
      },
      spec,
    );
    if (!outcome.ok) {
      // 断ったときは文書を 1 バイトも変えない(NFR-UX-5)。理由だけを帯へ置く。
      state.setAppearanceError(outcome.reasonKey);
      return;
    }
    // `applyDocument` は前の断りを落とすので、消す処理をここに書く必要はない。
    state.applyDocument(outcome.document);
  },
  removeAppearance: (id) => {
    const state = get();
    state.applyDocument(removeAppearanceAt(state.document, id));
  },
  clearAppearance: () => {
    const state = get();
    state.applyDocument(clearAllAppearance(state.document));
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

  setFileGateway: (fileGateway) => {
    set({ fileGateway });
  },
  setFileState: (fileName, savedDocument) => {
    set({ fileName, savedDocument });
  },
  setCaptureThumbnail: (capture) => {
    set({ captureThumbnail: capture });
  },
  setFileMessage: (fileMessage) => {
    set((state) => ({
      fileMessage,
      // 保存・開くなどが成功したら、古い断りはもう関係ない知らせなので消す
      // (§0.a-0.23 ⑦)。失敗のときは残す(利用者はまだその理由を解消していない)。
      faceErrorKey:
        fileMessage !== null && !fileMessage.failed ? null : state.faceErrorKey,
      solidErrorKey:
        fileMessage !== null && !fileMessage.failed ? null : state.solidErrorKey,
    }));
  },
  setAutoSaver: (autoSaver) => {
    set({ autoSaver });
  },
  setRestorePrompt: (restorePrompt) => {
    set({ restorePrompt });
  },
  resetDocument: (next) => {
    set((state) => ({
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
      snapIndicator: null,
      trackIndicator: null,
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
      // 前の部品で測った値は、別の部品には当てはまらない(FR-1102、タスク31)。
      measurement: null,
      errorMessage: null,
      fileMessage: null,
      recomputeCancelled: false,
    }));
  },
}));

/**
 * 部品を 1 回計算するもの。実物は `recomputePart(document, bridge, options)`。
 * カーネル(Worker)を持たない検査では偽物を差し込めるよう、関数の型で受ける。
 */
export type PartRecomputer = (
  document: PartDocument,
  options: PartRecomputeOptions,
) => Promise<PartRecomputeResult>;

/**
 * 文書の変化を見張り、変わるたびに再計算を予約する(要件§6.3)。
 *
 * 1 本ずつしか走らせない。計算中に文書が何度変わっても覚えるのは**最新の 1 つだけ**で、
 * 間に挟まった版は捨てる。連続入力のたびに Worker を往復させて詰まらせないため
 * (NFR-PF-1)。古い版の結果は捨てるので、`isComputing` が下りるのは最新の計算が
 * 終わったときだけになる。失敗しても例外を投げず、理由を画面に出す(FR-504、NFR-RE-1)。
 *
 * 依頼のたびに世代番号を 1 つ増やして渡す(NFR-PF-4)。番号はここに閉じて持ち、
 * ストアへは出さない。計算を始めるたびにストアを書き換えると、購読の通知の中で
 * さらに書き換えることになるため。中止は `cancelRecompute` が数える回数で拾う。
 *
 * 戻り値を呼ぶと見張りをやめる。
 */
export function attachPartRecompute(recompute: PartRecomputer): () => void {
  let detached = false;
  let running = false;
  /** 実行中に届いた最新の文書。1 つだけ持つ。 */
  let queued: PartDocument | null = null;
  /** 依頼ごとに 1 つ増える世代番号。1 から始まる。 */
  let generation = 0;

  /** 1 本分が終わったときの後始末。次に回す文書があれば返す。 */
  function takeQueued(): PartDocument | null {
    running = false;
    const next = queued;
    queued = null;
    return next;
  }

  function start(document: PartDocument): void {
    running = true;
    generation += 1;
    const current = generation;
    // 中止は「この計算を始めた後に頼まれたか」で判る。始まっていない計算は止められない。
    const cancelBaseline = useAppStore.getState().cancelRequestCount;
    // 前の計算の進み具合は用済み。計算中の札は applyDocument が立てるのでここでは触らない。
    useAppStore.getState().setRecomputeProgress(null);

    void recompute(document, {
      generation: current,
      onProgress: (progress) => {
        // 古い世代の通知は捨てる。画面の進み具合を決めるのは最新の計算だけ。
        if (detached || current !== generation) {
          return;
        }
        useAppStore.getState().setRecomputeProgress(progress);
      },
      shouldCancel: () => useAppStore.getState().cancelRequestCount > cancelBaseline,
    }).then(
      (result) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (next !== null) {
          // もっと新しい文書が来ている。この結果は使わずに次を計算する。
          start(next);
          return;
        }
        useAppStore.getState().applyRecompute(document, result);
      },
      (error: unknown) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (next !== null) {
          start(next);
          return;
        }
        useAppStore.getState().setError(error instanceof Error ? error.message : String(error));
      },
    );
  }

  function request(document: PartDocument): void {
    if (running) {
      queued = document;
      return;
    }
    start(document);
  }

  /**
   * 計算に渡す文書。**保存されるのは常に `document`(全体)で、ここで切ったものは
   * 画面に出す形を決めるためだけに使う**(FR-506、タスク19 の落とし穴)。
   * つまみが末尾(`null`)のときは `documentUpTo` が同じ文書をそのまま返す(`===`)ので、
   * これまでの経路と 1 ミリ秒も変わらない(NFR-PF-3)。
   */
  function shownDocument(state: AppState): PartDocument {
    return documentUpTo(state.document, state.timelineIndex);
  }

  request(shownDocument(useAppStore.getState()));

  const unsubscribe = useAppStore.subscribe((next, previous) => {
    // つまみを動かしたときも計算し直す(FR-507)。切った文書のフィーチャーは複製されない
    // ので段の鍵は変わらず、前半の段は全部キャッシュに当たる(§2.7)。
    // **外観の割り当てだけが変わったときは投げない**(FR-1106〜1110、要件§4.12、
    // P5 §2.3.2)。色を変えるたびに 100 フィーチャーの解決と Worker の往復が起きるのを
    // 避けるための、P5 で最も効く 1 行。形の変化の判定は `model` の `affectsShape` が正本。
    if (
      affectsShape(previous.document, next.document) ||
      next.timelineIndex !== previous.timelineIndex
    ) {
      request(shownDocument(next));
    }
  });

  return () => {
    detached = true;
    queued = null;
    unsubscribe();
  };
}
