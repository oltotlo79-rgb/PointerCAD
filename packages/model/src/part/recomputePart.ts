/**
 * 部品の再計算(計画書 docs/plans/P2-ソリッド基礎.md タスク12、§2.5、要件§6.3)。
 *
 * 文書が変わるたびに、次の順で計算し直す。
 *   1. resolvePart … 履歴を1段ずつ解決し、消費を判定し、キャッシュの鍵を決める(タスク11)
 *   2. 面のテッセレーション … 面のあるスケッチだけ bridge.tessellateSketchFaces へ(P1 のまま)
 *   3. ソリッドの再計算 … 段が1つ以上あれば bridge.recomputeSolids へ1回だけ
 *
 * **例外を投げない。** 解決の失敗もカーネルの失敗も errors へ集めて返し、作れたものは返す
 * (FR-504、NFR-RE-1「止めずに警告する」)。カーネルとの通信ごと失敗したときは、
 * 頼んだ分をすべて kernelFailed にして返す(P1 の recomputeSketch と同じ書き方)。
 *
 * 呼ぶ頻度は「文書が変わったときだけ」。ホバー・選択・視点操作では呼ばない(§2.4、NFR-PF-1)。
 */

import type {
  KernelBridge,
  PartCancelToken,
  PartProgressCallback,
  SketchProjectionRequestItem,
  SolidBody,
  SolidRecomputeOutcome,
} from '../kernelBridge.js';
import { createOffsetCache, type OffsetCache } from '../sketch/offsetMath.js';
import { createProjectionCache, type ProjectionCache } from '../sketch/projectionMath.js';
import { fillOffsets } from '../sketch/recomputeSketch.js';
import type { ResolvedCurve, ResolvedSketch, SketchError, SketchMesh } from '../sketch/types.js';
import {
  resolvePart,
  type PartError,
  type PartErrorCode,
  type ResolvedPart,
  type ResolvedProjection,
  type ResolvePartOptions,
} from './resolvePart.js';
import { createSubShapeCache, type SubShapeCache } from './subShapeCache.js';
import type { PartDocument } from './types.js';

/**
 * 再計算で集めた失敗(FR-504)。ソリッド側は PartError、スケッチ側は SketchError。
 *
 * どちらも `{ featureId, code, message }` で、利用者へ見せるのは message だけ。
 * SketchErrorCode には PartErrorCode に無い区別(missingBase・notClosed・collinear・
 * tooFewPoints・mixedBoundary)があるので、片方へ寄せずに両方をそのまま並べる。
 * 寄せると「どこが悪いか」の区別が消え、ツリーの印を出し分けられなくなるため。
 */
export type PartRecomputeError = PartError | SketchError;

/** スケッチ1本ぶんの再計算の結果。 */
export interface PartSketchResult {
  readonly sketchId: string;
  readonly resolved: ResolvedSketch;
  /** 面が1枚も無いとき(カーネルを呼ばないとき)と、呼び出しごと失敗したときは null。 */
  readonly mesh: SketchMesh | null;
}

export interface PartRecomputeResult {
  /** 文書の順に並んだスケッチの結果。 */
  readonly sketches: readonly PartSketchResult[];
  /** いま画面に出るボディ(§0.a-0.5)。消費されたボディは入らない。 */
  readonly bodies: readonly SolidBody[];
  /** 解決の失敗、スケッチの失敗、カーネルの失敗を上流から下流の順に並べたもの(FR-504)。 */
  readonly errors: readonly PartRecomputeError[];
  /** 作り直さずに済んだ段の数(NFR-PF-3 の効き目の実測値)。 */
  readonly cacheHits: number;
  /** 段と段の間で打ち切られたか(NFR-PF-4)。 */
  readonly cancelled: boolean;
  /**
   * この結果がどの依頼のものか(P1 の attachSketchRecompute と同じ発想)。
   * 呼び出し側は自分が数えている世代と見比べ、古い応答を捨てる。
   */
  readonly generation: number;
}

export interface PartRecomputeOptions {
  /** 依頼ごとに 1 つ増やす番号。省くと 0。 */
  readonly generation?: number;
  readonly onProgress?: PartProgressCallback;
  readonly shouldCancel?: PartCancelToken;
  /**
   * 計算済みのオフセット(FR-321、タスク15・21)を覚えておく入れ物。
   *
   * 渡さないと呼び出しのたびに新しく作るので、毎回カーネルへ頼み直すことになる。
   * 画面から繰り返し呼ぶ側(ui、タスク21)は 1 つ作って持ち回る(NFR-PF-2、
   * `recomputeSketch.ts` の `SketchRecomputeOptions.offsets` と同じ約束)。
   */
  readonly offsets?: OffsetCache;
  /**
   * 計算済みの投影・交差(FR-325、タスク25)を覚えておく入れ物。
   * オフセットと同じ約束で、画面から繰り返し呼ぶ側は 1 つ作って持ち回る(NFR-PF-2)。
   */
  readonly projections?: ProjectionCache;
  /**
   * 立体の面・辺・頂点の選び直し(FR-325、FR-328〜330 の上流追従、タスク25)を
   * 覚えておく入れ物。持ち回ると、上流が変わっていない再計算では 2 巡目が起きない。
   */
  readonly subShapes?: SubShapeCache;
}

/** 面を作れなかったとき(P1 の recomputeSketch と同じ文言に揃える)。 */
function sketchKernelFailed(featureId: string, message: string): SketchError {
  return { featureId, code: 'kernelFailed', message: `面を作れませんでした: ${message}` };
}

/**
 * カーネルの「加工するもとの面(辺)が見つかりません」の失敗を見分ける目印(P3 §2.4.2.5、
 * §0.a-0.5)。kernel の `SolidStepFailure` は `message` しか持たないので、
 * `makeHole.ts` / `makeFillet.ts` / `makeChamfer.ts` が共通で使うこの語尾を手がかりに
 * `missingSubShape` へ詰め替える(コミット済みの実装を Grep して、この語尾を使う失敗が
 * 他に無いことを確認済み。計画書の例文とは前置き部分が食い違うが、実装を正とする)。
 */
const MISSING_SUB_SHAPE_SUFFIX = '形が大きく変わったため、選び直してください。';

/**
 * 立体を作れなかったとき。段ごとの理由はカーネルが利用者向けの日本語で返すので、
 * そのまま見せる(docs/報告記録.md 2026-09-02 22:10 の②「橋渡しは失敗理由を捨てない」)。
 * `missingSubShape` かどうかは文言で見分ける(P3 タスク17。§2.2.4「選び直しはカーネルの
 * 中で行う」ため、kernel の SolidStepFailure は理由の区別を code では持たない)。
 */
function solidKernelFailed(featureId: string, message: string): PartError {
  const code: PartErrorCode = message.includes(MISSING_SUB_SHAPE_SUFFIX)
    ? 'missingSubShape'
    : 'kernelFailed';
  return { featureId, code, message };
}

/**
 * 呼び出しごと失敗したときの前置き。この場合の理由は Worker の内部事情
 * (通信の切断など)で利用者向けの文になっていないため、何ができなかったかを添える。
 */
const SOLID_CALL_FAILED_PREFIX = '立体を作れませんでした: ';

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SketchOutcome {
  readonly mesh: SketchMesh | null;
  readonly errors: readonly SketchError[];
}

/**
 * スケッチ1本の面をカーネルへ渡す。面が1枚も無ければ呼ばない(NFR-PF-1)。
 * 1枚失敗しても残りは描けるので、mesh と失敗を両方持ち帰る(FR-504)。
 */
async function tessellateSketch(
  bridge: KernelBridge,
  resolved: ResolvedSketch,
): Promise<SketchOutcome> {
  if (resolved.faces.length === 0) {
    return { mesh: null, errors: [] };
  }
  try {
    const outcome = await bridge.tessellateSketchFaces(resolved.faces);
    return {
      mesh: outcome.mesh,
      errors: outcome.failures.map((failure) =>
        sketchKernelFailed(failure.featureId, failure.message),
      ),
    };
  } catch (error) {
    // Worker との通信ごと失敗した場合。頼んだ面はすべて作れていない。
    const message = toMessage(error);
    return {
      mesh: null,
      errors: resolved.faces.map((face) => sketchKernelFailed(face.featureId, message)),
    };
  }
}

/** 投影・交差を作れなかったとき。面・オフセットとは別の言い回しで、どの操作かを分かるようにする。 */
function projectionFailed(featureId: string, message: string): SketchError {
  const code = message.includes(MISSING_SUB_SHAPE_SUFFIX) ? 'missingSubShape' : 'kernelFailed';
  return { featureId, code, message: `投影・交差を作れませんでした: ${message}` };
}

/** 段が 1 つも無いときの結果(カーネルを呼ばない、NFR-PF-1)。 */
const NO_SOLIDS: SolidRecomputeOutcome = {
  bodies: [],
  failures: [],
  cacheHits: 0,
  cancelled: false,
};

type SolidCallOutcome =
  | { readonly ok: true; readonly outcome: SolidRecomputeOutcome }
  | { readonly ok: false; readonly message: string };

/**
 * 立体の再計算をカーネルへ頼む。段が無ければ呼ばない(NFR-PF-1)。
 * 呼び出しごと失敗したときは例外にせず理由を持ち帰る(FR-504、NFR-RE-1)。
 */
async function callSolids(
  bridge: KernelBridge,
  resolved: ResolvedPart,
  generation: number,
  options: PartRecomputeOptions,
): Promise<SolidCallOutcome> {
  if (resolved.steps.length === 0) {
    return { ok: true, outcome: NO_SOLIDS };
  }
  try {
    return {
      ok: true,
      outcome: await bridge.recomputeSolids(resolved.steps, {
        generation,
        onProgress: options.onProgress,
        shouldCancel: options.shouldCancel,
      }),
    };
  } catch (error) {
    return { ok: false, message: `${SOLID_CALL_FAILED_PREFIX}${toMessage(error)}` };
  }
}

/**
 * オフセット(FR-321)を埋めながら部品を解決する。
 * **解決 → カーネルで形を作る → 解決し直す** の 2 段(`recomputeSketch` と同じ構成)。
 */
async function resolveWithOffsets(
  document: PartDocument,
  bridge: KernelBridge,
  offsets: OffsetCache,
  resolveOptions: ResolvePartOptions,
  offsetErrors: SketchError[],
): Promise<ResolvedPart> {
  const resolved = resolvePart(document, resolveOptions);
  const pendingOffsets = resolved.sketches.flatMap((entry) => entry.resolved.pendingOffsets);
  if (pendingOffsets.length === 0) {
    return resolved;
  }
  offsetErrors.push(...(await fillOffsets(bridge, pendingOffsets, offsets)));
  // 形が入ったので解決し直す。オフセットの曲線が面の境界にも使えるようになる。
  return resolvePart(document, resolveOptions);
}

/** 投影・交差 1 件を、カーネルへ渡せる依頼へ詰め替える。 */
function toProjectionItem(request: ResolvedProjection): SketchProjectionRequestItem {
  return {
    featureId: request.featureId,
    bodyKey: request.bodyKey,
    // 交差(`body`)は立体そのものを切るので、部分形状の指紋は渡さない。
    source: request.source.kind === 'subShape' ? request.source.ref : null,
    plane: request.plane,
  };
}

/**
 * まだ形の無い投影・交差(FR-325)を埋める。**曲線が 1 本でも入ったら true**
 * (呼び出し側はそのときだけ解決をやり直す)。
 *
 * 覚え書きに当たったものはカーネルへ頼まない。頼むものは投影と交差に分け、
 * それぞれ 1 回の往復でまとめる(最大 2 往復)。1 件失敗しても残りは作る(FR-504)。
 */
async function fillProjections(
  bridge: KernelBridge,
  requests: readonly ResolvedProjection[],
  cache: ProjectionCache,
  filled: Map<string, readonly ResolvedCurve[]>,
  errors: SketchError[],
): Promise<boolean> {
  if (requests.length === 0) {
    return false;
  }
  const byFeature = new Map(requests.map((request) => [request.featureId, request]));
  const askProjection: SketchProjectionRequestItem[] = [];
  const askSection: SketchProjectionRequestItem[] = [];
  let changed = false;

  for (const request of requests) {
    const remembered = cache.get(request.key);
    if (remembered !== null) {
      filled.set(request.featureId, remembered);
      changed = true;
      continue;
    }
    const item = toProjectionItem(request);
    if (request.source.kind === 'subShape') {
      askProjection.push(item);
    } else {
      askSection.push(item);
    }
  }

  /** 1 回の往復ぶんの結果を覚え書きと表へ入れる。 */
  const take = async (
    items: readonly SketchProjectionRequestItem[],
    call: KernelBridge['projectSketchCurves'],
  ): Promise<void> => {
    if (items.length === 0) {
      return;
    }
    try {
      const outcome = await call(items);
      for (const failure of outcome.failures) {
        errors.push(projectionFailed(failure.featureId, failure.message));
      }
      for (const entry of outcome.results) {
        const request = byFeature.get(entry.featureId);
        if (request === undefined) {
          continue;
        }
        // 交差が空(交わらない)ときも覚える。頼み直しても同じ答えになるため。
        cache.set(request.key, entry.curves);
        filled.set(entry.featureId, entry.curves);
        changed = true;
      }
    } catch (error) {
      // Worker との通信ごと失敗した場合。頼んだぶんはすべて作れていない。
      const message = toMessage(error);
      for (const item of items) {
        errors.push(projectionFailed(item.featureId, message));
      }
    }
  };

  await take(askProjection, (items) => bridge.projectSketchCurves(items));
  await take(askSection, (items) => bridge.sectionSketchCurves(items));
  return changed;
}

/**
 * 部品を丸ごと計算し直す(要件§6.3)。どこで失敗しても例外を投げない(FR-504、NFR-RE-1)。
 * カーネルを呼ぶのは、面のあるスケッチと、段が1つ以上あるときだけ(NFR-PF-1)。
 *
 * ## 巡の分かれ方(P4 タスク25、FR-325)
 *
 * 投影・交差(FR-325)と部分形状の上流追従(FR-328〜330)は、**立体が出来てからでないと
 * 解けない**(投影のもとになる B-rep はカーネルが立体を作ったときに初めて形状キャッシュへ
 * 入り、面・辺の選び直しもそのときの一覧が要る)。そこで次の順で進む。
 *
 *   1 巡目: 解決(オフセットを埋める)→ 立体の再計算
 *   → 返ってきたボディで①部分形状を選び直し、②投影・交差をカーネルへ頼む
 *   2 巡目: **どちらかで答えが変わったときだけ** 解決し直し → 立体の再計算
 *
 * **2 巡目は「変わったときだけ」**なので、投影も部分形状の参照も持たない部品
 * (ほとんどの部品)では 1 巡で終わり、これまでと同じ費用で済む(NFR-PF-3)。
 * 2 巡目の立体の再計算も、変わっていない段は鍵が当たって作り直されない。
 * 途中で打ち切られた(NFR-PF-4)ときは 2 巡目へ進まない。
 */
export async function recomputePart(
  document: PartDocument,
  bridge: KernelBridge,
  options: PartRecomputeOptions = {},
): Promise<PartRecomputeResult> {
  const generation = options.generation ?? 0;
  // 解決そのものは OCCT を呼ばない純関数のままで、形は覚え書き越しに差し込む。
  const offsets = options.offsets ?? createOffsetCache();
  const projections = options.projections ?? createProjectionCache();
  const subShapes = options.subShapes ?? createSubShapeCache();
  /** この再計算の中で埋まった投影・交差の曲線(フィーチャーの id で引く)。 */
  const projectedByFeature = new Map<string, readonly ResolvedCurve[]>();
  const resolveOptions: ResolvePartOptions = {
    offsetCurves: (key) => offsets.get(key),
    projectedCurves: (featureId) => projectedByFeature.get(featureId) ?? null,
    subShape: (reference) => subShapes.resolve(reference),
  };

  const offsetErrors: SketchError[] = [];
  const projectionErrors: SketchError[] = [];
  let resolved = await resolveWithOffsets(document, bridge, offsets, resolveOptions, offsetErrors);
  let solid = await callSolids(bridge, resolved, generation, options);

  if (solid.ok && !solid.outcome.cancelled) {
    // ①いまの形で面・辺・頂点を選び直す(上流追従)。②投影・交差の曲線を埋める。
    const reselected = subShapes.refresh(solid.outcome.bodies);
    const projected = await fillProjections(
      bridge,
      resolved.projections,
      projections,
      projectedByFeature,
      projectionErrors,
    );
    if (reselected || projected) {
      resolved = await resolveWithOffsets(document, bridge, offsets, resolveOptions, offsetErrors);
      solid = await callSolids(bridge, resolved, generation, options);
    }
  }

  // 上流(スケッチ)から下流(ソリッド)の順に失敗を並べる。直す順序がそのまま読めるように。
  const errors: PartRecomputeError[] = [];
  const sketches: PartSketchResult[] = [];
  for (const entry of resolved.sketches) {
    errors.push(...entry.resolved.errors);
    const outcome = await tessellateSketch(bridge, entry.resolved);
    errors.push(...outcome.errors);
    sketches.push({ sketchId: entry.sketchId, resolved: entry.resolved, mesh: outcome.mesh });
  }
  errors.push(...offsetErrors);
  errors.push(...projectionErrors);
  errors.push(...resolved.errors);

  if (!solid.ok) {
    for (const step of resolved.steps) {
      errors.push(solidKernelFailed(step.featureId, solid.message));
    }
    return { sketches, bodies: [], errors, cacheHits: 0, cancelled: false, generation };
  }

  for (const failure of solid.outcome.failures) {
    errors.push(solidKernelFailed(failure.featureId, failure.message));
  }
  return {
    sketches,
    bodies: solid.outcome.bodies,
    errors,
    cacheHits: solid.outcome.cacheHits,
    cancelled: solid.outcome.cancelled,
    generation,
  };
}
