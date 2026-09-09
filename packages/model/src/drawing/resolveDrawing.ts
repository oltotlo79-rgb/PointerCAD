import type { DrawingDocument, DrawingSource, DrawingView, Point2, Vector3 } from '@pointercad/drawing';
import { clipCurves, type ClipRegion } from '@pointercad/drawing';
import { resolvePlaneSpec, type PlaneResolveContext, type PlaneSpec, type ResolvedPlane } from '../geometry/planeSpec.js';
import { resolveAuxiliaryDirection } from './viewDirection.js';
import { validateSectionSpec, type SectionSpec } from './sectionSpec.js';
import type { RigidPlacement } from '../assembly/placementMath.js';

export interface DrawingInstance {
  readonly bodyId: string;
  readonly occurrenceId: string;
  readonly placement: RigidPlacement;
}

export type ResolvedDrawingCurve =
  | { readonly kind: 'segment'; readonly from: Point2; readonly to: Point2 }
  | { readonly kind: 'arc'; readonly center: Point2; readonly radius: number; readonly startAngle: number; readonly endAngle: number }
  | { readonly kind: 'polyline'; readonly points: readonly Point2[]; readonly closed: boolean };

export interface DrawingProjectionCurve {
  readonly curve: ResolvedDrawingCurve;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export interface DrawingSourceResolution {
  readonly bodyIds: readonly string[];
  readonly instances?: readonly DrawingInstance[];
  /** 部品座標での中心。図ごとに投影して用紙の図中心へ合わせる(FR-702)。 */
  readonly center: Vector3;
}

export interface DrawingProjectionRequest {
  readonly bodyIds: readonly string[];
  readonly instances?: readonly DrawingInstance[];
  readonly views: readonly {
    readonly id: string;
    readonly origin: Vector3;
    readonly normal: Vector3;
    readonly xDir: Vector3;
    readonly includeHidden: boolean;
    readonly mode: 'precise' | 'poly';
  }[];
}

export interface DrawingProjectionResult {
  readonly views: readonly {
    readonly viewId: string;
    readonly visible: readonly DrawingProjectionCurve[];
    readonly hidden: readonly DrawingProjectionCurve[];
  }[];
  readonly failures: readonly { readonly viewId: string | null; readonly bodyId: string | null; readonly message: string }[];
  readonly cancelled: boolean;
}

/** UI の KernelBridge が満たす、図面解決だけの小さい差し替え口。 */
export interface DrawingResolveKernel {
  /** 抱き込んだ部品/アセンブリを再評価し、Workerキャッシュの鍵へ準備する。 */
  prepareDrawingSource(source: DrawingSource): Promise<DrawingSourceResolution>;
  hiddenLineViews(request: DrawingProjectionRequest): Promise<DrawingProjectionResult>;
  sectionViews(request: DrawingSectionRequest): Promise<DrawingSectionResult>;
}

export interface DrawingSectionRequest {
  readonly bodyIds: readonly string[];
  readonly instances?: readonly DrawingInstance[];
  readonly view: DrawingProjectionRequest['views'][number];
  readonly plane: Pick<ResolvedPlane, 'origin' | 'axisU' | 'normal'>;
  readonly keepSide: SectionSpec['keepSide'];
  readonly kind: SectionSpec['kind'];
  readonly boundary?: readonly Point2[];
}

export interface DrawingSectionResult {
  readonly viewId: string;
  readonly visible: readonly DrawingProjectionCurve[];
  readonly hidden: readonly DrawingProjectionCurve[];
  readonly cuttingCurves: readonly ResolvedDrawingCurve[];
  readonly failures: DrawingProjectionResult['failures'];
  readonly cancelled: boolean;
}

/** 文書の切断線などから得た指定。平面の式は既存のPlaneSpec解決器へ渡す。 */
export interface DrawingResolutionOptions {
  readonly planeContext?: PlaneResolveContext;
  readonly sections?: Readonly<Record<string, SectionSpec>>;
  readonly auxiliary?: Readonly<Record<string, { readonly plane: PlaneSpec; readonly originalViewV: Vector3 }>>;
  readonly partial?: Readonly<Record<string, ClipRegion>>;
}

export function createDrawingResolveKernel(
  bridge: Pick<DrawingResolveKernel, 'hiddenLineViews' | 'sectionViews'>,
  prepareDrawingSource: DrawingResolveKernel['prepareDrawingSource'],
): DrawingResolveKernel {
  return { prepareDrawingSource, hiddenLineViews: (request) => bridge.hiddenLineViews(request),
    sectionViews: (request) => bridge.sectionViews(request) };
}

export interface ResolvedDrawingView {
  readonly viewId: string;
  readonly name: string;
  readonly position: Point2;
  readonly scale: number;
  readonly visible: readonly DrawingProjectionCurve[];
  readonly hidden: readonly DrawingProjectionCurve[];
  readonly cuttingCurves: readonly ResolvedDrawingCurve[];
}

export type ResolvedDrawing =
  | {
      readonly ok: true;
      readonly views: readonly ResolvedDrawingView[];
      readonly failures: DrawingProjectionResult['failures'];
      readonly cancelled: boolean;
    }
  | { readonly ok: false; readonly message: string };

interface CachedProjection {
  readonly visible: readonly DrawingProjectionCurve[];
  readonly hidden: readonly DrawingProjectionCurve[];
  readonly cuttingCurves?: readonly ResolvedDrawingCurve[];
}

/** カーネルの寿命ごとに生の投影を覚える。用紙の位置と縮尺は鍵へ入れない。 */
const projectionCaches = new WeakMap<DrawingResolveKernel, Map<string, CachedProjection>>();

function directionKey(view: DrawingView, contentHash: string, bodyIds: readonly string[], section?: DrawingSectionRequest, instances?: readonly DrawingInstance[]): string {
  return JSON.stringify({
    contentHash,
    instances,
    bodyIds,
    direction: view.direction,
    xDir: view.xDir,
    hidden: view.showHidden,
    section: section === undefined ? null : { plane: section.plane, kind: section.kind, keepSide: section.keepSide, boundary: section.boundary },
  });
}

function transformPoint(point: Point2, center: Point2, position: Point2, scale: number): Point2 {
  return [position[0] + (point[0] - center[0]) * scale, position[1] + (point[1] - center[1]) * scale];
}

function transformCurve(
  item: DrawingProjectionCurve,
  center: Point2,
  view: DrawingView,
  scale: number,
): DrawingProjectionCurve {
  const curve = item.curve;
  if (curve.kind === 'segment') {
    return { ...item, curve: { ...curve, from: transformPoint(curve.from, center, view.position, scale), to: transformPoint(curve.to, center, view.position, scale) } };
  }
  if (curve.kind === 'arc') {
    return { ...item, curve: { ...curve, center: transformPoint(curve.center, center, view.position, scale), radius: curve.radius * scale } };
  }
  return { ...item, curve: { ...curve, points: curve.points.map((point) => transformPoint(point, center, view.position, scale)) } };
}

/**
 * 埋め込み元を再評価し、未計算の方向だけを1回のWorker往復で投影して用紙mmへ写す。
 * 生の投影は縮尺と独立なので、縮尺・位置の変更ではカーネルを呼ばない。
 */
export async function resolveDrawing(
  document: DrawingDocument,
  kernel: DrawingResolveKernel,
  options: DrawingResolutionOptions = {},
): Promise<ResolvedDrawing> {
  let source: DrawingSourceResolution;
  try { source = await kernel.prepareDrawingSource(document.source); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : '図にできる立体がありません。' }; }
  if (source.bodyIds.length === 0) return { ok: false, message: '図にできる立体がありません。' };
  const effectiveViews: DrawingView[] = [];
  const sections = new Map<string, DrawingSectionRequest>();
  for (const original of document.views) {
    let view = original;
    const auxiliary = options.auxiliary?.[view.id];
    if (auxiliary !== undefined) {
      if (options.planeContext === undefined) return { ok: false, message: 'この面からは向きが決まりません。' };
      const direction = resolveAuxiliaryDirection(auxiliary.plane, options.planeContext, auxiliary.originalViewV);
      if (!direction.ok) return direction;
      view = { ...view, direction: direction.direction.normal, xDir: direction.direction.xDir };
    }
    const spec = options.sections?.[view.id] ?? (view.section === undefined ? undefined : options.sections?.[view.section.cuttingLineId]);
    if (spec !== undefined) {
      const invalid = validateSectionSpec(spec);
      if (invalid !== null) return { ok: false, message: invalid };
      if (options.planeContext === undefined) return { ok: false, message: '切断面の向きを決められません。' };
      const plane = resolvePlaneSpec(spec.plane, options.planeContext);
      if (!plane.ok) return { ok: false, message: plane.message };
      sections.set(view.id, { bodyIds: source.bodyIds, instances: source.instances, view: projectionRequest(view.id, view),
        plane: plane.plane, keepSide: spec.keepSide, kind: spec.kind, boundary: spec.boundary });
    } else if (view.kind === 'section') return { ok: false, message: '切断面の位置を決められません。' };
    effectiveViews.push(view);
  }
  let cache = projectionCaches.get(kernel);
  if (cache === undefined) {
    cache = new Map();
    projectionCaches.set(kernel, cache);
  }

  const representatives = new Map<string, DrawingView>();
  for (const view of effectiveViews) {
    const key = directionKey(view, document.source.contentHash, source.bodyIds, sections.get(view.id), source.instances);
    if (!cache.has(key) && !representatives.has(key)) representatives.set(key, view);
  }

  let failures: DrawingProjectionResult['failures'] = [];
  let cancelled = false;
  if (representatives.size > 0) {
    const entries = [...representatives.entries()].filter(([, view]) => !sections.has(view.id));
    const result = entries.length === 0 ? { views: [], failures: [], cancelled: false } : await kernel.hiddenLineViews({
      bodyIds: source.bodyIds,
      instances: source.instances,
      views: entries.map(([key, view]) => projectionRequest(key, view)),
    });
    failures = result.failures;
    cancelled = result.cancelled;
    for (const projected of result.views) {
      cache.set(projected.viewId, { visible: projected.visible, hidden: projected.hidden });
    }
    for (const [key, view] of representatives) {
      if (cancelled) break;
      const section = sections.get(view.id);
      if (section === undefined) continue;
      const cut = await kernel.sectionViews({ ...section, view: { ...section.view, id: key } });
      failures = [...failures, ...cut.failures]; cancelled = cut.cancelled;
      if (!cut.cancelled && cut.failures.length === 0) cache.set(key, cut);
    }
  }

  const views: ResolvedDrawingView[] = [];
  for (const view of effectiveViews) {
    const raw = cache.get(directionKey(view, document.source.contentHash, source.bodyIds, sections.get(view.id), source.instances));
    if (raw === undefined) continue;
    const scale = view.scale ?? document.sheet.scale;
    const center = projectedCenter(source.center, view);
    const clip = options.partial?.[view.id];
    const mapped = (curves: readonly DrawingProjectionCurve[]): readonly DrawingProjectionCurve[] => {
      const clipped = clip === undefined ? curves : curves.flatMap((item) => clipCurves([item.curve], clip).map((curve) => ({ ...item, curve })));
      return clipped.map((curve) => transformCurve(curve, center, view, scale));
    };
    views.push({
      viewId: view.id,
      name: view.name,
      position: view.position,
      scale,
      visible: mapped(raw.visible),
      hidden: mapped(raw.hidden),
      cuttingCurves: (raw.cuttingCurves ?? []).map((curve) => transformCurve({ curve, provenance: {} }, center, view, scale).curve),
    });
  }
  return { ok: true, views, failures, cancelled };
}

function projectionRequest(id: string, view: DrawingView): DrawingProjectionRequest['views'][number] {
  return { id, origin: [0, 0, 0], normal: view.direction, xDir: view.xDir, includeHidden: view.showHidden, mode: 'precise' };
}

function projectedCenter(center: Vector3, view: DrawingView): Point2 {
  const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const normalLength = Math.hypot(...view.direction);
  const n: Vector3 = [view.direction[0] / normalLength, view.direction[1] / normalLength, view.direction[2] / normalLength];
  const along = dot(view.xDir, n);
  const projected: Vector3 = [view.xDir[0] - along * n[0], view.xDir[1] - along * n[1], view.xDir[2] - along * n[2]];
  const length = Math.hypot(...projected);
  const u: Vector3 = [projected[0] / length, projected[1] / length, projected[2] / length];
  const v: Vector3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return [dot(center, u), dot(center, v)];
}

/** テスト・文書破棄時に、そのカーネルの投影記憶だけを捨てる。 */
export function clearDrawingProjectionCache(kernel: DrawingResolveKernel): void {
  projectionCaches.delete(kernel);
}
