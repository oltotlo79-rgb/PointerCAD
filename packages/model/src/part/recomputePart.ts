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
 *
 * 図形の測定値を係数の式で使う文書だけは、1〜2 を依存の深さだけ繰り返し、段ごとに測った値を
 * 次の段の係数へ渡す(段階再計算、GR-06。`recomputePart` の注釈)。
 */

import { computeVolume } from '@pointercad/kernel';
import type { EmbeddedPartMesh } from '../assembly/partLibrary.js';
import { appearanceOf } from '../appearance/documentAppearance.js';
import { evaluateMathGeometry } from '../measure/mathGeometry.js';
import {
  isMathGeometryValue,
  planMathGeometryStages,
  unmeasuredMathGeometryOutcomes,
  type MathGeometryStagePlan,
} from '../measure/mathGeometryStages.js';
import type { MathGeometryOutcome } from '../measure/mathGeometryTypes.js';
import { recomputeFunctionCurves, type FunctionRecomputeContext } from '../functionGeometry/recomputeFunctionCurves.js';
import { recomputeFunctionSurfaces } from '../functionGeometry/recomputeFunctionSurfaces.js';
import { recomputeFunctionPoints } from '../functionGeometry/recomputeFunctionPoints.js';
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
  SolidRecomputeOptions,
} from '../kernelBridge.js';
import type { ConstraintDiagnosis } from '../sketch/constraints/diagnose.js';
import { createOffsetCache, type OffsetCache } from '../sketch/offsetMath.js';
import { createProjectionCache, type ProjectionCache } from '../sketch/projectionMath.js';
import { mapSketchCoordinates } from '../sketch/mapCoordinates.js';
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
import { evaluateDocumentMath, hasDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import type { ParameterAnalysis } from '../parameters/types.js';
import { createSubShapeCache, type SubShapeCache } from './subShapeCache.js';
import { readReferenceBodies, ReferenceMeshScope, type ReferenceBodyReads } from './readReferenceBodies.js';
import { historyDependencies } from './timelineOrder.js';
import type { PartDocument } from './types.js';
import type { MathGeometryOutcome as TypeMathGeometryOutcome, MathGeometryRequest as TypeMathGeometryRequest } from '../measure/mathGeometryTypes.js';


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
  /** Actual main-realm backings, never attributed to the Worker. Includes source and owned copies. */
  readonly mainMeshBacking?: { readonly buffers: readonly ArrayBuffer[]; readonly retainedBackingBytes: number; readonly limitBytes: number };
  /** Actual current upstream bodies, separate from displayed final bodies and never saved. */
  readonly referenceBodies?: readonly SolidBody[];
  readonly referenceMeshScope?: ReferenceMeshScope;
  /** Only quantities read from this completed generation; never stored as replacement formulae. */
  readonly mathGeometry?: readonly TypeMathGeometryOutcome[];
  /** Current-generation scalar mathematics, for the parameter view; absent until all formulas are verified. */
  readonly parameterAnalysis?: ParameterAnalysis;
  /** 実カーネルで成功し表示される板金のパネル。失敗段や消費済みボディは貸さない。 */
  readonly sheetMetalBodies?: ResolvedPart['sheetMetalBodies'];
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
  /**
   * 計算を終えた時点の形状計算部のメモリの量(NFR-PF-6)。カーネルが添えたときだけ入る。
   * ソリッドの段まで進まなかった結果(段が無い・数式の前段で止まった・Worker が壊れた等)には
   * 入らないので、画面は前に受け取った量を持ち続ける(量は計算部の事実で、文書の事実ではない)。
   */
  readonly kernelMemory?: SolidRecomputeOutcome['kernelMemory'];
  /** Only this document's final dispatch receipt; never a sum of intermediate requests. */
  readonly meshJsAccounting?: NonNullable<SolidRecomputeOutcome['meshJsAccounting']>
    & { readonly documentId: string };
}

export interface PartRecomputeOptions {
  /** Internal scope; recomputePart always replaces caller-supplied values with its own owner. */
  readonly referenceMeshScope?: ReferenceMeshScope;
  /** Typed geometry references. Missing targets remain unresolved, never replaced with saved coordinates. */
  readonly mathGeometry?: readonly TypeMathGeometryRequest[];
  /** Required for new mathematical definitions; absent evaluators must never use cached coordinates. */
  readonly math?: DocumentMathContext;
  readonly functions?: FunctionRecomputeContext;
  /** 最終巡回の解決結果を、取消でない完了時に同じ参照で 1 回だけ通知する。 */
  readonly onResolved?: (resolved: ResolvedPart) => void;
  /** 文書/session 内で安定した部品の識別子。橋へそのまま渡す。 */
  readonly partId?: string;
  /** Explicit display-only opt-in. Production callers continue to omit this. */
  readonly localMesh?: SolidRecomputeOptions['localMesh'];
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
  /** Captured document attachments; never substitute saved volume for triangle geometry. */
  readonly importedMeshes?: ReadonlyMap<string, EmbeddedPartMesh>;
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
 * 中で行う」ため)。面による切断の詳細な理由コードは reason に保持する。
 */
function solidKernelFailed(featureId: string, message: string, reason?: PartError['reason']): PartError {
  const code: PartErrorCode = message.includes(MISSING_SUB_SHAPE_SUFFIX)
    ? 'missingSubShape'
    : 'kernelFailed';
  return { featureId, code, message, ...(reason === undefined ? {} : { reason }) };
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
  if (resolved.steps.length === 0 && options.localMesh === undefined) {
    return { ok: true, outcome: NO_SOLIDS };
  }
  try {
    return {
      ok: true,
      outcome: await bridge.recomputeSolids(resolved.steps, {
        partId: options.partId,
        generation,
        onProgress: options.onProgress,
        shouldCancel: options.shouldCancel,
        appearance,
        // 既定は測らない(NFR-PF-2〜3。§0.a-0.67「穴 20 個の性能の余裕を削らない」)。
        measureAreas: options.measureAreas ?? false,
        ...(options.localMesh === undefined ? {} : { localMesh: options.localMesh }),
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
  const graph = new Map(historyDependencies(active, { includeSelf: true }));
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

/**
 * 途中の形・スケッチ・診断を適用させない。generationは依頼開始時の番号だけを返す。
 * ソリッドの段で取り消されたときだけ、カーネルが添えたメモリの量(NFR-PF-6)を渡す。
 */
function cancelledResult(
  generation: number,
  kernelMemory?: SolidRecomputeOutcome['kernelMemory'],
): PartRecomputeResult {
  return {
    sketches: [],
    bodies: [],
    errors: [],
    cacheHits: 0,
    cancelled: true,
    generation,
    appearanceMatches: [],
    ...(kernelMemory === undefined ? {} : { kernelMemory }),
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
 *
 * ## 図形の測定値を使う係数(段階再計算、GR-06。計画書 §4(d)、利用者の回答 Q7=O1)
 *
 * 係数の式が図形の測定値(`coef("名前")`)を使うと、その係数で作る形は、測る形ができて測り
 * 終わるまで作れない。そこで**図形由来の係数がある文書だけ**、`planMathGeometryStages` の段取りに
 * 従って「それまでに測った値で数式を評価 → 形を作る → その段の定義を測る」を段の数(最大8)だけ
 * 繰り返し(`measureStages`)、最後に全部の値で数式を評価して形を作り、全部の定義を測る。
 *
 * - 図形由来の係数が無い文書には途中の段が無く、今までと同じ 1 回だけの経路を通る
 *   (`recomputeSolids` などの呼出し回数・順序・結果を変えない)。
 * - 循環・順序違反・段数超過に関わる係数は、形を作る前に理由付きで止める(`DocumentMathContext.blocked`)。
 *   古い値や以前の世代の測定値では回さない。まだ測っていない値を使う係数とその利用先は、その段では作らない。
 * - 途中の段も同じ `partId` で `recomputeSolids` を呼ぶ(投影の巡回と同じ扱いで、表示の登録は最後の段が決める)。
 *   隠れた上流の形は `evaluateMathGeometry` が読取専用の `readCachedBodies` で読み、表示扱いにしない。
 * - 段ごとに取消を確かめ、取り消されたら途中の値も `onResolved` も残さない。`onResolved` は最後の段で
 *   1 回だけ呼ぶ。途中の段の失敗の一覧と形は捨て、結果は最後の段だけから作る。
 */
/** Main-realm attachment and owned display copies, separate from the Worker receipt. */
interface CapturedImportedMeshes {
  readonly meshes: ReadonlyMap<string, EmbeddedPartMesh>;
  readonly failures: ReadonlyMap<string, string>;
  readonly backing: NonNullable<PartRecomputeResult['mainMeshBacking']>;
}

function captureImportedMeshes(document: PartDocument, options: PartRecomputeOptions): CapturedImportedMeshes {
  const meshes = new Map<string, EmbeddedPartMesh>();
  const failures = new Map<string, string>();
  const buffers = new Set<ArrayBuffer>();
  let retainedBackingBytes = 0;
  const limit = options.localMesh?.maximumLiveMeshBytes ?? 512 * 1024 * 1024;
  for (const feature of document.solids) {
    if (feature.kind !== 'importedMesh' || feature.suppressed || meshes.has(feature.meshRef)
      || failures.has(feature.meshRef)) continue;
    const source = options.importedMeshes?.get(feature.meshRef);
    const fail = (message: string): void => { failures.set(feature.meshRef, message); };
    if (source === undefined) { fail('Imported triangle attachment is missing'); continue; }
    const { positions, normals, indices } = source;
    if (!(positions instanceof Float32Array) || !(normals instanceof Float32Array)
      || !(indices instanceof Uint32Array) || positions.length === 0 || positions.length % 3 !== 0
      || normals.length !== positions.length || indices.length === 0 || indices.length % 3 !== 0
      || !positions.every(Number.isFinite) || !normals.every(Number.isFinite)
      || !indices.every(index => index < positions.length / 3)) {
      fail('Imported triangle attachment is invalid'); continue;
    }
    const inputBuffers = new Set<ArrayBuffer>();
    let invalidBacking = false;
    for (const array of [positions, normals, indices]) {
      if (!(array.buffer instanceof ArrayBuffer)
        || ('resizable' in array.buffer && array.buffer.resizable === true)) invalidBacking = true;
      else inputBuffers.add(array.buffer);
    }
    if (invalidBacking) { fail('Imported triangle backing is not fixed'); continue; }
    const sourceBytes = [...inputBuffers].reduce((sum, buffer) => sum + (buffers.has(buffer) ? 0 : buffer.byteLength), 0);
    const copyBytes = positions.byteLength + normals.byteLength + indices.byteLength;
    const next = retainedBackingBytes + sourceBytes + copyBytes;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 512 * 1024 * 1024
      || !Number.isSafeInteger(next) || next >= limit) {
      fail('Imported triangle backing exceeds the display budget'); continue;
    }
    // Capture all values before the first await. Replacing or editing attachments cannot alter this result.
    const owned = { positions: positions.slice(), normals: normals.slice(), indices: indices.slice() };
    for (const buffer of inputBuffers) buffers.add(buffer);
    buffers.add(owned.positions.buffer); buffers.add(owned.normals.buffer); buffers.add(owned.indices.buffer);
    retainedBackingBytes = next;
    meshes.set(feature.meshRef, owned);
  }
  return { meshes, failures, backing: Object.freeze({ buffers: Object.freeze([...buffers]), retainedBackingBytes, limitBytes: limit }) };
}

function importedMeshBodies(resolved: ResolvedPart, captured: CapturedImportedMeshes,
  options: PartRecomputeOptions, errors: PartRecomputeError[]): readonly SolidBody[] {
  const bodies: SolidBody[] = [];
  for (const entry of resolved.meshBodies) {
    if (!entry.visible) continue;
    const mesh = captured.meshes.get(entry.meshRef);
    const failure = captured.failures.get(entry.meshRef);
    if (mesh === undefined || failure !== undefined || mesh.indices.length / 3 !== entry.triangleCount) {
      errors.push(solidKernelFailed(entry.featureId, failure ?? 'Imported triangle count does not match its attachment'));
      continue;
    }
    const volume = computeVolume(mesh.positions, mesh.indices);
    if (!Number.isFinite(volume)) {
      errors.push(solidKernelFailed(entry.featureId, 'Imported triangle volume is not finite')); continue;
    }
    // Float32 source values remain exact: origin zero introduces no conversion error.
    bodies.push({ featureId: entry.featureId, mesh: { ...mesh, edgePositions: new Float32Array(0),
      triangleCount: mesh.indices.length / 3 }, volume, bodyKind: 'mesh', isValid: true,
      faces: [], edges: [], vertices: [], threadMarks: [],
      ...(options.localMesh === undefined ? {} : { coordinateFrame: { space: 'local', origin: [0, 0, 0],
        maximumFloat32ErrorMm: options.localMesh.maximumFloat32ErrorMm,
        maximumLiveMeshBytes: options.localMesh.maximumLiveMeshBytes } }) });
  }
  return bodies;
}

export async function recomputePart(
  document: PartDocument,
  bridge: KernelBridge,
  options: PartRecomputeOptions = {},
): Promise<PartRecomputeResult> {
  if (options.shouldCancel?.()) return cancelledResult(options.generation ?? 0);
  const capturedMeshes = captureImportedMeshes(document, options);
  const scope = new ReferenceMeshScope(document, Object.freeze({ partId: options.partId ?? 'part:current',
    generation: options.generation ?? 0, maximumLiveMeshBytes: (options.localMesh?.maximumLiveMeshBytes ?? 512 * 1024 * 1024) - capturedMeshes.backing.retainedBackingBytes,
    ...(options.localMesh === undefined ? {} : { localMesh: Object.freeze({ ...options.localMesh,
      maximumLiveMeshBytes: options.localMesh.maximumLiveMeshBytes - capturedMeshes.backing.retainedBackingBytes }) }) }), bridge);
  let handedOff = false;
  try {
    const run = async (): Promise<PartRecomputeResult> => {
  const generation = options.generation ?? 0;
  const requestOptions: PartRecomputeOptions = options.localMesh === undefined ? { ...options, referenceMeshScope: scope } : {
    ...options, referenceMeshScope: scope, partId: options.partId ?? 'part:current', localMesh: Object.freeze({
      maximumFloat32ErrorMm: options.localMesh.maximumFloat32ErrorMm,
      maximumLiveMeshBytes: options.localMesh.maximumLiveMeshBytes - capturedMeshes.backing.retainedBackingBytes,
    }),
  };
  if (options.shouldCancel?.()) {
    return cancelledResult(generation);
  }
  // 図形の測定値を使う係数がある文書だけ、途中の段で測った値を最後の段の数式へ渡す(GR-06)。
  const plan = planMathGeometryStages(document);
  const stage = plan === null ? undefined : await measureStages(document, bridge, requestOptions, generation, plan);
  if (stage === null) {
    return cancelledResult(generation);
  }
  const build = await buildShapes(document, bridge, requestOptions, generation, stage);
  return isShapeBuild(build) ? finishRecompute(document, bridge, requestOptions, generation, build, capturedMeshes) : build;
    };
    const result = await run();
    if (!result.cancelled && result.referenceMeshScope === scope && scope.current) handedOff = true;
    return result;
  } finally { if (!handedOff) await scope.close(); }

}

/** `buildShapes` が形を作り終えたときの中身。最後の段では `finishRecompute` が結果にまとめる。 */
interface ShapeBuild {
  readonly parameterAnalysis: ParameterAnalysis | undefined;
  readonly parameterErrors: readonly PartRecomputeError[];
  readonly resolved: ResolvedPart;
  readonly solid: SolidCallOutcome;
  readonly offsetErrors: readonly SketchError[];
  readonly projectionErrors: ReadonlyMap<string, SketchError>;
  readonly dependencyErrors: ReadonlyMap<string, PartError>;
  readonly referenceBodies: readonly SolidBody[];
}

/** 形を作る前に結果が決まった(取消・数式の前段の失敗)のではなく、形を作り終えたか。 */
function isShapeBuild(value: PartRecomputeResult | ShapeBuild): value is ShapeBuild {
  return 'resolved' in value;
}

/** 段階再計算(GR-06)の 1 段で数式の評価へ渡すもの(`DocumentMathContext` の同じ名前の欄)。 */
interface StageMath {
  /** この再計算でここまでに測った結果(定義ID → 結果)。無い定義を使う係数は「計算待ち」になる。 */
  readonly geometry: ReadonlyMap<string, MathGeometryOutcome>;
  /** 計算させない係数と理由(循環・順序違反・段数超過。`MathGeometryStagePlan.blocked`)。 */
  readonly blocked: ReadonlyMap<string, string>;
}

/** 途中の段の数式の評価が理由を返さずに失敗したときの文(`evaluateDocumentMath` の最後の文と同じ)。 */
const STAGE_MATH_FAILED_MESSAGE = '数式の再計算を完了できませんでした。';

/**
 * 途中の段で測るときに「正しく作れなかった形」とみなす id。最後の段の errors と同じ出どころ
 * (スケッチの面の三角形分割の失敗は除く。測るのは点・線・立体で、スケッチの面は測らない)。
 */
function failedIdsOf(build: ShapeBuild): ReadonlySet<string> {
  const ids = new Set<string>();
  const add = (errors: Iterable<PartRecomputeError>): void => {
    for (const error of errors) ids.add(error.featureId);
  };
  add(build.parameterErrors);
  for (const entry of build.resolved.sketches) {
    add(entry.resolved.errors);
    add(entry.constraintErrors);
  }
  add(build.offsetErrors);
  add(build.projectionErrors.values());
  add(build.resolved.errors);
  add(build.dependencyErrors.values());
  if (build.solid.ok) {
    for (const failure of build.solid.outcome.failures) ids.add(failure.featureId);
  }
  return ids;
}

/**
 * 段階再計算の途中の段(GR-06、§4(d))。段 k ごとに、それまでに測った値で形を作り、段 k の定義を測る。
 * 返すのは最後の段(全部の定義を測る段)の数式へ渡すもの。取り消されたら null(途中の値を残さない)。
 *
 * - 前に形を作ってから係数へ入る値が 1 つも増えていなければ、形を作り直さずに次の段の定義を測る。
 *   数式の評価は同じ値になり、同じ形しかできないため(測る形がその値を待つなら、形の失敗として
 *   理由付きの未解決になる)。
 * - 途中の段の呼出しごとの失敗(形の計算部・数学の計算部)では、まだ測っていない定義を理由付きの
 *   未解決にして最後の段へ進む(使う係数を「計算待ち」のまま終わらせない)。
 * - 途中の段の errors・形は結果に使わず、`onResolved` も呼ばない。
 */
async function measureStages(
  document: PartDocument,
  bridge: KernelBridge,
  options: PartRecomputeOptions,
  generation: number,
  plan: MathGeometryStagePlan,
): Promise<StageMath | null> {
  const known = new Map<string, MathGeometryOutcome>();
  const current = (): StageMath => ({ geometry: new Map(known), blocked: plan.blocked });
  // 数学の計算部が無ければどの段も数式を評価できない。最後の段が今までと同じ理由で断る。
  if (options.math === undefined) {
    return current();
  }
  let shapes: { readonly build: ShapeBuild; readonly bodies: readonly SolidBody[] } | undefined;
  let valueSinceBuild = false;
  for (const [index, definitions] of plan.stages.entries()) {
    if (definitions.length === 0) {
      continue;
    }
    /** この段から先のまだ測っていない定義を、段の失敗の理由付きで未解決にする。 */
    const giveUp = (message: string): StageMath => {
      const rest = plan.stages.slice(index).flat().filter((definition) => !known.has(definition.id));
      for (const outcome of unmeasuredMathGeometryOutcomes(rest, document.id, generation, message)) {
        known.set(outcome.id, outcome);
      }
      return current();
    };
    if (shapes === undefined || valueSinceBuild) {
      const build = await buildShapes(document, bridge, options, generation, current());
      if (!isShapeBuild(build)) {
        return build.cancelled ? null : giveUp(build.errors[0]?.message ?? STAGE_MATH_FAILED_MESSAGE);
      }
      if (!build.solid.ok) {
        return giveUp(build.solid.message);
      }
      shapes = { build, bodies: build.referenceBodies };
      valueSinceBuild = false;
    }
    if (options.shouldCancel?.()) {
      return null;
    }
    const outcomes = await evaluateMathGeometry(definitions, { documentId: document.id, generation,
      resolved: shapes.build.resolved, bodies: shapes.bodies, failedIds: failedIdsOf(shapes.build), bridge,
      shouldCancel: () => options.shouldCancel?.() ?? false });
    if (outcomes === null || options.shouldCancel?.()) {
      return null;
    }
    for (const outcome of outcomes) {
      known.set(outcome.id, outcome);
      valueSinceBuild ||= isMathGeometryValue(outcome);
    }
  }
  return current();
}

/**
 * 形を作るところまで(数式 → 関数作図 → 解決と立体の巡回)を 1 回行う。取消と数式の前段の失敗では、
 * 形を作らずにその場で結果を返す。`stage` は段階再計算の 1 段で数式へ渡す測った値と計算させない係数で、
 * 無ければ今までどおりの 1 回だけの再計算と同じ評価をする。
 */
async function buildShapes(
  document: PartDocument,
  bridge: KernelBridge,
  options: PartRecomputeOptions,
  generation: number,
  stage: StageMath | undefined,
): Promise<PartRecomputeResult | ShapeBuild> {
  let evaluated: PartDocument;
  let parameterAnalysis: ParameterAnalysis | undefined;
  let invalidInputs: ReadonlyMap<string, string> | undefined;
  const parameterErrors: PartRecomputeError[] = [];
  if (hasDocumentMath(document)) {
    const math = options.math;
    if (math === undefined) return { sketches: [], bodies: [], cacheHits: 0, cancelled: false, generation,
      errors: [{ featureId: document.id, code: 'invalidValue', message: '数学計算部を準備できません。数式の再計算後に作図してください。' }] };
    // 段階再計算の段では、この再計算で測った値と計算させない係数を渡す(呼出し側の値は使わない)。
    const result = await evaluateDocumentMath(document, { ...math, ...stage, isCurrent: () => !options.shouldCancel?.() && math.isCurrent() });
    if (!result.ok) {
      if (result.cancelled) return cancelledResult(generation);
      if (result.recompute === undefined) return { sketches: [], bodies: [], cacheHits: 0, cancelled: false, generation,
        errors: result.failures.map(failure => ({ featureId: failure.ownerId, code: 'invalidValue', message: failure.message })) };
      evaluated = result.recompute.document;
      parameterAnalysis = result.recompute.analysis;
      invalidInputs = result.recompute.invalidInputs;
      parameterErrors.push(...parameterAnalysis.failures.map(failure => ({ featureId: failure.name, code: 'invalidValue' as const, message: failure.message })));
    } else {
      evaluated = result.document;
      parameterAnalysis = result.analysis;
    }
  } else evaluated = applyParameters(document).document;
  const functions = await recomputeFunctionCurves(evaluated, bridge, parameterAnalysis, options.math,
    options.functions, invalidInputs, () => options.shouldCancel?.() ?? false);
  if (functions.cancelled) return cancelledResult(generation);
  const surfaces = await recomputeFunctionSurfaces(evaluated, parameterAnalysis, options.math,
    options.functions, functions.invalidInputs, () => options.shouldCancel?.() ?? false);
  if (surfaces.cancelled) return cancelledResult(generation);
  const functionPoints = await recomputeFunctionPoints(evaluated, parameterAnalysis, options.math,
    options.functions, surfaces.invalidInputs, () => options.shouldCancel?.() ?? false);
  if (functionPoints.cancelled) return cancelledResult(generation);
  invalidInputs = functionPoints.invalidInputs;
  // 解決そのものは OCCT を呼ばない純関数のままで、形は覚え書き越しに差し込む。
  const offsets = options.offsets ?? createOffsetCache();
  const projections = options.projections ?? createProjectionCache();
  const subShapes = options.subShapes ?? createSubShapeCache();
  const referenceReads: ReferenceBodyReads = options.referenceMeshScope?.reads ?? new Map<string, Parameters<ReferenceBodyReads['set']>[1]>();
  /** この再計算の中で埋まった投影・交差の曲線(フィーチャーの id で引く)。 */
  const projectedByFeature = new Map<string, readonly ResolvedCurve[]>();
  const askedSubShapes = new Map<
    string,
    { readonly reference: SubShapeRef; readonly value: string }
  >();
  const schedule = dependencySchedule(recomputeDependencies(evaluated));
  const blockedReferenceSources = new Set([...schedule.cyclicIds, ...schedule.downstream(schedule.cyclicIds)]);
  const currentSubShape = (reference: SubShapeRef) => blockedReferenceSources.has(reference.bodyFeatureId)
    ? null : subShapes.resolve(reference);
  const resolveSubShape = (reference: SubShapeRef) => {
    const value = currentSubShape(reference);
    askedSubShapes.set(fingerprintKeyText(reference), { reference, value: JSON.stringify(value) });
    return value;
  };
  const resolveOptions: ResolvePartOptions = {
    invalidInputs,
    offsetCurves: (key) => offsets.get(key),
    projectedCurves: (featureId) => projectedByFeature.get(featureId) ?? null,
    functionCurves: featureId => functions.curves.get(featureId) ?? null,
    functionSurfaces: featureId => surfaces.plans.get(featureId) ?? null,
    functionPoint: functionPoints.resolve,
    subShape: resolveSubShape,
    // 読み込んだ形のバイト列(FR-802、P6 §2.8)。渡されなければ resolvePart が空として扱う。
    importedShapes: options.importedShapes,
  };

  const offsetErrors: SketchError[] = [];
  const projectionErrors = new Map<string, SketchError>();
  const dependencyErrors = new Map<string, PartError>();
  const attemptedProjections = new Set<string>();
  const settled = new Set<string>();
  // 外観の割り当ては解決の結果に影響しないので、巡ごとに作り直さず 1 回だけ集める。
  const appearance = toAppearanceRequests(evaluated);
  let resolved: ResolvedPart;
  let solid: SolidCallOutcome;
  let currentReferenceBodies: readonly SolidBody[] = [];
  // 始点などの失敗で後続の座標が未評価でも、同じ巡で全明示参照を現在bodyへ照合する。
  const coordinateReferences: SubShapeRef[] = [];
  for (const sketch of evaluated.sketches) for (const feature of sketch.features) {
    mapSketchCoordinates(feature, input => {
      if (input.mode !== 'absolute' && input.base.kind === 'subShape') coordinateReferences.push(input.base.ref);
      return input;
    });
  }
  for (let pass = 0; ; pass += 1) {
    if (options.shouldCancel?.()) {
      return cancelledResult(generation);
    }
    offsetErrors.length = 0;
    askedSubShapes.clear();
    for (const reference of coordinateReferences) resolveSubShape(reference);
    resolved = await resolveWithOffsets(evaluated, bridge, offsets, resolveOptions, offsetErrors);
    if (options.shouldCancel?.()) {
      return cancelledResult(generation);
    }
    solid = await callSolids(bridge, resolved, generation, options, appearance);
    if (options.shouldCancel?.() || (solid.ok && solid.outcome.cancelled)) {
      return cancelledResult(generation, solid.ok ? solid.outcome.kernelMemory : undefined);
    }
    if (!solid.ok) {
      // 通信全体の失敗でも、保存指紋で暫定解決した作図を確定公開しない。
      // 失敗した全段の診断を保持し、形状参照を無効化して純な解決だけを行う。
      for (const step of resolved.steps) dependencyErrors.set(step.featureId, solidKernelFailed(step.featureId, solid.message));
      projectedByFeature.clear();
      subShapes.refresh([]);
      offsetErrors.length = 0;
      resolved = await resolveWithOffsets(evaluated, bridge, offsets, resolveOptions, offsetErrors);
      if (options.shouldCancel?.()) return cancelledResult(generation);
      break;
    }

    // ①いまの形で面・辺・頂点を選び直す(上流追従)。②投影・交差の曲線を埋める。
    const countBefore = settled.size;
    const changedSources = new Set<string>();
    const referenceBodies = await readReferenceBodies({ steps: resolved.steps, bodies: solid.outcome.bodies,
      // 平面穴の面参照はkernelで解決するため、作図のaskedSubShapesには入らない。
      // 編集用の現在基準も同じ世代のhidden leaseで読み、表示bodyへは混ぜない。
      featureIds: [...askedSubShapes.values()].map(asked => asked.reference.bodyFeatureId).concat(
        resolved.steps.flatMap(step => (step.plan.kind === 'hole' || step.plan.kind === 'thread')
          && step.plan.planar !== undefined ? [step.plan.face.bodyFeatureId] : []),
      ),
      failedIds: new Set([...solid.outcome.failures.map(failure => failure.featureId),
        ...resolved.errors.map(error => error.featureId)]), bridge, reads: referenceReads, scope: options.referenceMeshScope, features: evaluated.solids,
      shouldCancel: () => options.shouldCancel?.() ?? false });
    if (referenceBodies.cancelled) return cancelledResult(generation, solid.outcome.kernelMemory);
    currentReferenceBodies = referenceBodies.bodies;
    if (subShapes.refresh(referenceBodies.bodies)) {
      const bodyKeys = new Map(resolved.steps.map((step) => [step.featureId, step.key]));
      for (const [key, asked] of askedSubShapes) {
        if (asked.value !== JSON.stringify(currentSubShape(asked.reference))) {
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
      // 全立体が削除され依存グラフが空でも、暫定の保存位置を null の判定へ
      // 差し替える解決を1回は行う。現在形状の再検証前のスケッチを公開しない。
      pass + 1 < Math.max(2, schedule.maxPasses)
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
  return { parameterAnalysis, parameterErrors, resolved, solid, offsetErrors, projectionErrors, dependencyErrors,
    referenceBodies: currentReferenceBodies };
}

/**
 * 作った形から、スケッチの面・失敗の一覧・図形の測定値をまとめて結果にする。段階再計算では最後の段だけ
 * がここへ来る。`onResolved` はここで 1 回だけ呼ぶ(取消なら呼ばない)。
 */
async function finishRecompute(
  document: PartDocument,
  bridge: KernelBridge,
  options: PartRecomputeOptions,
  generation: number,
  build: ShapeBuild,
  capturedMeshes: CapturedImportedMeshes,
): Promise<PartRecomputeResult> {
  const { parameterAnalysis, parameterErrors, resolved, solid, offsetErrors, projectionErrors, dependencyErrors } = build;
  // 上流(スケッチ)から下流(ソリッド)の順に失敗を並べる。直す順序がそのまま読めるように。
  const errors: PartRecomputeError[] = [...parameterErrors];
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
    options.onResolved?.(resolved);
    for (const step of resolved.steps) {
      if (!dependencyErrors.has(step.featureId)) errors.push(solidKernelFailed(step.featureId, solid.message));
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
      ...(parameterAnalysis === undefined ? {} : { parameterAnalysis }),
    };
  }

  for (const failure of solid.outcome.failures) {
    errors.push(solidKernelFailed(failure.featureId, failure.message, failure.code));
  }
  const geometryRequests = document.mathGeometry === undefined ? options.mathGeometry
    : [...document.mathGeometry, ...(options.mathGeometry ?? [])];
  const mathGeometry = geometryRequests === undefined ? undefined
    : await evaluateMathGeometry(geometryRequests, { documentId: document.id, generation,
      resolved, bodies: build.referenceBodies, failedIds: new Set(errors.map(error => error.featureId)), bridge,
      shouldCancel: () => options.shouldCancel?.() ?? false });
  if (mathGeometry === null || options.shouldCancel?.()) return cancelledResult(generation);
  const importedBodies = importedMeshBodies(resolved, capturedMeshes, options, errors);
  if (options.shouldCancel?.()) return cancelledResult(generation);
  options.onResolved?.(resolved);
  // NFR-RE-1: independent successful bodies keep their certified display receipt alongside errors.
  const meshJsAccounting = solid.outcome.meshJsAccounting;
  const bodies = importedBodies.length === 0 ? solid.outcome.bodies : [...solid.outcome.bodies, ...importedBodies];
  return {
    ...(mathGeometry === undefined ? {} : { mathGeometry }),
    sketches,
    bodies,
    ...(capturedMeshes.backing.retainedBackingBytes === 0 ? {} : { mainMeshBacking: capturedMeshes.backing }),
    referenceBodies: build.referenceBodies.filter(body => body.isValid && !failedIdsOf(build).has(body.featureId)),
    ...(options.referenceMeshScope === undefined ? {} : { referenceMeshScope: options.referenceMeshScope }),
    ...(resolved.sheetMetalBodies === undefined ? {} : { sheetMetalBodies: new Map(solid.outcome.bodies.flatMap((body) => {
      const sheet = resolved.sheetMetalBodies?.get(body.featureId);
      return sheet === undefined ? [] : [[body.featureId, sheet] as const];
    })) }),
    errors,
    cacheHits: solid.outcome.cacheHits,
    cancelled: solid.outcome.cancelled,
    generation,
    appearanceMatches: solid.outcome.appearanceMatches ?? [],
    ...(parameterAnalysis === undefined ? {} : { parameterAnalysis }),
    ...(solid.outcome.kernelMemory === undefined ? {} : { kernelMemory: solid.outcome.kernelMemory }),
    ...(meshJsAccounting?.reading.status !== 'known' || meshJsAccounting.partId !== (options.partId ?? 'part:current')
      || meshJsAccounting.generation !== generation
      || (errors.length !== 0 && (meshJsAccounting.final?.status !== 'known' || bodies.length === 0
        || bodies.some(body => !body.isValid || errors.some(error => error.featureId === body.featureId))))
      ? {} : { meshJsAccounting: Object.freeze({
      ...meshJsAccounting, documentId: document.id,
    }) }),
  };
}
