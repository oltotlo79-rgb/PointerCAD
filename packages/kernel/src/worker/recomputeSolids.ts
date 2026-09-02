import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import { booleanOp } from '../occt/booleanOp.js';
import type { OcctShapeHandle } from '../occt/makeBox.js';
import { makeExtrudeSolid, makeRevolveSolid } from '../occt/makeSolidSweep.js';
import { sewSolid } from '../occt/sewSolid.js';
import { buildSolidBodyMesh } from '../occt/solidMesh.js';
import type {
  BooleanStepSpec,
  SolidBodyMesh,
  SolidProgress,
  SolidRecomputeRequest,
  SolidRecomputeResult,
  SolidStepFailure,
  SolidStepSpec,
  TessellationOptions,
} from '../types.js';
import type { ShapeCache } from './shapeCache.js';

/**
 * キャッシュに預ける 1 件。形と、その形から作った表示用データを組にして持つ。
 *
 * メッシュも一緒に覚えるのは、鍵が当たったときに三角形分割と体積計算まで
 * やり直さずに済ませるため(NFR-PF-3。当たった段は OCCT を一切呼ばない)。
 * delete() は形と、形を作るために確保した領域(maker 等)の両方を手放す
 * (makeBox.ts の OcctShapeHandle と同じ約束)。
 */
export interface CachedSolid {
  readonly shape: TopoDS_Shape;
  readonly mesh: SolidBodyMesh;
  delete(): void;
}

/**
 * 再計算に要るもの。Worker の中で 1 組だけ作って使い回す。
 *
 * キャッシュを外から渡す形にしてあるのは、検査でキャッシュの当たり外れと
 * 作り直した回数を直に観測できるようにするため(計画書 タスク7 の手順1)。
 */
export interface SolidRecomputeDeps {
  readonly oc: OpenCascadeInstance;
  readonly cache: ShapeCache<CachedSolid>;
}

/** 段を始める前に 1 回ずつ呼ばれる。Comlink 越しでは Comlink.proxy した関数が入る。 */
export type SolidProgressCallback = (progress: SolidProgress) => void;

/**
 * 中止を尋ねる口。true を返すと、残りの段を計算せずに打ち切る。
 *
 * Comlink 越しの呼び出しは必ず Promise を返すので、真偽値と Promise の
 * どちらも受け取れる形にしてある(呼ぶ側は await する)。
 */
export type SolidCancelToken = () => boolean | Promise<boolean>;

/** ブーリアンの相手がキャッシュにも失敗の記録にも無いとき(FR-504、NFR-RE-1)。 */
const MISSING_INPUT_MESSAGE = 'もとになる立体が見つかりませんでした。';

/** ブーリアンの相手が、同じ再計算の中で作れなかった段だったとき(FR-504)。 */
function upstreamFailedMessage(label: string): string {
  return `もとになる立体「${label}」を作れなかったため、この立体も作れませんでした。`;
}

/** 例外から、利用者へそのまま見せる日本語を取り出す。 */
function toFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 段と段の間で 1 回だけ制御を譲る(§2.6、§0.a-0.22)。
 *
 * Promise の解決(マイクロタスク)では Worker は受信待ちの通知を処理できないので、
 * setTimeout を挟んでイベントループを 1 周させる。ここで中止の知らせが届く。
 *
 * **限界:** 止まれるのは段と段の間だけで、1 段の OCCT 演算そのものは途中で止められない。
 * 時間のかかるブーリアン 1 回を打ち切ることはできない。
 */
function yieldToMessages(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * ブーリアンの入力をキャッシュから引く。無ければ理由をつけて断る。
 * 同じ再計算の中で作れなかった段が入力なら、その段の名前を出す(下流も理由つきで失敗させる)。
 */
function findBooleanInput(
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
  key: string,
): CachedSolid {
  const found = cache.get(key);
  if (found !== undefined) {
    return found;
  }
  const failedLabel = failedLabels.get(key);
  throw new Error(failedLabel === undefined ? MISSING_INPUT_MESSAGE : upstreamFailedMessage(failedLabel));
}

/**
 * 2 つの立体を組み合わせる段。
 * 入力の形はキャッシュの持ち物なので、この段では解放しない(booleanOp も引数に触れない)。
 */
function createBooleanSolid(
  oc: OpenCascadeInstance,
  spec: BooleanStepSpec,
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
): OcctShapeHandle {
  const target = findBooleanInput(cache, failedLabels, spec.targetKey);
  const tool = findBooleanInput(cache, failedLabels, spec.toolKey);
  return booleanOp(oc, spec.operation, target.shape, tool.shape);
}

/**
 * 段の種類ごとに作り手を選ぶ。各節は return で閉じる(no-fallthrough)。
 * 作れないときは、どの作り手も利用者へ見せられる日本語の Error を投げる。
 */
function createStepSolid(
  oc: OpenCascadeInstance,
  spec: SolidStepSpec,
  options: TessellationOptions,
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
): OcctShapeHandle {
  switch (spec.kind) {
    case 'extrude':
      return makeExtrudeSolid(oc, spec, options);
    case 'revolve':
      return makeRevolveSolid(oc, spec, options);
    case 'sew':
      return sewSolid(oc, spec, options);
    case 'boolean':
      return createBooleanSolid(oc, spec, cache, failedLabels);
  }
}

/**
 * 作った形に表示用データを添えて、キャッシュに預けられる形にする。
 * 三角形分割の途中で断られたときは、預ける前なので自分で形を手放す。
 *
 * 立体になっているかの確認(hasSolid / isValidShape / 体積)は、
 * それぞれの作り手(makeExtrudeSolid・sewSolid・booleanOp)が済ませている。
 */
function buildCachedSolid(
  oc: OpenCascadeInstance,
  id: string,
  handle: OcctShapeHandle,
  options: TessellationOptions,
): CachedSolid {
  try {
    const mesh = buildSolidBodyMesh(oc, id, handle.shape, options);
    return {
      shape: handle.shape,
      mesh,
      delete(): void {
        handle.delete();
      },
    };
  } catch (error) {
    handle.delete();
    throw error;
  }
}

/**
 * 履歴の段を先頭から順に計算し直す(要件§6.3、NFR-PF-3、NFR-PF-4、FR-504)。
 *
 * - **鍵で作り直しを省く.** 段の鍵(model が解決済みのパラメータと上流の鍵から作る)が
 *   キャッシュに当たれば、OCCT を呼ばずに覚えていたメッシュをそのまま使う。
 * - **キャッシュの掃除はしない.** 再計算のたびに retain を呼ぶと、Undo で 1 段戻したときに
 *   作り直しが起きる。容量 SHAPE_CACHE_CAPACITY の LRU に任せる(2026-09-03 統括判断)。
 *   段の数が容量を超える依頼では、先頭に近い段から追い出されることになる。
 * - **止めずに理由を出す.** 作れなかった段は failures に積んで次の段へ進む。
 *   その段を入力にするブーリアンも、上流の名前を添えた理由で失敗させて続ける(FR-504)。
 * - **消費されたボディは返さない.** visible が false の段はキャッシュには残るが bodies に入らない
 *   (ブーリアンに食べられた対象と相手。§0.a-0.5)。
 *
 * 進捗と中止は呼び出し側の関数で受け取る。Comlink 越しでは Comlink.proxy した関数が渡る。
 * 中止を尋ねるのは段と段の間だけで、最初の段は必ず計算する。
 */
export async function recomputeSolids(
  deps: SolidRecomputeDeps,
  request: SolidRecomputeRequest,
  options: TessellationOptions = {},
  onProgress?: SolidProgressCallback,
  shouldCancel?: SolidCancelToken,
): Promise<SolidRecomputeResult> {
  const { oc, cache } = deps;
  const total = request.steps.length;
  const bodies: SolidBodyMesh[] = [];
  const failures: SolidStepFailure[] = [];
  /** 作れなかった段の鍵 → その段の表示名。下流の理由に使う。 */
  const failedLabels = new Map<string, string>();
  let cacheHits = 0;
  let cancelled = false;

  for (let index = 0; index < total; index += 1) {
    const step = request.steps[index];

    // 中止の口が渡されているときだけ制御を譲る。渡されていなければ拾うものが無い。
    if (index > 0 && shouldCancel !== undefined) {
      await yieldToMessages();
      if (await shouldCancel()) {
        cancelled = true;
        break;
      }
    }

    onProgress?.({ stepId: step.id, index, total, label: step.label });

    const cached = cache.get(step.key);
    if (cached !== undefined) {
      cacheHits += 1;
      if (step.visible) {
        // 同じ形を別のフィーチャーが使うことがあるので、id はこの段のものに差し替える。
        bodies.push({ ...cached.mesh, id: step.id });
      }
      continue;
    }

    try {
      const handle = createStepSolid(oc, step.step, options, cache, failedLabels);
      const entry = buildCachedSolid(oc, step.id, handle, options);
      cache.set(step.key, entry);
      if (step.visible) {
        bodies.push(entry.mesh);
      }
    } catch (error) {
      failures.push({ id: step.id, message: toFailureMessage(error) });
      failedLabels.set(step.key, step.label);
    }
  }

  return { bodies, failures, cacheHits, cancelled };
}
