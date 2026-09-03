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
  SolidBody,
} from '../kernelBridge.js';
import type { ResolvedSketch, SketchError, SketchMesh } from '../sketch/types.js';
import { resolvePart, type PartError } from './resolvePart.js';
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
}

/** 面を作れなかったとき(P1 の recomputeSketch と同じ文言に揃える)。 */
function sketchKernelFailed(featureId: string, message: string): SketchError {
  return { featureId, code: 'kernelFailed', message: `面を作れませんでした: ${message}` };
}

/**
 * 立体を作れなかったとき。段ごとの理由はカーネルが利用者向けの日本語で返すので、
 * そのまま見せる(docs/報告記録.md 2026-09-02 22:10 の②「橋渡しは失敗理由を捨てない」)。
 */
function solidKernelFailed(featureId: string, message: string): PartError {
  return { featureId, code: 'kernelFailed', message };
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

/**
 * 部品を丸ごと計算し直す(要件§6.3)。どこで失敗しても例外を投げない(FR-504、NFR-RE-1)。
 * カーネルを呼ぶのは、面のあるスケッチと、段が1つ以上あるときだけ(NFR-PF-1)。
 */
export async function recomputePart(
  document: PartDocument,
  bridge: KernelBridge,
  options: PartRecomputeOptions = {},
): Promise<PartRecomputeResult> {
  const generation = options.generation ?? 0;
  const resolved = resolvePart(document);

  // 上流(スケッチ)から下流(ソリッド)の順に失敗を並べる。直す順序がそのまま読めるように。
  const errors: PartRecomputeError[] = [];
  const sketches: PartSketchResult[] = [];
  for (const entry of resolved.sketches) {
    errors.push(...entry.resolved.errors);
    const outcome = await tessellateSketch(bridge, entry.resolved);
    errors.push(...outcome.errors);
    sketches.push({ sketchId: entry.sketchId, resolved: entry.resolved, mesh: outcome.mesh });
  }
  errors.push(...resolved.errors);

  if (resolved.steps.length === 0) {
    return { sketches, bodies: [], errors, cacheHits: 0, cancelled: false, generation };
  }

  try {
    const outcome = await bridge.recomputeSolids(resolved.steps, {
      generation,
      onProgress: options.onProgress,
      shouldCancel: options.shouldCancel,
    });
    for (const failure of outcome.failures) {
      errors.push(solidKernelFailed(failure.featureId, failure.message));
    }
    return {
      sketches,
      bodies: outcome.bodies,
      errors,
      cacheHits: outcome.cacheHits,
      cancelled: outcome.cancelled,
      generation,
    };
  } catch (error) {
    const message = `${SOLID_CALL_FAILED_PREFIX}${toMessage(error)}`;
    for (const step of resolved.steps) {
      errors.push(solidKernelFailed(step.featureId, message));
    }
    return { sketches, bodies: [], errors, cacheHits: 0, cancelled: false, generation };
  }
}
