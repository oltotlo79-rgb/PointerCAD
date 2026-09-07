/**
 * 部品の再計算(計画書 docs/plans/P2-ソリッド基礎.md タスク12、§2.5、要件§6.3)。
 *
 * 文書が変わるたびに、次の順で計算し直す。
 *   1. resolvePart … 履歴を1段ずつ解決し、消費を判定し、キャッシュの鍵を決める(タスク11)
 *   2. ソリッドの再計算 … 参照・投影の依存を解決した間だけ次の巡へ進む
 *   3. 面のテッセレーション … 最終結果の面のあるスケッチだけをカーネルへ渡す
 *
 * **例外を投げない。** 解決の失敗もカーネルの失敗も errors へ集めて返し、作れたものは返す
 * (FR-504、NFR-RE-1「止めずに警告する」)。カーネルとの通信ごと失敗したときは、
 * 頼んだ分をすべて kernelFailed にして返す(P1 の recomputeSketch と同じ書き方)。
 *
 * 呼ぶ頻度は「文書が変わったときだけ」。ホバー・選択・視点操作では呼ばない(§2.4、NFR-PF-1)。
 */

import { appearanceOf } from '../appearance/documentAppearance.js';
import { fingerprintKeyText, type SubShapeRef } from '../geometry/subShapeRef.js';
import type {
  AppearanceFaceRequest,
  AppearanceMatchEntry,
  KernelBridge,
  PartCancelToken,
  PartProgressCallback,
  SketchProjectionRequestItem,
  SolidBody,
  SolidRecomputeOutcome,
} from '../kernelBridge.js';
import type { ConstraintDiagnosis } from '../sketch/constraints/diagnose.js';
import { createOffsetCache, type OffsetCache } from '../sketch/offsetMath.js';
import { createProjectionCache, type ProjectionCache } from '../sketch/projectionMath.js';
import { fillOffsets } from '../sketch/recomputeSketch.js';
import type { ResolvedCurve, ResolvedSketch, SketchError, SketchMesh } from '../sketch/types.js';
import { projectionBodyFeatureId } from '../sketch/types.js';
import {
  referencedSketchIds,
  resolvePart,
  type ImportedShapeBytes,
  type PartError,
  type PartErrorCode,
  type ResolvedPart,
  type ResolvedProjection,
  type ResolvePartOptions,
} from './resolvePart.js';
import { applyParameters } from './reevaluatePart.js';
import { createSubShapeCache, type SubShapeCache } from './subShapeCache.js';
import { historyDependencies } from './timelineOrder.js';
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
  /**
   * 拘束の診断(自由度・足しすぎ・矛盾。FR-313、P4b タスク8)。画面はここから
   * 「あと N か所決まっていません」を帯へ出す(タスク13)。拘束が無ければ null。
   */
  readonly diagnosis: ConstraintDiagnosis | null;
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
  /**
   * 外観を割り当てた面が、いまの形のどの面に当たるか(FR-1106、P5 §2.2.3)。
   *
   * 文書の `appearance` のうち**面への割り当てだけ**が、文書と同じ並びで入る。
   * `faceIndex` が `null` のものは選び直せなかった割り当てで、画面はそこを既定の外観で
   * 描いて警告を出す(FR-1106)。**割り当て自体は文書から消さない。**
   * 立体への割り当ては指紋を持たず照合が要らないので、ここには入らない(§2.2.2)。
   *
   * 任意の欄にしてあるのは `SolidBody.area` と同じ理由(この型を組み立てている
   * `packages/ui` の見本を直せるのが ui のタスク10・11 の担当だから)で、
   * `recomputePart` は必ず値を入れる。
   */
  readonly appearanceMatches?: readonly AppearanceMatchEntry[];
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
   * 覚えておく入れ物。持ち回ると、上流が変わっていない再計算では選び直しによる追加巡回を省ける。
   */
  readonly subShapes?: SubShapeCache;
  /**
   * ボディの表面積(`SolidBody.area`)を測るか(FR-1102、P5 仕上げ (i)、
   * 統括の決定 2026-09-05 07:28。`kernelBridge.ts` の `SolidRecomputeOptions.measureAreas`
   * と同じ約束)。
   *
   * **既定は測らない(false)。** 穴 20 個の性能の余裕を削らないため(§0.a-0.67)、
   * 毎回の再計算では測定の費用を払わない。測定・質量特性(タスク29 以降)が表面積を
   * 求めたときだけ、呼び出し側(ui)がここを true にして呼ぶ。
   */
  readonly measureAreas?: boolean;
  /**
   * 読み込んだ形(FR-802、P6 §2.8、タスク20)の B-rep のバイト列の置き場。
   *
   * `.pcad` の ZIP の `shapes/<shapeRef>.brep` をそのまま読んだ表で、**開いた文書 1 つに
   * つき 1 つ**を作って持ち回る(オフセット・投影の覚え書きと同じ約束)。渡さないと
   * `importedSolid` の段は「読み込んだ形が見つかりません」で失敗する(FR-504)。
   * 表を組み立てるのは `packages/io`(タスク21)、ここはそのまま `resolvePart` へ渡すだけ。
   */
  readonly importedShapes?: ImportedShapeBytes;
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
  appearanceMatches: [],
};

/**
 * 面へ割り当てた外観を、カーネルへの照合の依頼へ集める(FR-1106、P5 §2.2.3)。
 *
 * 立体への割り当て(`kind: 'body'`)は指紋を持たず、フィーチャーの id で直に引けるので
 * 照合そのものが要らない(§2.2.2 の優先順位の 2 段目)。ここで集めるのは面だけで、
 * **1 件も無ければ空配列**になり、カーネルは照合の段を丸ごと飛ばす(費用ゼロ)。
 */
function toAppearanceRequests(document: PartDocument): readonly AppearanceFaceRequest[] {
  const requests: AppearanceFaceRequest[] = [];
  for (const entry of appearanceOf(document).entries) {
    if (entry.target.kind !== 'face') {
      continue;
    }
    const { ref } = entry.target;
    requests.push({ id: entry.id, bodyFeatureId: ref.bodyFeatureId, ref });
  }
  return requests;
}

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
  appearance: readonly AppearanceFaceRequest[],
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
        appearance,
        // 既定は測らない(NFR-PF-2〜3。§0.a-0.67「穴 20 個の性能の余裕を削らない」)。
        measureAreas: options.measureAreas ?? false,
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
 * まだ形の無い投影・交差(FR-325)を埋める。**新しい鍵を解決したら true**
 * (空の交差も解決済みと数え、同じ失敗の鍵を繰り返し頼まない)。
 *
 * 覚え書きに当たったものはカーネルへ頼まない。頼むものは投影と交差に分け、
 * それぞれ 1 回の往復でまとめる(最大 2 往復)。1 件失敗しても残りは作る(FR-504)。
 */
async function fillProjections(
  bridge: KernelBridge,
  requests: readonly ResolvedProjection[],
  cache: ProjectionCache,
  filled: Map<string, readonly ResolvedCurve[]>,
  errors: Map<string, SketchError>,
  attempted: Set<string>,
  settled: Set<string>,
): Promise<boolean> {
  if (requests.length === 0) {
    return false;
  }
  const byFeature = new Map(requests.map((request) => [request.featureId, request]));
  const askProjection: SketchProjectionRequestItem[] = [];
  const askSection: SketchProjectionRequestItem[] = [];
  let changed = false;

  const remember = (request: ResolvedProjection, curves: readonly ResolvedCurve[]): void => {
    filled.set(request.featureId, curves);
    errors.delete(request.featureId);
    const key = JSON.stringify(['projection', request.featureId, request.key]);
    if (!settled.has(key)) {
      settled.add(key);
      changed = true;
    }
  };

  for (const request of requests) {
    const key = JSON.stringify([request.featureId, request.key]);
    const remembered = cache.get(request.key);
    if (remembered !== null) {
      remember(request, remembered);
      continue;
    }
    if (attempted.has(key)) {
      continue;
    }
    attempted.add(key);
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
        errors.set(failure.featureId, projectionFailed(failure.featureId, failure.message));
      }
      for (const entry of outcome.results) {
        const request = byFeature.get(entry.featureId);
        if (request === undefined) {
          continue;
        }
        // 交差が空(交わらない)ときも覚える。頼み直しても同じ答えになるため。
        cache.set(request.key, entry.curves);
        remember(request, entry.curves);
      }
    } catch (error) {
      // Worker との通信ごと失敗した場合。頼んだぶんはすべて作れていない。
      const message = toMessage(error);
      for (const item of items) {
        errors.set(item.featureId, projectionFailed(item.featureId, message));
      }
    }
  };

  await take(askProjection, (items) => bridge.projectSketchCurves(items));
  await take(askSection, (items) => bridge.sectionSketchCurves(items));
  return changed;
}

/** 履歴の依存に、帯に出ない投影要素とその利用先を補う。公開の解決APIは変えない。 */
function recomputeDependencies(document: PartDocument): ReadonlyMap<string, readonly string[]> {
  const active = { ...document, solids: document.solids.filter((feature) => !feature.suppressed) };
  const graph = new Map(historyDependencies(active));
  const projectionsBySketch = new Map<string, string[]>();
  for (const sketch of active.sketches) {
    const ids: string[] = [];
    for (const feature of sketch.features) {
      if (feature.kind !== 'projectedCurve' && feature.kind !== 'planeSection') {
        continue;
      }
      const source =
        feature.kind === 'projectedCurve'
          ? feature.source.bodyFeatureId
          : feature.targetFeatureId;
      graph.set(feature.id, [source, feature.planeId]);
      ids.push(feature.id);
    }
    projectionsBySketch.set(sketch.id, ids);
  }
  for (const feature of active.solids) {
    graph.set(feature.id, [
      ...(graph.get(feature.id) ?? []),
      ...referencedSketchIds(feature, active.sketches).flatMap(
        (id) => projectionsBySketch.get(id) ?? [],
      ),
    ]);
  }
  return graph;
}

/** 強連結成分をまとめ、循環の全IDと、成分間の最長依存段数を求める。 */
function dependencySchedule(graph: ReadonlyMap<string, readonly string[]>): {
  readonly maxPasses: number;
  readonly cyclicIds: ReadonlySet<string>;
  readonly downstream: (sources: ReadonlySet<string>) => ReadonlySet<string>;
} {
  const indexes = new Map<string, number>();
  const lows = new Map<string, number>();
  const stack: string[] = [];
  const visiting = new Set<string>();
  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  const visit = (id: string): void => {
    const index = indexes.size;
    indexes.set(id, index);
    lows.set(id, index);
    stack.push(id);
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (!graph.has(dependency)) {
        continue;
      }
      if (!indexes.has(dependency)) {
        visit(dependency);
        lows.set(id, Math.min(lows.get(id) ?? index, lows.get(dependency) ?? index));
      } else if (visiting.has(dependency)) {
        lows.set(id, Math.min(lows.get(id) ?? index, indexes.get(dependency) ?? index));
      }
    }
    if (lows.get(id) !== index) {
      return;
    }
    const members: string[] = [];
    let member = stack.pop();
    while (member !== undefined) {
      visiting.delete(member);
      componentOf.set(member, components.length);
      members.push(member);
      if (member === id) {
        break;
      }
      member = stack.pop();
    }
    components.push(members);
  };
  for (const id of graph.keys()) {
    if (!indexes.has(id)) {
      visit(id);
    }
  }
  const cyclicIds = new Set<string>();
  const depths: number[] = [];
  // DFSで先に完了した依存成分から並んでいるので、深さも1回の走査で決まる。
  components.forEach((members, component) => {
    let depth = 0;
    for (const id of members) {
      if (members.length > 1 || graph.get(id)?.includes(id)) {
        cyclicIds.add(id);
      }
      for (const dependency of graph.get(id) ?? []) {
        const upstream = componentOf.get(dependency);
        if (upstream !== undefined && upstream !== component) {
          depth = Math.max(depth, depths[upstream]);
        }
      }
    }
    depths.push(depth + members.length);
  });
  const dependents = new Map<string, Set<string>>();
  for (const [id, dependencies] of graph) {
    for (const dependency of dependencies) {
      const ids = dependents.get(dependency) ?? new Set<string>();
      ids.add(id);
      dependents.set(dependency, ids);
    }
  }
  return {
    maxPasses: 1 + depths.reduce((max, depth) => Math.max(max, depth), 0),
    cyclicIds,
    downstream(sources) {
      const found = new Set<string>();
      const queue = [...sources];
      for (let index = 0; index < queue.length; index += 1) {
        for (const id of dependents.get(queue[index]) ?? []) {
          if (!found.has(id)) {
            found.add(id);
            queue.push(id);
          }
        }
      }
      return found;
    },
  };
}

/** 途中の形・スケッチ・診断を適用させない。generationは依頼開始時の番号だけを返す。 */
function cancelledResult(generation: number): PartRecomputeResult {
  return {
    sketches: [],
    bodies: [],
    errors: [],
    cacheHits: 0,
    cancelled: true,
    generation,
    appearanceMatches: [],
  };
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
 *   各巡: 解決(オフセットを埋める)→ 立体の再計算
 *   → 返ってきたボディで①部分形状を選び直し、②投影・交差をカーネルへ頼む
 *   → 新しい参照・投影の鍵が解決された間だけ、依存段数を上限に次の巡へ進む
 *
 * **追加巡回は「新しい鍵が解決されたときだけ」**なので、投影も部分形状の参照も持たない部品
 * (ほとんどの部品)では 1 巡で終わり、これまでと同じ費用で済む(NFR-PF-3)。
 * 追加巡回でも変わっていない段は鍵が当たって作り直されない。
 * 進展が止まった要求と循環にはIDつきの診断を返す。各巡の前に取消を確認する(NFR-PF-4)。
 *
 * ## 外観の面の照合(FR-1106、P5 §2.2.3)
 *
 * 面に付けた色は指紋(`SubShapeRef`)で覚えているだけなので、形を作り直すと面の通し番号が
 * ずれる。そこで**立体の再計算に相乗りして**、割り当ての一覧をカーネルへ添え、
 * 選び直した結果を `appearanceMatches` で受け取る(採点を model へ複製しないための決め、
 * §0.a-0.2)。**割り当てが 1 件も無ければ何も添えないので、費用は増えない。**
 *
 * **外観だけを変えたときは、そもそもこの関数を呼ばない。** 呼ぶかどうかの判定は
 * `part/documentChange.ts` の `affectsShape` が持ち、画面側(ストアの購読)が使う。
 * 段の鍵(`cacheKeyFor`)も外観を見ないので、仮に呼んでも全段がキャッシュに当たる
 * (§2.2.3「鍵に混ぜない」との二重の保証)。
 *
 * ## 表面積の測定(FR-1102、P5 仕上げ (i))
 *
 * `options.measureAreas` を素通しでカーネルへ渡す(`SolidRecomputeOptions.measureAreas` と
 * 同じ約束)。**既定は false のまま**(§0.a-0.67「穴 20 個の性能の余裕を削らない」)なので、
 * 呼び出し側が明示的に true を渡さない限り `SolidBody.area` は今までどおり埋まらない。
 * 測定・質量特性(タスク29 以降)が表面積を使うかどうかは呼び出し側(ui)の判断。
 *
 * ## パラメータ表(FR-207、P4b タスク3)
 *
 * 解決を始める前に、パラメータ表(名前を付けた数値)の値を**文書の全ての式へ配る**
 * (`applyParameters`)。ここを通さないと、表の値を変えても押し出しの距離や穴の径が
 * 追従しない(FR-502)。**表が空なら `applyParameters` は元の文書をそのまま返す**ので、
 * パラメータを使わない部品では費用も結果も変わらない。
 */
export async function recomputePart(
  document: PartDocument,
  bridge: KernelBridge,
  options: PartRecomputeOptions = {},
): Promise<PartRecomputeResult> {
  const generation = options.generation ?? 0;
  if (options.shouldCancel?.()) {
    return cancelledResult(generation);
  }
  const evaluated = applyParameters(document).document;
  // 解決そのものは OCCT を呼ばない純関数のままで、形は覚え書き越しに差し込む。
  const offsets = options.offsets ?? createOffsetCache();
  const projections = options.projections ?? createProjectionCache();
  const subShapes = options.subShapes ?? createSubShapeCache();
  /** この再計算の中で埋まった投影・交差の曲線(フィーチャーの id で引く)。 */
  const projectedByFeature = new Map<string, readonly ResolvedCurve[]>();
  const askedSubShapes = new Map<
    string,
    { readonly reference: SubShapeRef; readonly value: string }
  >();
  const resolveOptions: ResolvePartOptions = {
    offsetCurves: (key) => offsets.get(key),
    projectedCurves: (featureId) => projectedByFeature.get(featureId) ?? null,
    subShape: (reference) => {
      const value = subShapes.resolve(reference);
      askedSubShapes.set(fingerprintKeyText(reference), { reference, value: JSON.stringify(value) });
      return value;
    },
    // 読み込んだ形のバイト列(FR-802、P6 §2.8)。渡されなければ resolvePart が空として扱う。
    importedShapes: options.importedShapes,
  };

  const offsetErrors: SketchError[] = [];
  const projectionErrors = new Map<string, SketchError>();
  const dependencyErrors = new Map<string, PartError>();
  const attemptedProjections = new Set<string>();
  const settled = new Set<string>();
  const schedule = dependencySchedule(recomputeDependencies(evaluated));
  // 外観の割り当ては解決の結果に影響しないので、巡ごとに作り直さず 1 回だけ集める。
  const appearance = toAppearanceRequests(evaluated);
  let resolved: ResolvedPart;
  let solid: SolidCallOutcome;
  for (let pass = 0; ; pass += 1) {
    if (options.shouldCancel?.()) {
      return cancelledResult(generation);
    }
    offsetErrors.length = 0;
    askedSubShapes.clear();
    resolved = await resolveWithOffsets(evaluated, bridge, offsets, resolveOptions, offsetErrors);
    if (options.shouldCancel?.()) {
      return cancelledResult(generation);
    }
    solid = await callSolids(bridge, resolved, generation, options, appearance);
    if (options.shouldCancel?.() || (solid.ok && solid.outcome.cancelled)) {
      return cancelledResult(generation);
    }
    if (!solid.ok) {
      break;
    }

    // ①いまの形で面・辺・頂点を選び直す(上流追従)。②投影・交差の曲線を埋める。
    const countBefore = settled.size;
    const changedSources = new Set<string>();
    if (subShapes.refresh(solid.outcome.bodies)) {
      const bodyKeys = new Map(resolved.steps.map((step) => [step.featureId, step.key]));
      for (const [key, asked] of askedSubShapes) {
        if (asked.value !== JSON.stringify(subShapes.resolve(asked.reference))) {
          const bodyId = asked.reference.bodyFeatureId;
          changedSources.add(bodyId);
          settled.add(JSON.stringify(['subShape', key, bodyKeys.get(bodyId)]));
        }
      }
    }
    const invalidated = schedule.downstream(changedSources);
    for (const id of invalidated) {
      projectedByFeature.delete(id);
      projectionErrors.delete(id);
    }
    const pendingIds = new Set(
      resolved.sketches.flatMap((entry) =>
        entry.resolved.pendingProjections.map((pending) => pending.featureId),
      ),
    );
    // まだ埋まっていない投影に依存する立体・作図面の投影は、次の巡で鍵が確定してから頼む。
    const waiting = schedule.downstream(pendingIds);
    const failedBodies = new Set(solid.outcome.failures.map((failure) => failure.featureId));
    const projected = await fillProjections(
      bridge,
      resolved.projections.filter(
        (request) =>
          !invalidated.has(request.featureId) &&
          !waiting.has(request.featureId) &&
          !schedule.cyclicIds.has(request.featureId) &&
          !failedBodies.has(projectionBodyFeatureId(request.source)),
      ),
      projections,
      projectedByFeature,
      projectionErrors,
      attemptedProjections,
      settled,
    );
    if (options.shouldCancel?.()) {
      return cancelledResult(generation);
    }
    if (
      (projected || changedSources.size > 0) &&
      settled.size > countBefore &&
      pass + 1 < schedule.maxPasses
    ) {
      continue;
    }

    for (const id of schedule.cyclicIds) {
      dependencyErrors.set(id, {
        featureId: id,
        code: 'circularReference',
        message: `参照・投影の依存が循環しています: ${[...schedule.cyclicIds].join('、')}`,
      });
    }
    for (const id of pendingIds) {
      if (!dependencyErrors.has(id) && !projectionErrors.has(id)) {
        const reason = resolved.errors.find((error) => error.featureId === id)?.message;
        dependencyErrors.set(id, {
          featureId: id,
          code: 'missingBody',
          message: `参照・投影の依存を解決できず、再計算を停止しました: ${id}` +
            (reason === undefined ? '' : `。${reason}`),
        });
      }
    }
    for (const id of invalidated) {
      if (!dependencyErrors.has(id)) {
        dependencyErrors.set(id, {
          featureId: id,
          code: 'missingSubShape',
          message: `部分形状の選び直しが収束せず、再計算を停止しました: ${id}`,
        });
      }
    }
    break;
  }

  // 上流(スケッチ)から下流(ソリッド)の順に失敗を並べる。直す順序がそのまま読めるように。
  const errors: PartRecomputeError[] = [];
  const sketches: PartSketchResult[] = [];
  for (const entry of resolved.sketches) {
    errors.push(...entry.resolved.errors);
    // 拘束の失敗は解決の失敗の直後に置く(同じスケッチの話を離さない。FR-504)。
    errors.push(...entry.constraintErrors);
    const outcome = await tessellateSketch(bridge, entry.resolved);
    if (options.shouldCancel?.()) {
      return cancelledResult(generation);
    }
    errors.push(...outcome.errors);
    sketches.push({
      sketchId: entry.sketchId,
      resolved: entry.resolved,
      mesh: outcome.mesh,
      diagnosis: entry.diagnosis,
    });
  }
  errors.push(...offsetErrors);
  errors.push(...projectionErrors.values());
  errors.push(...resolved.errors.filter((error) => !dependencyErrors.has(error.featureId)));
  errors.push(...dependencyErrors.values());

  if (!solid.ok) {
    for (const step of resolved.steps) {
      errors.push(solidKernelFailed(step.featureId, solid.message));
    }
    // 呼び出しごと失敗したときは照合も行えていない。段の失敗の警告に
    // 「色を付けた面が見つかりません」を重ねないよう空で返す(FR-504)。
    return {
      sketches,
      bodies: [],
      errors,
      cacheHits: 0,
      cancelled: false,
      generation,
      appearanceMatches: [],
    };
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
    appearanceMatches: solid.outcome.appearanceMatches ?? [],
  };
}
