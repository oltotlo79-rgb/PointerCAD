/**
 * 道具「図形の測定値」を先に押したときの段階の案内(ADD-23、利用者の回答 Q11=P2、
 * 計画書 scratchpad/claude/plans/geomref-plan.md §4(a)・§5.2 GR-26)。
 *
 * この道具は、対象を先に選んでも道具を先に押してもよい(P2)。道具が先なら、何を選べば
 * よいかを状態欄で案内し、選ぶたびに段を進め、選択を外せば戻す(NFR-UX-1、NFR-UX-7)。
 * 節の先頭の文(GR-19a・GR-19b)も同じここの判断を使い、状態欄と節で違う文を出さない。
 *
 * 判断はこの純関数 1 か所に置く。材料は GR-15 の候補と理由コード(`mathGeometrySelection`)と
 * GR-14 の現在性(`currentMathGeometry`)だけで、文言は持たずに鍵と差し込み値を返す
 * (i18n の鍵は `i18n/ja/mathGeometry.json`)。`shell/statusText.ts` は画面側の最下層の
 * 純関数なのでここを読み込まない。`StatusBar.tsx` が道具の有効なときだけここを呼び、
 * 組み立てた 1 文を `StatusInput.mathGeometryGuide` で渡す。
 */
import { t, type MessageKey } from '../i18n/t.js';
import type { MathGeometryToolId } from '../sketch/numericInputTools.js';
import type { AppState } from '../store/appState.js';
import { activePartDocument } from '../store/documentKind.js';
import { currentMathGeometry, type MathGeometryResultState } from './mathGeometryResults.js';
import { mathGeometrySelection, type MathGeometryCandidateReason } from './mathGeometrySelection.js';

/** 道具の id(GR-30 が `NumericInputToolId` へ足したもの)。 */
const MATH_GEOMETRY_TOOL: MathGeometryToolId = 'mathGeometry';

/**
 * 案内の段。GR-15 の理由コード(何も選んでいない・組に対応する量がない・選びすぎ)に、
 * 測れる量がある段(`ready`)と形の計算中(`computing`)を足したもの。
 * 理由コードが増えたら(GR-22 等)、下の表の網羅の型検査が文の足し忘れを落とす。
 */
export type MathGeometryToolGuideStage = MathGeometryCandidateReason | 'ready' | 'computing';

/** 段ごとの文の鍵(網羅の表。同じ判断を画面側に書かない)。 */
export const MATH_GEOMETRY_TOOL_GUIDE_KEYS = {
  // 段0(何も選んでいない)。道具の基本案内(`statusText.ts` の `GUIDE_KEYS.mathGeometry`)と
  // 同じ鍵にして、この欄を渡さない呼び出しでも同じ文が出るようにする。
  nothingSelected: 'statusBar.guide.mathGeometry',
  // 段1(測れる量が {count} 件ある)。
  ready: 'mathGeometry.guide.ready',
  unsupportedPair: 'mathGeometry.disabled.unsupportedPair',
  tooMany: 'mathGeometry.disabled.tooMany',
  computing: 'mathGeometry.disabled.computing',
} as const satisfies Record<MathGeometryToolGuideStage, MessageKey>;

/** 案内 1 つ。文言は持たず、鍵と差し込み値だけを持つ。 */
export interface MathGeometryToolGuide {
  readonly stage: MathGeometryToolGuideStage;
  /** 文の鍵(`MATH_GEOMETRY_TOOL_GUIDE_KEYS[stage]`)。 */
  readonly key: MessageKey;
  /** 差し込み値(`{count}` → `'2'` のように、名前 → 文字列)。差し込みの無い文では空。 */
  readonly values: Readonly<Record<string, string>>;
}

/** 判断に使う欄だけ。ストア全体を要求しないので、検査から素の値も渡せる。 */
export type MathGeometryToolGuideState = MathGeometryResultState &
  Pick<AppState, 'activeTool' | 'selection' | 'sketch' | 'resolvedSketch' | 'bodies'>;

const NO_VALUES: Readonly<Record<string, string>> = Object.freeze({});

function guideOf(stage: Exclude<MathGeometryToolGuideStage, 'ready'>): MathGeometryToolGuide {
  return { stage, key: MATH_GEOMETRY_TOOL_GUIDE_KEYS[stage], values: NO_VALUES };
}

/**
 * 道具「図形の測定値」が有効な間の段階の案内。部品以外(アセンブリ・図面)と、道具が
 * 有効でないときは null(呼び出し側は何も足さない)。上から順に当てはめる:
 *
 * 1. 何も選んでいない → 段0「測りたい点・辺・面・立体を選んでください。…」
 * 2. 選びすぎ(4 つ以上) → 「選ぶのは3つまでです。」
 * 3. 形の計算中(GR-14 の `computing`) → 「形の計算が終わってから追加してください。」
 * 4. 選んだ組に対応する量がない → 「選んだ組み合わせから測れる量がありません。」
 * 5. それ以外 → 段1「{count}件の量を測れます。…」
 *
 * 1・2 は選択そのものだけで決まるので、計算中でも正しい次の一手になる(選ぶことは計算中にも
 * できる)。4・5 は形(解決済みのスケッチ・ボディ)から作る判断で、計算中は古い形に基づくため、
 * 計算中の文を先に出す。履歴の途中表示・取消・形を作れなかったとき(GR-14 の `timeline`・
 * `cancelled`・`notEvaluated`)は値を出せないだけで、定義の追加は文書を変えて計算し直すので、
 * 選択の段をそのまま出す(値が出ない理由は節の状態の文が伝える)。
 */
export function mathGeometryToolGuide(state: MathGeometryToolGuideState): MathGeometryToolGuide | null {
  if (state.activeTool !== MATH_GEOMETRY_TOOL || activePartDocument(state) === null) {
    return null;
  }
  // GR-22b: also pass the document's reference geometry (mathGeometryRows.ts's selectionOf does the
  // same), so a point selected together with a reference coordinate system offers `coordinate` in
  // that frame here too — this guide's count and the candidate list (mathGeometryRows.ts) must agree.
  const { candidates, reason } = mathGeometrySelection(
    state.selection,
    state.sketch.id,
    state.resolvedSketch,
    state.bodies,
    activePartDocument(state)?.references ?? [],
  );
  if (reason === 'nothingSelected' || reason === 'tooMany') {
    return guideOf(reason);
  }
  if (currentMathGeometry(state).status === 'computing') {
    return guideOf('computing');
  }
  if (reason !== null) {
    return guideOf(reason);
  }
  return {
    stage: 'ready',
    key: MATH_GEOMETRY_TOOL_GUIDE_KEYS.ready,
    values: { count: String(candidates.length) },
  };
}

/**
 * 案内を 1 文にする(`{count}` などを差し込む)。状態欄と節の先頭(GR-19a)が同じ文を出すよう、
 * 文の組み立てもここ 1 か所に置く。
 */
export function mathGeometryToolGuideText(guide: MathGeometryToolGuide): string {
  let text = t(guide.key);
  for (const [name, value] of Object.entries(guide.values)) {
    text = text.split(`{${name}}`).join(value);
  }
  return text;
}
