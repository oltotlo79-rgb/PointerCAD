/**
 * ステータスバーに出す 1 文の組み立て(計画書 docs/plans/P2-ソリッド基礎.md タスク25、
 * FR-504、FR-905、NFR-PF-4、NFR-UX-7)。
 *
 * 帯は 1 本しかないので、同時に言いたいことがあるときは**優先順位**で 1 つだけ選ぶ。
 * 選ぶ規則と文の組み立てをここへ純関数として置き、`StatusBar.tsx` は描くだけにする。
 * `.tsx` は Node の検査で描けないため(docs/報告記録.md 2026-09-02 23:09
 * 「操作の判断は純関数へ切り出して Node で検査する」)。
 */

import type { PartProgress, PartRecomputeError, SketchError } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import type { NumericInputToolId } from '../sketch/numericInput.js';
import type { SnapKind } from '../sketch/snapMath.js';
import { parseSubShapeId, type SelectionKind, type SubShapeKind } from '../solid/subShapeSelection.js';
import type { FileMessage } from '../store/useAppStore.js';

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
} as const satisfies Record<SnapKind, MessageKey>;

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
}

/** 帯に出す 1 文を選ぶのに要るもの。すべてストアから読める値。 */
export interface StatusInput {
  /** ファイル操作の知らせ(FR-806)。失敗は最優先、成功は案内より優先。 */
  readonly fileMessage: FileMessage | null;
  /** 面を張れなかった理由(FR-309)。 */
  readonly faceErrorKey: MessageKey | null;
  /** 立体を作れなかった理由(FR-401〜404)。 */
  readonly solidErrorKey: MessageKey | null;
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
 * 加工の道具(穴・ねじ穴・R 面取り・C 面取り・直線/円形パターン)で、選択が進むにつれて案内を
 * 更新する(§0.a-0.6「選択の数を案内に出す」、P3 タスク29 でパターンの段を追加)。
 * その道具にとって何も選ばれていなければ null を返し、呼び出し側は道具の基本案内
 * (`guideKeyFor`)へ後退する。
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
 */
export function machiningGuideText(
  activeTool: NumericInputToolId,
  selectedSubShapeCount: number,
  selectedBodyCount = 0,
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

/** `describeStatus` の本体が組み立てる値。選択の種類の札(`selectionKindLabel`)は
 * 優先順位のどれを選んでも常に添えるものなので、ここには含めず呼び出し側で足す。 */
type StatusLineWithoutSelectionKind = Omit<StatusLine, 'selectionKindLabel'>;

function failureLine(prefixKey: MessageKey | null, text: string): StatusLineWithoutSelectionKind {
  return { kind: 'failure', text: withPrefix(prefixKey, text), hint: null, progress: null };
}

/**
 * 帯に出す 1 文を決める(FR-905)。優先順位は上から順に次のとおり。
 *
 * 1. ファイル操作の失敗 … いま押したボタンへの返事。理由の文だけで通じるので頭の言葉は付けない。
 * 2. 面・立体を作れなかった断り … これもいま押した Enter やボタンへの返事(NFR-UX-5)。
 * 3. 計算の失敗 … 再計算が投げた理由、続いて集まった失敗の件数と先頭の理由(FR-504)。
 * 4. 中止の知らせ … 失敗ではないので赤くしない(NFR-PF-4)。
 * 5. 進み具合 … 長い計算のあいだだけ(NFR-PF-4)。
 * 6. 保存できたなどの知らせ(FR-806)。
 * 7. 案内 … 計算中の札、吸着の案内、加工の選択が進んだ具合、道具ごとの次の一手。
 *
 * 選択の種類の札(`selectionKindLabel`)は、この優先順位のどれを選んでいても常に出す
 * (`[選ぶもの]` の札は状況の1文と独立、§0.a-0.6)ので、内側の `resolveLine` には含めず
 * ここで一度だけ足す。
 */
export function describeStatus(input: StatusInput): StatusLine {
  return { ...resolveLine(input), selectionKindLabel: selectionKindText(input.selectionKind) };
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
  if (input.fileMessage !== null) {
    return { kind: 'saved', text: t(input.fileMessage.key), hint: null, progress: null };
  }
  if (input.isComputing) {
    // 初回の計算だけ、幾何カーネル(約 50MB)の読み込みを含む旨に文言を分ける
    // (§0.a-0.23 ⑨。実測で初回は 3〜7 秒かかり、固まったように見えるため)。
    const key = input.kernelLoaded ? 'statusBar.loading' : 'statusBar.loadingKernel';
    return { kind: 'computing', text: t(key), hint: null, progress: null };
  }
  if (input.snapKind !== null) {
    return {
      kind: 'snap',
      text: t(SNAP_GUIDE_KEYS[input.snapKind]),
      hint: null,
      progress: null,
    };
  }
  // 加工の道具は、部分形状(またはパターンなら立体)を選ぶにつれて具体的な案内へ進める
  // (§0.a-0.6)。何も選んでいなければ null が返り、道具の基本案内(guideKeyFor)へ後退する。
  const machiningText = machiningGuideText(
    input.activeTool,
    input.selectedSubShapeCount,
    input.selectedBodyCount,
  );
  return {
    kind: 'guide',
    text: machiningText ?? t(guideKeyFor(input.activeTool, input.selectedBodyCount)),
    hint: null,
    progress: null,
  };
}
