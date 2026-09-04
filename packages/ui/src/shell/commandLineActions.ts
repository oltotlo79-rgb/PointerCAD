/**
 * コマンドラインの欄が打った 1 行を、道具の切替・欄への流し込み・段の確定へつなぐ
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md タスク18、§0.a-0.8〜0.11、§2.5。FR-208)。
 *
 * ここには **DOM にも React にも触れない**処理だけを置き、`CommandLine.tsx` は
 * 見た目とキーの詰め替えだけを受け持つ(`docs/報告記録.md` 2026-09-02 23:09
 * 「操作の判断は純関数へ切り出して Node で検査する」)。ストアを読み書きするものと、
 * 完全な純関数(履歴・候補・案内)を 1 つのファイルへまとめてある。
 *
 * **打った値の行き先は 3 つ**(計画書 タスク18 の「実装内容」)。
 *   ①道具の語 → `setActiveTool` と、その道具の 1 段目を開く。
 *   ②座標・名前付きの欄 → **いま開いているその場入力の欄へ流し込んでから**確定する。
 *   ③空の Enter → いまの欄の値(空欄は既定値)のまま確定する(NFR-UX-4)。
 *
 * 確定はどれも `commitToStore.ts` の `applyNumericTransition` を通る。ポップアップの
 * Enter とまったく同じ道筋なので、どちらから打っても結果が変わらない(NFR-UX-1、§0.a-0.9)。
 */

import { isFreeWorkPlaneId, type CoordinateInput } from '@pointercad/model';

import { t } from '../i18n/t.js';
import { applyNumericTransition } from '../sketch/commitToStore.js';
import {
  parseCommandLine,
  suggestCommands,
  type CommandLineContext,
  type CommandToolId,
  type CommandWord,
} from '../sketch/commandLine.js';
import {
  applyNumericInputKey,
  asksCoordinate,
  createNumericInput,
  evaluateNumericInput,
  reduceNumericInput,
  SHAPE_TOOL_STEPS,
  type CoordinateMode,
  type NumericInputState,
  type NumericInputStep,
  type NumericInputToolId,
} from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';

/** さかのぼれる履歴の件数(§0.a-0.11)。**保存しない**ので、閉じると消える。 */
export const COMMAND_HISTORY_LIMIT = 20;

/** 候補として同時に見せる件数の上限(§0.a-0.11)。 */
export const COMMAND_SUGGESTION_LIMIT = 5;

/**
 * ビューポートの大きさがまだ分からないときに使う基準位置(画素)。
 * `Toolbar.tsx` の `FALLBACK_ANCHOR_PIXELS` と同じ値・同じ理由。
 */
const FALLBACK_ANCHOR_PIXELS = 160;

/**
 * コマンドラインから道具を打ったときに開く 1 段目。
 *
 * `null` は「道具に切り替えるだけで段は開かない」の意味。整形系(オフセット・ミラー・
 * 複写・配列・角の丸め/面取り)とトリム・延長は**先に対象を選ぶ**道具で、選択が無いまま
 * 段を開くと入れ場所の無い数値を聞くことになる(NFR-UX-5「実行してから失敗させない」)。
 * これらはコマンドラインでは道具の切替だけを行い、対象を選んでからツールバーの一覧で
 * 開いてもらう(タスク22 への申し送り)。
 *
 * 表は `Record<CommandToolId, …>` で持つので、`commandLine.ts` の `COMMAND_WORDS` へ
 * 道具を足したらここも足さないと型検査で落ちる(網羅が崩れない)。かき込む道具の 1 段目は
 * `SHAPE_TOOL_STEPS`(`numericInput.ts` が正本)を広げて使い、表を作り直さない。
 */
const COMMAND_FIRST_STEPS = {
  select: null,
  face: null,
  point: 'point',
  line: 'lineStart',
  arc: 'arcCenter',
  pointArray: 'pointArrayBase',
  ...SHAPE_TOOL_STEPS,
  offset: null,
  mirror: null,
  copy: null,
  linearArray: null,
  circularArray: null,
  sketchFillet: null,
  sketchChamfer: null,
  trim: null,
  extend: null,
} satisfies Record<CommandToolId, NumericInputStep | null>;

/**
 * 道具の語から 1 段目を引く。`COMMAND_WORDS` に無い道具(ソリッド等)は
 * `parseCommandLine` が返さないので、ここへは来ない(来ても段を開かないだけ)。
 */
function firstStepFor(tool: NumericInputToolId): NumericInputStep | null {
  const table: Readonly<Partial<Record<NumericInputToolId, NumericInputStep | null>>> =
    COMMAND_FIRST_STEPS;
  return table[tool] ?? null;
}

/** 打った 1 行を受け取れなかった理由(FR-204 と同じ流儀。帯へ出す)。 */
export interface CommandLineFailure {
  readonly message: string;
  /** 「もしかして」の候補。道具の名前の打ち間違いのときだけ入る。 */
  readonly suggestions: readonly string[];
}

/** 打った 1 行がどう扱われたか。画面(`CommandLine.tsx`)と検査が見る。 */
export type CommandLineSubmission =
  /** 道具を切り替えた。段が開いたかどうかは `openedStep` で分かる。 */
  | { readonly kind: 'tool'; readonly tool: NumericInputToolId; readonly openedStep: boolean }
  /** いま開いている段を確定した(欄への流し込みを含む)。 */
  | { readonly kind: 'committed' }
  | ({ readonly kind: 'error' } & CommandLineFailure);

function failed(message: string, suggestions: readonly string[] = []): CommandLineSubmission {
  return { kind: 'error', message, suggestions };
}

// ---------------------------------------------------------------------------
// 履歴(純関数。保存しない、§0.a-0.11)
// ---------------------------------------------------------------------------

/**
 * 打った 1 行を履歴の先頭へ積む。新しいものが添字 0 で、`↑` は 0 から順にさかのぼる。
 * 空行は積まない。直前とまったく同じ語は積み直さない(同じ語で埋め尽くさないため)。
 */
export function pushCommandHistory(
  history: readonly string[],
  text: string,
): readonly string[] {
  const trimmed = text.trim();
  if (trimmed === '' || history[0] === trimmed) {
    return history;
  }
  return [trimmed, ...history].slice(0, COMMAND_HISTORY_LIMIT);
}

/**
 * 履歴をたどった先の欄の中身と、たどっている位置。
 * `index` が -1 のときは「履歴に入っていない(いま打っている行)」を表す。
 */
export interface CommandHistoryStep {
  readonly index: number;
  readonly text: string;
}

/**
 * `↑`(`backwards` が true)`↓` で履歴を 1 件たどる。
 * 端では止まる(回り込まない)。いちばん新しいところから `↓` を押すと欄が空になる。
 */
export function stepCommandHistory(
  history: readonly string[],
  index: number,
  backwards: boolean,
): CommandHistoryStep {
  const next = backwards ? index + 1 : index - 1;
  if (next < 0) {
    return { index: -1, text: '' };
  }
  if (next >= history.length) {
    return { index, text: history[index] ?? '' };
  }
  return { index: next, text: history[next] };
}

// ---------------------------------------------------------------------------
// 候補と、次に打つものの案内(純関数)
// ---------------------------------------------------------------------------

/**
 * 打ちかけの語に前方一致する道具(最大 5 件、§0.a-0.11)。
 * 座標や名前付きの欄(`10,20` / `r=5`)を打ち始めたら候補は出さない(道具ではないため)。
 */
export function commandSuggestions(input: string): readonly CommandWord[] {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.includes('=') || trimmed.includes(',')) {
    return [];
  }
  return suggestCommands(trimmed, COMMAND_SUGGESTION_LIMIT);
}

/**
 * 候補を採った(`Tab`)ときに欄へ入れる語。
 *
 * **打ちかけの語と同じ書き方の語を優先する。** 「circ」まで打った人に「円」を入れると、
 * 打っていたものが消えて別の字に入れ替わったように見えるため(NFR-UX-1)。前方一致する
 * 語が無いとき(候補の一覧から直に選んだとき)は、いちばん短い語(短縮)を採る。
 */
export function acceptedWordOf(word: CommandWord, input = ''): string {
  const typed = input.trim().toLowerCase();
  const matched =
    typed === '' ? undefined : word.words.find((entry) => entry.toLowerCase().startsWith(typed));
  return (
    matched ??
    word.words.reduce((shortest, entry) => (entry.length < shortest.length ? entry : shortest))
  );
}

/**
 * 次に打つものの案内(§0.a-0.11)。**いま開いている段の欄名をそのまま出す**ので、
 * 同じ文言を 2 か所に書かない(`numericInput.ts` の `labelKey` が正本)。
 * 段が開いていなければ null(そのときは道具の名前を打つ番なので、候補が案内になる)。
 */
export function nextFieldLabels(state: NumericInputState | null): readonly string[] {
  if (state === null) {
    return [];
  }
  return state.fields.map((field) => t(field.labelKey));
}

// ---------------------------------------------------------------------------
// ストアから読む手掛かり
// ---------------------------------------------------------------------------

/**
 * 打った文字列を解くのに要る手掛かりを、いまのストアから作る(§2.5 の `context`)。
 *
 * `variables`(パラメータ表、FR-207)はストアの控え `parameterAnalysis.variables` を
 * そのまま渡す(P4b タスク11 で配線)。**その場入力のポップアップ
 * (`NumericInputPopover.tsx`)とプロパティの欄(`PropertyPanel.tsx`)へ渡すのも同じ表**で、
 * 出どころはストアの 1 か所だけにしてある。片方だけに渡すと、同じ式がどちらから打つかで
 * 通ったり通らなかったりする(タスク18 の申し送り)。
 */
export function commandLineContext(): CommandLineContext {
  const store = useAppStore.getState();
  return {
    // 3D スケッチ(作図面なし、FR-330)では作図面が無いので null を渡す。
    // `commandLine.ts` はこれを見て、極座標を断り、座標を 3 つ受け取る。
    plane: isFreeWorkPlaneId(store.workPlaneId) ? null : store.workPlane,
    variables: store.parameterAnalysis.variables,
    hasPrevious: hasPreviousPoint(),
  };
}

/**
 * `@` で書けるだけの「直前の点」があるか(FR-302)。
 *
 * 基準になり得るものを 3 つとも見る。①線分の始点のように**まだ履歴に無い取りかけ**
 * (`pendingStart`)、②新しい図形が置きかけている点(`shapeDraft.points`)、
 * ③すでに履歴にある要素(点・線分・円弧)。実際にどれを基準にするかは
 * `resolveCoordinate`(model)が決めるので、ここでは「どれか 1 つでもあるか」だけを見る。
 */
function hasPreviousPoint(): boolean {
  const store = useAppStore.getState();
  if (store.pendingStart !== null || store.shapeDraft.points.length > 0) {
    return true;
  }
  const resolved = store.resolvedSketch;
  return resolved.points.length > 0 || resolved.segments.length > 0 || resolved.arcs.length > 0;
}

/**
 * コマンドラインから段を開くときの基準位置(画素)。どこもクリックしていないので
 * ビューポートのほぼ中央にする(`Toolbar.tsx` の `viewportCenterAnchor` と同じ考え)。
 */
function commandLineAnchor(): readonly [number, number] {
  const [width, height] = useAppStore.getState().viewportSize;
  if (width <= 0 || height <= 0) {
    return [FALLBACK_ANCHOR_PIXELS, FALLBACK_ANCHOR_PIXELS];
  }
  return [Math.round(width / 2), Math.round(height / 2)];
}

// ---------------------------------------------------------------------------
// 欄への流し込み
// ---------------------------------------------------------------------------

/** 座標の指定 1 つを、欄 3 つぶんの式の文字列へ開く。並びは欄の並びと同じ。 */
function coordinateSources(value: CoordinateInput): readonly string[] {
  switch (value.mode) {
    case 'absolute':
      return [value.x.source, value.y.source, value.z.source];
    case 'relative':
      return [value.dx.source, value.dy.source, value.dz.source];
    case 'polar':
      return [value.distance.source, value.azimuth.source, value.elevation.source];
  }
}

/** 座標の指定の「位置の決め方」。欄の並びを合わせるのに使う。 */
function modeOf(value: CoordinateInput): CoordinateMode {
  return value.mode;
}

/**
 * 打った座標を、いま開いている段の欄へ流し込む(計画書 タスク18 の落とし穴
 * 「打った値をポップオーバーの欄へ映すのを忘れない」)。
 * 流し込めないときは断りの文言を返す。
 */
function fillCoordinate(
  state: NumericInputState,
  value: CoordinateInput,
): NumericInputState | string {
  if (!asksCoordinate(state.step)) {
    return t('commandLine.error.notCoordinateStep');
  }
  // 指定の仕方(絶対 / ずれ / 角度と距離)を先に合わせる。合わせると欄が既定値へ戻るので、
  // 値を入れるのはそのあと(`reduceNumericInput` の setMode の約束)。
  let next = reduceNumericInput(state, { type: 'setMode', mode: modeOf(value) });
  coordinateSources(value).forEach((source, index) => {
    next = reduceNumericInput(next, { type: 'edit', index, source });
  });
  return next;
}

/** 打った `r=5` のような値を、名前で欄を探して流し込む。無い名前なら断りの文言を返す。 */
function fillField(
  state: NumericInputState,
  fieldKey: string,
  source: string,
): NumericInputState | string {
  const index = state.fields.findIndex((field) => field.key === fieldKey);
  if (index === -1) {
    return t('commandLine.error.noSuchField');
  }
  return reduceNumericInput(state, { type: 'edit', index, source });
}

// ---------------------------------------------------------------------------
// 3 つの行き先
// ---------------------------------------------------------------------------

/** ①道具の語。道具を切り替え、その道具の 1 段目が決まっていれば開く。 */
function activateCommandTool(tool: NumericInputToolId): CommandLineSubmission {
  const store = useAppStore.getState();
  // 道具を変えるとその場入力は閉じる(`setActiveTool`)ので、開き直すのはこの後。
  store.setActiveTool(tool);
  const step = firstStepFor(tool);
  if (step === null) {
    return { kind: 'tool', tool, openedStep: false };
  }
  store.openNumericInput(createNumericInput(tool, step), commandLineAnchor());
  return { kind: 'tool', tool, openedStep: true };
}

/**
 * ②③いま開いている段を確定する。`filled` は欄へ流し込んだあとの姿(空の Enter なら
 * いまの姿そのまま)。断られた理由は帯に出るので、ここでは断りかどうかだけを返す。
 */
function commitStep(filled: NumericInputState): CommandLineSubmission {
  // 確定にも変数表を渡す(FR-207、タスク11)。渡さないと `板厚 * 2` を打ち込めても
  // Enter で断られ、欄と決定で食い違う。
  const variables = useAppStore.getState().parameterAnalysis.variables;
  const transition = applyNumericInputKey(filled, 'Enter', { variables });
  applyNumericTransition(transition);
  if (transition.kind !== 'blocked') {
    return { kind: 'committed' };
  }
  // 値そのものが読めない・範囲外(NFR-UX-5)。最初に間違っている欄の理由をそのまま返す。
  const evaluation = evaluateNumericInput(filled, variables);
  const first = evaluation.results[evaluation.firstErrorIndex];
  return failed(first?.error?.message ?? t('commandLine.error.tooFewValues'));
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * コマンドラインの 1 行を実行する(FR-208)。画面はこの関数だけを呼ぶ。
 *
 * 断ったときも履歴も選択も変えない(FR-504、NFR-UX-5)。理由は返り値で渡し、
 * 帯へ出すのは呼び出し側(`CommandLine.tsx` がストアへ入れ、`statusText.ts` が並べる)。
 */
export function submitCommandLine(text: string): CommandLineSubmission {
  const outcome = parseCommandLine(text, commandLineContext());
  switch (outcome.kind) {
    case 'error':
      return failed(outcome.message, outcome.suggestions);
    case 'tool':
      return activateCommandTool(outcome.tool);
    case 'commit': {
      const state = useAppStore.getState().numericInput;
      if (state === null) {
        return failed(t('commandLine.error.noOpenStep'));
      }
      return commitStep(state);
    }
    case 'coordinate': {
      const state = useAppStore.getState().numericInput;
      if (state === null) {
        return failed(t('commandLine.error.noOpenStep'));
      }
      const filled = fillCoordinate(state, outcome.value);
      return typeof filled === 'string' ? failed(filled) : commitStep(filled);
    }
    case 'field': {
      const state = useAppStore.getState().numericInput;
      if (state === null) {
        return failed(t('commandLine.error.noOpenStep'));
      }
      const filled = fillField(state, outcome.fieldKey, outcome.source);
      return typeof filled === 'string' ? failed(filled) : commitStep(filled);
    }
  }
}
