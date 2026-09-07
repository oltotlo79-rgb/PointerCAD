/**
 * 3D プリントの点検を 1 回頼む(計画書 docs/plans/P6-入出力.md §0.51・§0.53、タスク46 = 43a)。
 *
 * 対応要件: FR-815(3D プリント向けの点検)、NFR-PF-4(進み具合と中止)、NFR-UX-5(断り)。
 *
 * DOM にも three.js にもストアにも触れない(`createPartInspector` だけが橋渡しの関数を
 * 受け取るが、それも呼ぶ相手を渡してもらうだけ)。判断を Node の単体検査で固定できる
 * ようにするため——`measureCommands.ts` とまったく同じ分け方で、点検も
 * 「**覚えてある形を読むだけ**」の操作(§0.a-0.30)である点まで測定と同じ。
 *
 * ## 何を点検するか
 *
 * **選んでいる立体があればそれだけ、無ければ画面に出ている全部**(`printCheckTargets`)。
 * 3D プリントは 1 つずつ刷るものなので「いま気になっている 1 個」を調べたい場面が多く、
 * 一方で何も選ばずに押したときに「選んでください」と断ると、押しても何も起きない
 * (NFR-UX-3「押したら必ず何かが起きる」)。
 */

import {
  DISPLAY_MESH_QUALITY,
  type PartDocument,
  type PrintabilityOutcome,
  type PrintabilityReport,
  type ResolvedSolidStep,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import {
  rememberPrintabilityDisplayMeshes,
  printabilityTriangleOffsets,
  type PrintabilityBodyTriangles,
} from './printabilityColors.js';
import { resolveCachedSteps, type CachedResolveDeps } from './resolveCachedSteps.js';

/**
 * 点検する手立て(ストアが持つ口)。`PartMeasurer` と同じ形で、カーネル(Worker)を
 * 持たない検査では偽物を差し込める。**再計算は起こさない読み取り**(§0.a-0.30)。
 */
export type PartInspector = (
  document: PartDocument,
  bodies: readonly string[],
  /**
   * 中止を尋ねる口(NFR-PF-4)。`true` を返すと、カーネルは肉厚の段の途中で打ち切って
   * **そこまでの結果を返す**(投げない。`PrintabilityReport.cancelled` が真になる)。
   */
  shouldCancel?: () => boolean,
) => Promise<PrintabilityOutcome>;

/** `createPartInspector` に渡すもの。解くのに要るものは測定・書き出しと共通。 */
export interface PartInspectorDeps extends CachedResolveDeps {
  /** 形を点検する口(`KernelBridge.inspectPrintability`)。 */
  readonly inspectPrintability: (
    steps: readonly ResolvedSolidStep[],
    options: {
      readonly bodies: readonly string[];
      readonly shouldCancel?: () => boolean;
    },
  ) => Promise<PrintabilityOutcome>;
}

/**
 * 点検する手立てを組み立てる。
 *
 * カーネルは**段の鍵**でしか形を引けないので、点検の前に文書を解き直して段の一覧を作る
 * (`resolveCachedSteps`。測定・書き出しと同じ 1 か所)。**細かさの対は渡さない**。
 * Worker は別メッシュを作らず、直近に画面へ返した表示メッシュをそのまま点検する。
 */
export function createPartInspector(deps: PartInspectorDeps): PartInspector {
  return (document, bodies, shouldCancel) =>
    deps.inspectPrintability(resolveCachedSteps(document, deps), { bodies, shouldCancel });
}

/**
 * 点検する立体 1 つ。**ストアの `SolidBody` がそのまま満たす形**にしてある
 * (`MeasureBody` と同じ流儀。ui はカーネルの結果をそのまま渡せる)。
 */
export interface PrintCheckBody {
  /** 立体を作ったフィーチャーの id(= ボディの id)。 */
  readonly featureId: string;
  /** 画面に出ている三角形。枚数だけを見る(色を塗る単位が三角形だから)。 */
  readonly mesh: { readonly triangleCount: number };
}

/** 点検する立体を、色の割り当てが読む形(id と枚数の対)へ写す。 */
function triangleCountsOf(
  bodies: readonly PrintCheckBody[],
): readonly PrintabilityBodyTriangles[] {
  return bodies.map((body) => ({
    featureId: body.featureId,
    triangleCount: body.mesh.triangleCount,
  }));
}

/**
 * 点検する立体を決める(選んでいればその立体、無ければ全部)。
 *
 * **並びは常に `bodies` の並びのまま**にする。カーネルは頼んだ順に三角形を連ねるので、
 * 選択の並び(押した順)で渡すと、選び直しただけで三角形の先頭の番号が変わってしまう。
 */
export function printCheckTargets(
  bodies: readonly PrintCheckBody[],
  selection: readonly string[],
): readonly PrintCheckBody[] {
  if (selection.length === 0) {
    return bodies;
  }
  const chosen = new Set(selection);
  const picked = bodies.filter((body) => chosen.has(body.featureId));
  // 選んでいるのが立体以外(面・辺・点やスケッチの要素)だけのときは、全部を点検する
  // ——「面を 1 枚選んだまま点検を押した」で何も起きないのを避ける(NFR-UX-3)。
  return picked.length === 0 ? bodies : picked;
}

/** 点検できる立体が 1 つも無いとき(NFR-UX-5)。文言はカーネルの断りと同じにそろえる。 */
export const PRINT_CHECK_NO_BODY_KEY: MessageKey = 'printCheck.noBody';

/** 点検の口がまだ差し出されていないとき(カーネルを積む前に押した)。 */
export const PRINT_CHECK_UNAVAILABLE_KEY: MessageKey = 'printCheck.unavailable';

/** 再計算で表示メッシュが入れ替わり、古い点検結果を塗れないとき。 */
export const PRINT_CHECK_STALE_KEY: MessageKey = 'printCheck.stale';

/** 点検の結果。断ったときは**そのまま画面へ出せる日本語 1 行**だけを返す(NFR-UX-5)。 */
export type PrintCheckOutcomeView =
  | {
      readonly ok: true;
      readonly report: PrintabilityReport;
      /** 立体ごとの先頭の三角形の番号(色を塗るときに使う)。 */
      readonly offsets: ReadonlyMap<string, number>;
    }
  | { readonly ok: false; readonly message: string };

/** `runPrintCheck` に渡すもの。すべてストアから読める値。 */
export interface PrintCheckInput {
  readonly document: PartDocument;
  /** 画面に出ている立体(`bodies` の並びのまま)。 */
  readonly bodies: readonly PrintCheckBody[];
  readonly selection: readonly string[];
  readonly inspector: PartInspector | null;
  /**
   * 中止を尋ねる口(NFR-PF-4)。省くと中止できない(カーネルは尋ねる相手が無ければ
   * 制御を返しもしない——`inspectPrintability` 本体の決め)。
   */
  readonly shouldCancel?: () => boolean;
}

/**
 * 点検を 1 回走らせる(ツールバーの「3D プリントの点検」の中身)。
 *
 * **文書は 1 バイトも変えない**ので取り消しの段も積まず、再計算も起きない
 * (§0.a-0.30 の読み取り。`measureSelection` とまったく同じ性質)。
 */
export async function runPrintCheck(input: PrintCheckInput): Promise<PrintCheckOutcomeView> {
  const targets = printCheckTargets(input.bodies, input.selection);
  if (targets.length === 0) {
    return { ok: false, message: t(PRINT_CHECK_NO_BODY_KEY) };
  }
  if (input.inspector === null) {
    return { ok: false, message: t(PRINT_CHECK_UNAVAILABLE_KEY) };
  }
  const outcome = await input.inspector(
    input.document,
    targets.map((body) => body.featureId),
    input.shouldCancel,
  );
  if (outcome.kind === 'failed') {
    // 断りの日本語はカーネル(または橋)が持っているものをそのまま出す(文言の正本は 1 つ)。
    return { ok: false, message: outcome.message };
  }
  if (!rememberPrintabilityDisplayMeshes(outcome.report, targets)) {
    return { ok: false, message: t(PRINT_CHECK_STALE_KEY) };
  }
  return {
    ok: true,
    report: outcome.report,
    offsets: printabilityTriangleOffsets(triangleCountsOf(targets)),
  };
}

/**
 * 従来の点検依頼が省略時に使う細かさの対。値は互換のため残すが、Worker は実際の
 * 表示メッシュを直接点検するため再メッシュ化には使わない。
 */
export const PRINT_CHECK_MESH_QUALITY = DISPLAY_MESH_QUALITY;
