/**
 * ステータスバーに出す 1 文の組み立て(計画書 docs/plans/P2-ソリッド基礎.md タスク25、
 * FR-504、FR-905、NFR-PF-4、NFR-UX-7)。
 *
 * 帯は 1 本しかないので、同時に言いたいことがあるときは**優先順位**で 1 つだけ選ぶ。
 * 選ぶ規則と文の組み立てをここへ純関数として置き、`StatusBar.tsx` は描くだけにする。
 * `.tsx` は Node の検査で描けないため(docs/報告記録.md 2026-09-02 23:09
 * 「操作の判断は純関数へ切り出して Node で検査する」)。
 */

import {
  isFreeWorkPlaneId,
  type PartProgress,
  type PartRecomputeError,
  type SketchError,
  type WorkPlaneId,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { picksSolidVertices } from '../sketch/freeSketch.js';
import type { NumericInputToolId } from '../sketch/numericInput.js';
import type { SnapKind } from '../sketch/snapMath.js';
import type { TrackKind } from '../sketch/trackMath.js';
import { parseSubShapeId, type SelectionKind, type SubShapeKind } from '../solid/subShapeSelection.js';
import type { FileMessage } from '../store/useAppStore.js';
import type { TimelineRollback } from './timelineRail.js';

/**
 * 進み具合を出すまでの待ち時間(NFR-PF-4)。進み具合が届いてからこれだけ経つまでは
 * 何も出さない。短い計算で札が出たり消えたりして点滅するのを防ぐため
 * (docs/報告記録.md 2026-09-02 23:35 の②と同じ理由)。
 */
export const PROGRESS_DELAY_MS = 300;

/**
 * 道具ごとの次の一手(FR-905、NFR-UX-7)。
 * 選択のときは道具そのものの説明より、視点の動かし方を知らせるほうが役に立つので
 * これまでの案内(`statusBar.ready`)をそのまま出す。
 */
const GUIDE_KEYS = {
  select: 'statusBar.ready',
  point: 'statusBar.guide.point',
  line: 'statusBar.guide.line',
  arc: 'statusBar.guide.arc',
  pointArray: 'statusBar.guide.pointArray',
  face: 'statusBar.guide.face',
  extrude: 'statusBar.guide.extrude',
  revolve: 'statusBar.guide.revolve',
  sew: 'statusBar.guide.sew',
  // P3 タスク24 が SolidToolId へ足した加工6種+ばね。案内文はタスク18 で ja.json に
  // 追加済み(statusBar.guide.*)なので、そのまま割り当てる(本実装、暫定ではない)。
  hole: 'statusBar.guide.hole',
  threadHole: 'statusBar.guide.threadHole',
  fillet: 'statusBar.guide.fillet',
  chamfer: 'statusBar.guide.chamfer',
  linearPattern: 'statusBar.guide.linearPattern',
  circularPattern: 'statusBar.guide.circularPattern',
  spring: 'statusBar.guide.spring',
  // P4 タスク11 が `ShapeToolId`(`NumericInputToolId` の一部)へ足した新しい図形
  // (FR-314〜318、FR-326)。この表は網羅が要るので、段を足した同じタスクで案内も足す
  // (P3 タスク24 で `Record<NumericInputToolId>` が非網羅になった前例、
  //  docs/報告記録.md 2026-09-04 03:20 ③)。ツールバーのボタンはタスク32。
  circle: 'statusBar.guide.circle',
  twoPointArc: 'statusBar.guide.twoPointArc',
  // P4 タスク36(2026-09-04 追加要件)が `ShapeToolId` へ足した 3 点の円弧(FR-330)。
  threePointArc: 'statusBar.guide.threePointArc',
  rectangle: 'statusBar.guide.rectangle',
  polygon: 'statusBar.guide.polygon',
  slot: 'statusBar.guide.slot',
  ellipse: 'statusBar.guide.ellipse',
  spline: 'statusBar.guide.spline',
  // P4 タスク13 が `ReferenceToolId` へ足した基準ジオメトリ(FR-328、FR-329)。
  // 上と同じ理由で、道具を足した同じタスクで案内も足す。
  referencePlaneThreePoints: 'statusBar.guide.referencePlaneThreePoints',
  referencePlaneOffset: 'statusBar.guide.referencePlaneOffset',
  referencePlaneTilted: 'statusBar.guide.referencePlaneTilted',
  referencePlaneThroughPoint: 'statusBar.guide.referencePlaneThroughPoint',
  referenceAxis: 'statusBar.guide.referenceAxis',
  referencePoint: 'statusBar.guide.referencePoint',
  referenceCoordinateSystem: 'statusBar.guide.referenceCoordinateSystem',
  // P4 タスク21 が `EditToolId`(`NumericInputToolId` の一部)へ足した整形系の道具
  // (FR-321)。上と同じ理由で、道具を足した同じタスクで案内も足す。
  offset: 'statusBar.guide.offset',
  // P4 タスク22 が `ClickEditToolId` へ足したトリム・延長(FR-322)。数値を聞かず
  // ビューポートを押して決める道具なので、案内は「どこを押すか」を伝える文にしてある
  // (§0.a-0.26 の利用者の決定、NFR-UX-7)。
  trim: 'statusBar.guide.trim',
  extend: 'statusBar.guide.extend',
  // P4 タスク24 が `EditToolId` へ足した複製系(FR-324)。上と同じ理由で、道具を足した
  // 同じタスクで案内も足す。どれも「先に選んでから道具を押す」道具なので、その順を伝える。
  mirror: 'statusBar.guide.mirror',
  copy: 'statusBar.guide.copy',
  linearArray: 'statusBar.guide.linearArray',
  circularArray: 'statusBar.guide.circularArray',
  // P4 タスク23 が `EditToolId` へ足した角の丸め・面取り(FR-323)。「選んでから」でも
  // 「道具を選んでから角をクリック」でも成立する道具なので、案内は後者(何も選んでいない
  // ときの次の一手)を書く(§0.a-0.26 のトリムと同じ考え方、NFR-UX-7)。
  sketchFillet: 'statusBar.guide.sketchFillet',
  sketchChamfer: 'statusBar.guide.sketchChamfer',
  // P4 タスク27 が `PickEditToolId` へ足した投影・断面(FR-325)。数値を聞かず、立体の
  // 面・辺・立体そのものを押して決める道具なので、案内は「何を押すか」と「順序の制約」
  // (このスケッチを使う立体より前の立体だけ)を伝える文にしてある(§0.a-0.11、NFR-UX-7)。
  projectedCurve: 'statusBar.guide.projectedCurve',
  planeSection: 'statusBar.guide.planeSection',
} as const satisfies Record<NumericInputToolId, MessageKey>;

/**
 * 選択の種類の札(§0.a-0.6)。頂点/辺/面/立体のどれを選ぶ状態かを常にステータスバーへ出す。
 * `1`〜`4` キーで切り替えられること(`selection.kindHint`)は `StatusBar.tsx` がツールチップで
 * 添える。
 */
const SELECTION_KIND_LABEL_KEYS = {
  vertex: 'selection.kind.vertex',
  edge: 'selection.kind.edge',
  face: 'selection.kind.face',
  body: 'selection.kind.body',
} as const satisfies Record<SelectionKind, MessageKey>;

/** いま何に吸い付いているかの案内(FR-107、NFR-UX-7)。 */
const SNAP_GUIDE_KEYS = {
  endpoint: 'statusBar.snap.endpoint',
  intersection: 'statusBar.snap.intersection',
  midpoint: 'statusBar.snap.midpoint',
  center: 'statusBar.snap.center',
  grid: 'statusBar.snap.grid',
  /*
   * 向きの吸着(FR-110、P4b タスク16)。角度や要素の名前が分かるときは下の
   * `trackGuideText` の詳しい文言が先に選ばれるので、ここはその材料が無いときの後退先。
   * この表は網羅が要る(`satisfies Record<SnapKind, …>`)ので、種別を足した同じタスクで
   * 案内も足す(P3 タスク24 で網羅が崩れた前例、docs/報告記録.md 2026-09-04 03:20 ③)。
   */
  polar: 'statusBar.snap.polar',
  extension: 'statusBar.snap.extension',
  perpendicular: 'statusBar.snap.perpendicular',
  parallel: 'statusBar.snap.parallel',
} as const satisfies Record<SnapKind, MessageKey>;

/** 向きの吸着の案内(FR-110、NFR-UX-7)。極は角度、他はもとの要素の名前を差し込む。 */
const TRACK_GUIDE_KEYS = {
  polar: 'statusBar.track.polar',
  extension: 'statusBar.track.extension',
  perpendicular: 'statusBar.track.perpendicular',
  parallel: 'statusBar.track.parallel',
} as const satisfies Record<TrackKind, MessageKey>;

/** 頭の言葉と本文をつなぐ空白。文字そのものは言葉に依らないのでここに置く。 */
const PREFIX_SEPARATOR = ' ';

/** 和・差・積が押せる状態になる立体の数(§0.a-0.6)。 */
const BOOLEAN_READY_BODY_COUNT = 2;

/**
 * 文言の差し込み。`t` は差し込みを持たないので、`{name}` をここで埋める。
 * 件数や段の番号のまわりの言葉(助詞・括弧)まで `ja.json` に置けるようにするため
 * (NFR-MA-5「UI 文字列はすべてリソースファイルに分離する」)。
 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  let text = template;
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{${name}}`).join(value);
  }
  return text;
}

/** 帯の 1 文が何を伝えているか。印と色をこれで決める。 */
export type StatusLineKind =
  /** 失敗と断り。帯を赤くする(FR-504)。 */
  | 'failure'
  /** 計算を中止した知らせ。失敗ではないので赤くしない(NFR-PF-4)。 */
  | 'cancelled'
  /** 何段目を計算しているか。細い帯と「中止」を添える(NFR-PF-4)。 */
  | 'progress'
  /** 保存できたなどの短い知らせ(FR-806)。 */
  | 'saved'
  /** 進み具合がまだ分からない計算中。 */
  | 'computing'
  /** いま吸い付いている先の案内(FR-107)。 */
  | 'snap'
  /** 道具ごとの次の一手(FR-905)。 */
  | 'guide';

/** 進み具合の細い帯に出す値(NFR-PF-4)。 */
export interface StatusProgressView {
  /** いま何段目を計算しているか。画面には 1 から数えて出す。 */
  readonly done: number;
  /** 段の総数。 */
  readonly total: number;
  /** 0〜1 に収めた割合。総数が 0 以下なら 0。 */
  readonly ratio: number;
}

/** 帯に出すもの一式。`StatusBar.tsx` はこれを描くだけにする。 */
export interface StatusLine {
  readonly kind: StatusLineKind;
  /** 帯に出す 1 文。頭の言葉まで既につないである。 */
  readonly text: string;
  /** 添える一言(ツールチップや薄い字)。無ければ null。 */
  readonly hint: string | null;
  /** 細い帯の値。`kind` が `'progress'` のときだけ入る。 */
  readonly progress: StatusProgressView | null;
  /**
   * 選択の種類の札の文言(§0.a-0.6)。優先順位のどの1文を選んでいても常に出すので、
   * 上の `kind` / `text` とは独立に持つ(`[ファイル名] [状況の1文] [spacer] [選ぶもの]
   * [作図面] [吸着] [単位]` の並び、`docs/報告記録.md` 2026-09-03 18:30 の残件(f))。
   */
  readonly selectionKindLabel: string;
  /**
   * つまみが末尾でないことの札(FR-507、NFR-UX-7。P4b タスク19)。末尾なら null。
   *
   * `selectionKindLabel` と同じく、優先順位のどの 1 文を選んでいても**常に出す**。
   * 帯の 1 文は 1 つしか出せないので、失敗や吸着の案内に押しのけられて
   * 「戻したままなのに何も出ていない」状態にならないよう、独立した札にしてある。
   */
  readonly rollbackLabel: string | null;
}

/** 帯に出す、いま合っている向き 1 本ぶん(FR-110、P4b タスク16)。 */
export interface TrackStatus {
  readonly kind: TrackKind;
  /** 極(角度)のときの角度(度)。他の種類は null。 */
  readonly angleDegrees: number | null;
  /** もとになった要素の名前(「線分1」)。極や、名前を引けないときは null。 */
  readonly sourceName: string | null;
}

/**
 * 向きの吸着の案内(FR-110、NFR-UX-7)。「15° に合わせています」「線分1 の延長線」。
 * 2 本の案内線が交わる点に合っているときは両方を並べて出す(§2.4 の交点)。
 * 合っている向きが無ければ null を返し、呼び出し側は点の吸着・道具の案内へ後退する。
 */
export function trackGuideText(tracks: readonly TrackStatus[]): string | null {
  if (tracks.length === 0) {
    return null;
  }
  const phrases = tracks.map((track) =>
    fill(t(TRACK_GUIDE_KEYS[track.kind]), {
      angle: track.angleDegrees === null ? '' : String(track.angleDegrees),
      // 名前を引けないとき(消えた要素を指したまま)でも文が崩れないようにする。
      name: track.sourceName ?? t('statusBar.track.unnamedSource'),
    }),
  );
  return `${phrases.join(t('statusBar.track.separator'))}${t('statusBar.track.suffix')}`;
}

/**
 * コマンドラインの断り 1 つぶん(FR-208、P4b タスク18)。`commandLineActions.ts` の
 * `CommandLineFailure` と同じ形だが、`statusText.ts` は画面側の一番下の層(純関数だけ)
 * なので、上の層の型に依存しないよう同じ欄をここに持つ。
 */
export interface CommandLineFailureView {
  readonly message: string;
  /** 「もしかして」の候補。無ければ空配列。 */
  readonly suggestions: readonly string[];
}

/**
 * コマンドラインの断りの 1 文(FR-208、FR-204 と同じ流儀)。
 * 打ち間違いの候補があれば「もしかして: l、c」と添える(NFR-UX-5)。
 */
export function commandLineFailureText(failure: CommandLineFailureView): string {
  if (failure.suggestions.length === 0) {
    return failure.message;
  }
  const listed = failure.suggestions.join(t('statusBar.track.separator'));
  return `${failure.message}${PREFIX_SEPARATOR}${t('commandLine.errorSuggestions')}${PREFIX_SEPARATOR}${listed}`;
}

/** ばねのその場入力の段(§2.11)。`numericInput.ts` の `SolidNumericInputStep` の部分集合。 */
export type SpringNumericInputStep = 'springShape' | 'springLength';

/** 帯に出す 1 文を選ぶのに要るもの。すべてストアから読める値。 */
export interface StatusInput {
  /** ファイル操作の知らせ(FR-806)。失敗は最優先、成功は案内より優先。 */
  readonly fileMessage: FileMessage | null;
  /** 面を張れなかった理由(FR-309)。 */
  readonly faceErrorKey: MessageKey | null;
  /** 立体を作れなかった理由(FR-401〜404)。 */
  readonly solidErrorKey: MessageKey | null;
  /**
   * 整形系の道具(オフセット等)を作れなかった理由(FR-321、P4 タスク21)。`shapeErrorMessage`
   * と同じく省略できるようにしてあるのは、この欄を持たない既存の呼び出し(検査)を
   * そのまま通すため。
   */
  readonly editErrorKey?: MessageKey | null;
  /**
   * 整形系の道具が**うまくいったときに添える案内**(FR-323、P4 タスク23)。断りではないので
   * 帯を赤くせず、「保存しました」等と同じ短い知らせとして出す。いまの使い道は 1 つで、
   * 角を丸めた 2 本を境界に使っている面があったときの「面の境界に足した曲線を入れ直して
   * ください」(t18 の申し送り)。省略できるようにしてあるのは、この欄を持たない既存の
   * 呼び出し(検査)をそのまま通すため。
   */
  readonly editNoticeKey?: MessageKey | null;
  /**
   * 図形を作れなかった理由(FR-314〜318、FR-326、P4 タスク12)。限界値(点の数・半径)を
   * 差し込んだ文になるので、文言キーではなく組み立て済みの文で受け取る。
   * 省略できるようにしてあるのは、この欄を持たない既存の呼び出し(検査)をそのまま通すため。
   */
  readonly shapeErrorMessage?: string | null;
  /**
   * 基準ジオメトリ(作業平面・基準軸・基準点・座標系)を作れなかった理由
   * (FR-328、FR-329、P4 タスク13)。`shapeErrorMessage` と同じ扱いで、選んでいるものが
   * 足りないときの案内を差し込んだ文になるので文言キーではなく組み立て済みの文で受け取る。
   */
  readonly referenceErrorMessage?: string | null;
  /**
   * コマンドラインで打った 1 行を受け取れなかった理由(FR-208、P4b タスク18)。
   * いま押した Enter への返事なので、他の断りと同じ高さの優先順位に置く(NFR-UX-5)。
   * 省略できるようにしてあるのは、この欄を持たない既存の呼び出し(検査)をそのまま通すため。
   */
  readonly commandLineFailure?: CommandLineFailureView | null;
  /**
   * 原点を移したときの一言(FR-331、P4 タスク35b)。`editNoticeKey` と同じ「うまくいった
   * ときの知らせ」だが、もとの原点の座標の式を差し込んだ文になるので組み立て済みの文で
   * 受け取る。省略できるようにしてあるのは、この欄を持たない既存の呼び出し(検査)を
   * そのまま通すため。
   */
  readonly originNoticeMessage?: string | null;
  /**
   * タイムラインのつまみが末尾でないときの位置(FR-507、P4b タスク19)。末尾なら null。
   * 省略できるようにしてあるのは、この欄を持たない既存の呼び出し(検査)をそのまま通すため。
   */
  readonly rollback?: TimelineRollback | null;
  /**
   * つまみについての知らせ(P4b タスク19)。断りではないので赤くしない。いまの使い道は
   * 1 つで、途中まで戻したまま新しいものを作ったときの「最後まで戻しました」。
   * `editNoticeKey` と同じ扱い(省略できるのも同じ理由)。
   */
  readonly timelineNoticeKey?: MessageKey | null;
  /**
   * 順序の入れ替えを断った理由(FR-507、FR-504。P4b タスク20)。断らなかったときは null。
   * 相手のフィーチャーの名前が入る文なので、文言キーではなく組み立て済みの文で受け取る
   * (`shapeErrorMessage` と同じ扱い。省略できるのも同じ理由)。
   */
  readonly timelineRefusalMessage?: string | null;
  /** 再計算そのものが投げた理由。 */
  readonly errorMessage: string | null;
  /** 部品まるごとの再計算で集めた失敗(FR-504)。 */
  readonly partErrors: readonly PartRecomputeError[];
  /** いま編集しているスケッチの失敗(FR-504)。 */
  readonly sketchErrors: readonly SketchError[];
  /** 直前の計算が中止で終わったか(NFR-PF-4)。 */
  readonly cancelled: boolean;
  /**
   * 出してよいと決まった進み具合(NFR-PF-4)。届いてすぐは出さない決まりなので、
   * 待ち時間(`PROGRESS_DELAY_MS`)の判定は呼び出し側(`StatusBar.tsx`)が行い、
   * まだ出さないあいだは null を渡す。
   */
  readonly progress: PartProgress | null;
  /** 再計算の最中か。 */
  readonly isComputing: boolean;
  /**
   * 幾何カーネルを読み込み終えたか(§0.a-0.23 ⑨)。初回の計算中だけ文言を分けるので、
   * `isComputing` と組み合わせて使う。
   */
  readonly kernelLoaded: boolean;
  /** いま吸い付いている先。無ければ null(FR-107)。 */
  readonly snapKind: SnapKind | null;
  /**
   * いま合っている向き(FR-110、P4b タスク16)。案内線が 2 本出ているときは 2 件入る。
   * 省略できるようにしてあるのは、この欄を持たない既存の呼び出し(検査)をそのまま通すため。
   */
  readonly track?: readonly TrackStatus[] | null;
  /** 選んでいる道具(FR-301〜309、FR-401〜403)。 */
  readonly activeTool: NumericInputToolId;
  /** いま選ばれている立体の数(FR-404 の対象指定)。 */
  readonly selectedBodyCount: number;
  /**
   * 選んでいる部分形状の数(§0.a-0.6)。道具に応じた種類(穴・ねじ穴なら面、R/C 面取りなら
   * 辺)だけを数えた値を渡す。立体を選ぶ道具のときは常に 0 でよい(`machiningGuideText` が
   * 使わない)。数える関数は `countSelectedSubShapes`。
   */
  readonly selectedSubShapeCount: number;
  /** 選択の種類の札(頂点/辺/面/立体、§0.a-0.6)。いまストアが持っている値をそのまま渡す。 */
  readonly selectionKind: SelectionKind;
  /**
   * ばねの始点にする点フィーチャーが選ばれているか(§0.a-0.29、仕上げ (d))。
   * ばねは対象が立体でも部分形状でもなくスケッチの点なので、`selectedBodyCount` /
   * `selectedSubShapeCount` では判定できない(いずれも数えない)。ツールバーの「ばね」
   * ボタンの押せる条件と同じ `solidToolReadiness(document, selection, 'spring').ready`
   * で判定した値を呼び出し側(`StatusBar.tsx`)が渡す(同じ判断を2か所に書かない)。
   */
  readonly springOriginSelected: boolean;
  /**
   * いま開いているその場入力がばねの何段目か(§2.11「ばねの2段」)。ポップアップが
   * 開いていない、または他の道具のポップアップのときは null。`activeTool !== 'spring'`
   * のときは呼び出し側が常に null を渡してよい(`machiningGuideText` が見るのは
   * `activeTool === 'spring'` のときだけ)。
   */
  readonly springStep: SpringNumericInputStep | null;
  /**
   * いまの作図面の id(FR-328、FR-330、タスク14)。3D スケッチ(作図面なし)のときだけ、
   * 道具ごとの案内へ「立体の頂点を押すと点になる」という一言を添えるのに使う(NFR-UX-7)。
   * 省略できるようにしてあるのは、この欄を持たない既存の呼び出し(検査)をそのまま通すため。
   */
  readonly workPlaneId?: WorkPlaneId;
}

/** 選択のうち、いま画面にある立体を指しているものの数(§0.a-0.5、FR-404)。 */
export function countSelectedBodies(
  selection: readonly string[],
  liveBodyIds: readonly string[],
): number {
  const live = new Set(liveBodyIds);
  return selection.filter((id) => live.has(id)).length;
}

/**
 * 選択のうち、指定した種類の部分形状(面・辺・頂点)の数(§0.a-0.6)。
 * `countSelectedBodies`(立体版)と同じ作り。`StatusBar.tsx` が道具に応じた種類を渡す。
 */
export function countSelectedSubShapes(
  selection: readonly string[],
  kind: SubShapeKind,
): number {
  return selection.filter((id) => parseSubShapeId(id)?.kind === kind).length;
}

/** 選択の種類の札の文言(§0.a-0.6)。「選ぶもの 面」のように出す。 */
function selectionKindText(kind: SelectionKind): string {
  return `${t('selection.kindLabel')}${PREFIX_SEPARATOR}${t(SELECTION_KIND_LABEL_KEYS[kind])}`;
}

/**
 * つまみが末尾でないことの札(FR-507、NFR-UX-7。P4b タスク19)。
 * 「途中まで戻しています(3 件目 / 5 件)」。末尾なら null で、札そのものを出さない。
 */
export function rollbackText(rollback: TimelineRollback | null | undefined): string | null {
  if (rollback === undefined || rollback === null) {
    return null;
  }
  return fill(t('timeline.rollback'), {
    position: String(rollback.position),
    total: String(rollback.total),
  });
}

/**
 * ばねの段階的な案内(§0.a-0.6、§0.a-0.29、仕上げ (d))。「ばね」ボタンを押した後、
 * 段が進むにつれて案内を更新する。文言は `packages/help-content/docs/ja/spring.md` の手順と
 * `numericInput.ts` の段名(`springShape` = 「ばねの形を決める」、`springLength` = 「ばねの
 * 長さを決める」)に揃える。
 *
 * - 始点の点がまだ選ばれていなければ null を返し、呼び出し側は道具の基本案内
 *   (`guideKeyFor` → `statusBar.guide.spring`「ばねの始点にする点を選んでください。」)へ
 *   後退する。
 * - 始点の点が選ばれていれば、ポップアップが実際に開いているかによらず「コイル径と線径を」
 *   促す(直線/円形パターンの `linearPatternReady` / `circularPatternReady` と同じ
 *   「選択が整ったら伝える」流儀。ポップアップは「ばね」を押した時点で開くので、この文言は
 *   ポップアップを開く前の後押しにも、開いた後の入力の促しにも使える)。
 * - その場入力が2段目(`springLength`)まで進んだら、「ピッチと巻数(全長)を」促す文言に
 *   替える。`derived` によって実際に出る2つの欄は変わる(§0.a-0.30)ので、3つの量をまとめて
 *   案内し、どれが出ていても通じるようにする。
 */
export function springGuideText(
  originSelected: boolean,
  step: SpringNumericInputStep | null,
): string | null {
  if (step === 'springLength') {
    return t('statusBar.guide.springLengthReady');
  }
  return originSelected ? t('statusBar.guide.springShapeReady') : null;
}

/**
 * 加工の道具(穴・ねじ穴・R 面取り・C 面取り・直線/円形パターン・ばね)で、選択が進むにつれて
 * 案内を更新する(§0.a-0.6「選択の数を案内に出す」、P3 タスク29 でパターンの段、
 * 仕上げ (d) でばねの段を追加)。その道具にとって何も選ばれていなければ null を返し、
 * 呼び出し側は道具の基本案内(`guideKeyFor`)へ後退する。
 *
 * - 穴・ねじ穴: 面を 1 つ以上選んだら「中心にする点を選んでください。」に進む(面を選ぶまでは
 *   基本案内が「面と点の両方を」とまとめて伝えている)。
 * - R/C 面取り: 辺を選ぶたびに「辺を N 本選んでいます。」で選んだ数を伝える(P2 の
 *   `statusBar.guide.booleanReady` と同じ「選択が進んだら具体的に伝える」考え方)。
 * - 直線/円形パターン: 並べる穴・ねじ穴は部分形状ではなく立体そのものを選ぶ道具
 *   (`selectionKind` が `'body'` のまま、machiningCommands.ts の `selectedPatternSource` と
 *   同じ判定材料)なので、`selectedSubShapeCount` ではなく `selectedBodyCount` で進み具合を見る。
 *   1 つも選んでいなければ基本案内「並べる穴を選んでください。」のまま、選んでいれば
 *   直線は「向きと間隔、個数を」、円形は「軸と角度、個数を」入れるよう促す。
 * - ばね: 始点の点はスケッチの点フィーチャーで、立体でも部分形状でもない
 *   (`selectionKindForTool('spring')` は `'body'` のまま変わらない)ので、
 *   `selectedSubShapeCount` / `selectedBodyCount` のどちらでも進み具合を判定できない。
 *   代わりに `springOriginSelected` / `springStep` を見る(`springGuideText`)。
 */
export function machiningGuideText(
  activeTool: NumericInputToolId,
  selectedSubShapeCount: number,
  selectedBodyCount = 0,
  springOriginSelected = false,
  springStep: SpringNumericInputStep | null = null,
): string | null {
  switch (activeTool) {
    case 'hole':
    case 'threadHole':
      return selectedSubShapeCount <= 0 ? null : t('statusBar.guide.centerPoint');
    case 'fillet':
    case 'chamfer':
      return selectedSubShapeCount <= 0
        ? null
        : fill(t('statusBar.guide.edgesSelected'), { count: String(selectedSubShapeCount) });
    case 'linearPattern':
      return selectedBodyCount <= 0 ? null : t('statusBar.guide.linearPatternReady');
    case 'circularPattern':
      return selectedBodyCount <= 0 ? null : t('statusBar.guide.circularPatternReady');
    case 'spring':
      return springGuideText(springOriginSelected, springStep);
    default:
      return null;
  }
}

/**
 * 選択の道具のときの案内(FR-905、NFR-UX-7)。
 *
 * 立体を 1 つだけ選んでいるなら、次にすることは「組み合わせる相手を選ぶ」なので
 * ブーリアンの案内(`statusBar.guide.boolean`)を出す。ちょうど 2 つ選べていれば
 * 和・差・積が押せると伝える。3 つ以上は 2 つに絞ってもらう必要があるので
 * 1 つのときと同じ案内へ戻す(§0.a-0.6「ちょうど 2 つ」)。
 */
export function guideKeyFor(
  activeTool: NumericInputToolId,
  selectedBodyCount: number,
): MessageKey {
  if (activeTool === 'select' && selectedBodyCount >= 1) {
    return selectedBodyCount === BOOLEAN_READY_BODY_COUNT
      ? 'statusBar.guide.booleanReady'
      : 'statusBar.guide.boolean';
  }
  return GUIDE_KEYS[activeTool];
}

/** 「押し出し1 を計算しています(3/12)」の 1 文(NFR-PF-4)。 */
export function progressText(progress: PartProgress): string {
  const view = progressView(progress);
  return fill(t('statusBar.progressDetail'), {
    label: progress.label,
    done: String(view.done),
    total: String(view.total),
  });
}

/**
 * 細い帯に出す値(NFR-PF-4)。`index` は 0 から始まるので画面には +1 して出す。
 * 総数を超えた値が来ても帯がはみ出さないよう、0〜1 に収める。
 */
export function progressView(progress: PartProgress): StatusProgressView {
  const total = Math.max(progress.total, 0);
  const done = Math.min(Math.max(progress.index + 1, 0), Math.max(total, 1));
  return { done, total, ratio: total <= 0 ? 0 : Math.min(done / total, 1) };
}

/**
 * 計算の失敗をひとまとめにする(FR-504)。件数と先頭の理由だけを出す。
 *
 * 部品まるごとの失敗(`partErrors`)にはスケッチ側の失敗も入っているので、
 * それがあるときはそちらだけを数える。両方足すと同じ失敗を二重に数えてしまう。
 * 1 件のときは件数を出さない(「1 件」とわざわざ言う必要がないため)。
 */
export function summarizeFailures(
  partErrors: readonly PartRecomputeError[],
  sketchErrors: readonly SketchError[],
): string | null {
  const errors = partErrors.length > 0 ? partErrors : sketchErrors;
  if (errors.length === 0) {
    return null;
  }
  const first = errors[0];
  const prefix =
    errors.length === 1
      ? t('statusBar.error')
      : fill(t('statusBar.errorSummary'), { count: String(errors.length) });
  return `${prefix}${PREFIX_SEPARATOR}${first.message}`;
}

/** 頭の言葉と本文をつないだ 1 文にする。頭の言葉が要らないものはそのまま。 */
function withPrefix(prefixKey: MessageKey | null, text: string): string {
  return prefixKey === null ? text : `${t(prefixKey)}${PREFIX_SEPARATOR}${text}`;
}

/** `describeStatus` の本体が組み立てる値。選択の種類の札(`selectionKindLabel`)と
 * つまみの札(`rollbackLabel`)は優先順位のどれを選んでも常に添えるものなので、
 * ここには含めず呼び出し側で足す。 */
type StatusLineWithoutSelectionKind = Omit<StatusLine, 'selectionKindLabel' | 'rollbackLabel'>;

function failureLine(prefixKey: MessageKey | null, text: string): StatusLineWithoutSelectionKind {
  return { kind: 'failure', text: withPrefix(prefixKey, text), hint: null, progress: null };
}

/**
 * 帯に出す 1 文を決める(FR-905)。優先順位は上から順に次のとおり。
 *
 * 1. ファイル操作の失敗 … いま押したボタンへの返事。理由の文だけで通じるので頭の言葉は付けない。
 * 2. 面・立体・整形系(オフセット等)・図形を作れなかった断り、順序の入れ替えの断り
 *    (FR-507、タスク20)… これもいま押した Enter やボタン、いま離したドラッグへの返事
 *    (NFR-UX-5)。
 * 3. 計算の失敗 … 再計算が投げた理由、続いて集まった失敗の件数と先頭の理由(FR-504)。
 * 4. 中止の知らせ … 失敗ではないので赤くしない(NFR-PF-4)。
 * 5. 進み具合 … 長い計算のあいだだけ(NFR-PF-4)。
 * 5.5. 整形系の道具がうまくいったときの案内(FR-323。赤くしない)。
 * 5.6. 原点を移したときの一言(FR-331。赤くしない)。
 * 6. 保存できたなどの知らせ(FR-806)。
 * 7. 案内 … 計算中の札、吸着の案内、加工の選択が進んだ具合、道具ごとの次の一手。
 *
 * 選択の種類の札(`selectionKindLabel`)は、この優先順位のどれを選んでいても常に出す
 * (`[選ぶもの]` の札は状況の1文と独立、§0.a-0.6)ので、内側の `resolveLine` には含めず
 * ここで一度だけ足す。
 */
export function describeStatus(input: StatusInput): StatusLine {
  return {
    ...resolveLine(input),
    selectionKindLabel: selectionKindText(input.selectionKind),
    // つまみの札も 1 文とは独立に常に添える(FR-507、タスク19)。
    rollbackLabel: rollbackText(input.rollback),
  };
}

function resolveLine(input: StatusInput): StatusLineWithoutSelectionKind {
  if (input.fileMessage !== null && input.fileMessage.failed) {
    return failureLine(null, t(input.fileMessage.key));
  }
  if (input.faceErrorKey !== null) {
    return failureLine('statusBar.faceError', t(input.faceErrorKey));
  }
  if (input.solidErrorKey !== null) {
    return failureLine('statusBar.solidError', t(input.solidErrorKey));
  }
  if (input.editErrorKey !== undefined && input.editErrorKey !== null) {
    return failureLine('statusBar.editError', t(input.editErrorKey));
  }
  if (input.shapeErrorMessage !== undefined && input.shapeErrorMessage !== null) {
    return failureLine('statusBar.shapeError', input.shapeErrorMessage);
  }
  if (input.referenceErrorMessage !== undefined && input.referenceErrorMessage !== null) {
    return failureLine('statusBar.referenceError', input.referenceErrorMessage);
  }
  if (input.timelineRefusalMessage !== undefined && input.timelineRefusalMessage !== null) {
    // 順序の入れ替えの断り(FR-507、タスク20)。いま離したドラッグへの返事なので、
    // 他の断りと同じ高さに置く。理由の文は model が相手の名前つきで組み立てたものをそのまま出す。
    return failureLine('statusBar.timelineError', input.timelineRefusalMessage);
  }
  if (input.commandLineFailure !== undefined && input.commandLineFailure !== null) {
    // コマンドラインで打った 1 行への返事(FR-208)。他の断りと同じ扱いで、頭に「コマンド:」を付ける。
    return failureLine('commandLine.error', commandLineFailureText(input.commandLineFailure));
  }
  if (input.errorMessage !== null) {
    return failureLine('statusBar.error', input.errorMessage);
  }
  const failures = summarizeFailures(input.partErrors, input.sketchErrors);
  if (failures !== null) {
    return { kind: 'failure', text: failures, hint: null, progress: null };
  }
  if (input.cancelled) {
    return { kind: 'cancelled', text: t('statusBar.cancelled'), hint: null, progress: null };
  }
  if (input.progress !== null) {
    return {
      kind: 'progress',
      text: progressText(input.progress),
      // 中止は段と段の間でしか効かない(§2.6 の限界)。押しても止まらないように
      // 見えるのを避けるため、待たされることがあると先に伝えておく。
      hint: t('statusBar.progressHint'),
      progress: progressView(input.progress),
    };
  }
  if (input.editNoticeKey !== undefined && input.editNoticeKey !== null) {
    // 断りではないので赤くしない(FR-323 の「面の境界を入れ直してください」の案内)。
    return { kind: 'saved', text: t(input.editNoticeKey), hint: null, progress: null };
  }
  if (input.originNoticeMessage !== undefined && input.originNoticeMessage !== null) {
    // 原点を移したときの一言(FR-331)。これも断りではないので赤くしない。
    return { kind: 'saved', text: input.originNoticeMessage, hint: null, progress: null };
  }
  if (input.timelineNoticeKey !== undefined && input.timelineNoticeKey !== null) {
    // つまみを末尾へ戻したことの知らせ(FR-507、タスク19)。断りではないので赤くしない。
    return { kind: 'saved', text: t(input.timelineNoticeKey), hint: null, progress: null };
  }
  if (input.fileMessage !== null) {
    return { kind: 'saved', text: t(input.fileMessage.key), hint: null, progress: null };
  }
  if (input.isComputing) {
    // 初回の計算だけ、幾何カーネル(約 50MB)の読み込みを含む旨に文言を分ける
    // (§0.a-0.23 ⑨。実測で初回は 3〜7 秒かかり、固まったように見えるため)。
    const key = input.kernelLoaded ? 'statusBar.loading' : 'statusBar.loadingKernel';
    return { kind: 'computing', text: t(key), hint: null, progress: null };
  }
  /*
    向きの吸着(FR-110)は点の吸着と同じ「いま合っている先」の知らせだが、角度や
    もとの要素の名前まで言えるので、材料があるときはそちらを先に出す(NFR-UX-7)。
  */
  const trackText =
    input.track === undefined || input.track === null ? null : trackGuideText(input.track);
  if (trackText !== null) {
    return { kind: 'snap', text: trackText, hint: null, progress: null };
  }
  if (input.snapKind !== null) {
    return {
      kind: 'snap',
      text: t(SNAP_GUIDE_KEYS[input.snapKind]),
      hint: null,
      progress: null,
    };
  }
  // 加工の道具は、部分形状(またはパターンなら立体、ばねなら始点の点)を選ぶにつれて
  // 具体的な案内へ進める(§0.a-0.6)。何も選んでいなければ null が返り、道具の基本案内
  // (guideKeyFor)へ後退する。
  const machiningText = machiningGuideText(
    input.activeTool,
    input.selectedSubShapeCount,
    input.selectedBodyCount,
    input.springOriginSelected,
    input.springStep,
  );
  return {
    kind: 'guide',
    text: machiningText ?? t(guideKeyFor(input.activeTool, input.selectedBodyCount)),
    // 3D スケッチ(FR-330、タスク14)では、道具の案内に「立体の頂点を押すと、その頂点に
    // 付く点ができる」ことを添える。3D スケッチにしかない入り口で、押せることが画面から
    // だけでは分からないため(NFR-UX-7)。
    hint: freeSketchHint(input.workPlaneId, input.activeTool),
    progress: null,
  };
}

/** 3D スケッチで、立体の頂点を押せる道具のときだけ添える一言。それ以外は null。 */
function freeSketchHint(
  workPlaneId: WorkPlaneId | undefined,
  activeTool: NumericInputToolId,
): string | null {
  if (workPlaneId === undefined || !isFreeWorkPlaneId(workPlaneId)) {
    return null;
  }
  return picksSolidVertices(workPlaneId, activeTool) ? t('statusBar.guide.freeSketch') : null;
}
