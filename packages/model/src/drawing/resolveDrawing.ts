import type { CenterMark, DrawingDocument, DrawingRenderElement, DrawingSource, DrawingView, Point2, Vector3 } from '@pointercad/drawing';
import { applyBreak, breakDrawingCurve, checkedHatchArea, clipCurves, drawingViewBasis, hatchStyle, sectionBoundaryLoops, type ClipRegion } from '@pointercad/drawing';
import { resolvePlaneSpec, type PlaneResolveContext, type PlaneSpec, type ResolvedPlane } from '../geometry/planeSpec.js';
import { resolveAuxiliaryDirection } from './viewDirection.js';
import { validateSectionSpec, type SectionSpec } from './sectionSpec.js';
import type { RigidPlacement } from '../assembly/placementMath.js';
import type { DrawingDimensionInstance } from './dimensionTarget.js';
import type { BomRow } from '../assembly/bom.js';
import type { HoleScheduleResult } from './holeSchedule.js';
import { resolveViewConstructions, type ConstructedDrawingView } from './viewConstruction.js';
import { projectionCenterMarkGroups } from './projectionCenterMarks.js';
import { addDrawingViewDecorations } from './viewDecorations.js';
import { addSheetBendDecorations } from './sheetBendDecorations.js';
import type { SheetFlatGeometry } from '../sheetMetal/unfoldSheetBody.js';
import type { SheetFlatOutline } from '../sheetMetal/flatOutline.js';
import type { SheetFlatBendLine } from '../sheetMetal/flatBendLines.js';

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
  /** 派生した製造指示。PCADDには元部品と展開条件だけを保存する。 */
  readonly sheetFlat?: { readonly geometry: SheetFlatGeometry; readonly outline: SheetFlatOutline; readonly bends: readonly SheetFlatBendLine[] };
  readonly viewFrames?: ReadonlyMap<string, ConstructedDrawingView>;
  readonly bomRows?: readonly BomRow[];
  readonly holeTables?: ReadonlyMap<string, HoleScheduleResult>;
  readonly dimensionInstances?: readonly DrawingDimensionInstance[];
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
  readonly cuttingAreas?: readonly { readonly bodyId: string; readonly occurrenceId: string | null;
    readonly point: Vector3; readonly normal: Vector3; readonly curves: readonly ResolvedDrawingCurve[] }[];
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
  /** 紙面mmの細い破断線。元形状の辺ではないので寸法参照へ変換しない。 */
  readonly breakCurves?: readonly ResolvedDrawingCurve[];
  readonly hatchCurves?: readonly ResolvedDrawingCurve[];
  readonly centerCurves?: readonly ResolvedDrawingCurve[];
  /** 非表示にした組も含む、個別の表示切替に使う出自付き中心マーク。 */
  readonly centerMarks?: readonly CenterMark[];
  readonly decorations?: readonly DrawingRenderElement[];
  /** 省略・切り抜き前の紙面輪郭と実平面。切り口の奥にある元の面を選択させない。 */
  readonly cuttingAreas?: readonly { readonly point: Vector3; readonly normal: Vector3; readonly loops: readonly (readonly Point2[])[] }[];
}

export type ResolvedDrawing =
  | {
      readonly ok: true;
      readonly views: readonly ResolvedDrawingView[];
      readonly viewFrames?: ReadonlyMap<string, ConstructedDrawingView>;
      readonly failures: DrawingProjectionResult['failures'];
      readonly cancelled: boolean;
    }
  | { readonly ok: false; readonly message: string };

interface CachedProjection {
  readonly visible: readonly DrawingProjectionCurve[];
  readonly hidden: readonly DrawingProjectionCurve[];
  readonly cuttingCurves?: readonly ResolvedDrawingCurve[];
  readonly cuttingAreas?: DrawingSectionResult['cuttingAreas'];
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
  return resolveDrawingWithSource(document, kernel, source, options);
}

/** 再評価済みの同じ元形状を投影と寸法の双方へ使う。 */
export async function resolveDrawingWithSource(
  document: DrawingDocument, kernel: DrawingResolveKernel, source: DrawingSourceResolution,
  options: DrawingResolutionOptions = {},
): Promise<ResolvedDrawing> {
  if (source.bodyIds.length === 0) return { ok: false, message: '図にできる立体がありません。' };
  const construction = resolveViewConstructions(document, source);
  if (!construction.ok) return construction;
  const viewFrames = construction.views;
  const effectiveViews: DrawingView[] = [];
  const sections = new Map<string, DrawingSectionRequest>();
  for (const original of document.views) {
    const frame = viewFrames.get(original.id);
    let view = frame?.view ?? original;
    if (drawingViewBasis({ normal: view.direction, xDir: view.xDir }) === null) {
      return { ok: false, message: 'この向きでは図を作れません。' };
    }
    const auxiliary = options.auxiliary?.[view.id];
    if (auxiliary !== undefined) {
      if (options.planeContext === undefined) return { ok: false, message: 'この面からは向きが決まりません。' };
      const direction = resolveAuxiliaryDirection(auxiliary.plane, options.planeContext, auxiliary.originalViewV);
      if (!direction.ok) return direction;
      view = { ...view, direction: direction.direction.normal, xDir: direction.direction.xDir };
    }
    const spec = options.sections?.[view.id] ?? (view.section === undefined ? undefined : options.sections?.[view.section.cuttingLineId]);
    if (frame?.section !== undefined) {
      sections.set(view.id, { bodyIds: source.bodyIds, instances: source.instances, view: projectionRequest(view.id, view), ...frame.section });
    } else if (spec !== undefined) {
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
    if (!Number.isFinite(scale) || scale <= 0) return { ok: false, message: '図の縮尺を正しく指定してください。' };
    const frame = viewFrames.get(view.id);
    const center = projectedCenter(frame?.modelCenter ?? source.center, view);
    const clip = options.partial?.[view.id];
    const clips = [...(frame?.clips ?? []), ...(clip === undefined ? [] : [clip])];
    const mapped = (curves: readonly DrawingProjectionCurve[]): readonly DrawingProjectionCurve[] => {
      let clipped = curves;
      for (const region of clips) clipped = clipped.flatMap((item) => clipCurves([item.curve], region).map((curve) => ({ ...item, curve })));
      return clipped.map((curve) => transformCurve(curve, center, view, scale));
    };
    const visible = mapped(raw.visible), hidden = mapped(raw.hidden);
    const cutting = mapped((raw.cuttingCurves ?? []).map((curve) => ({ curve, provenance: {} })));
    const breakSpec = frame?.breakSpec;
    const broken = (curves: readonly DrawingProjectionCurve[]): readonly DrawingProjectionCurve[] => breakSpec === undefined ? curves
      : curves.flatMap((item) => breakDrawingCurve(item.curve, breakSpec).map((curve) => ({ ...item, curve })));
    const paperPointToRaw = (point: Point2): Point2 => [(point[0] - view.position[0]) / scale + center[0], (point[1] - view.position[1]) / scale + center[1]];
    const paperLinesToRaw = (lines: readonly { readonly from: Point2; readonly to: Point2 }[]): readonly DrawingProjectionCurve[] => lines
      .map((line) => ({ provenance: {}, curve: { kind: 'segment', from: paperPointToRaw(line.from), to: paperPointToRaw(line.to) } }));
    const cylinderFaceIds = new Set(frame?.section === undefined ? (source.dimensionInstances ?? []).flatMap((instance) => instance.body.faces
      .filter((face) => face.surfaceKind === 'cylinder').map((face) => JSON.stringify([instance.bodyId, instance.componentId ?? null, 'silhouette', face.index]))) : []);
    const centers = projectionCenterMarkGroups({ ...view, showCenterLines: true, hiddenCenterMarkIds: [] }, raw.visible,
      (point) => transformPoint(point, center, view.position, scale), scale, cylinderFaceIds);
    const centerMarks = centers.map((mark): CenterMark => ({ ...mark,
      lines: broken(mapped(paperLinesToRaw(mark.lines))).flatMap((item) => item.curve.kind === 'segment' ? [{ from: item.curve.from, to: item.curve.to }] : []) }))
      .filter((mark) => mark.lines.length > 0);
    const hiddenCenters = new Set(view.hiddenCenterMarkIds ?? []);
    const centerCurves = !view.showCenterLines ? [] : centerMarks.filter((mark) => !mark.sourceIds.some((id) => hiddenCenters.has(id)))
      .flatMap((mark) => mark.lines.map((line): ResolvedDrawingCurve => ({ kind: 'segment', ...line })));
    const breakLines = breakSpec === undefined ? null : applyBreak([...visible, ...hidden, ...cutting].map((item) => item.curve), breakSpec);
    if (breakLines?.ok === false) return breakLines;
    if (breakLines?.ok === true && breakLines.breakLines.every((line) => line.points.length === 0)) {
      return { ok: false, message: '破断区間が図の外にあります。区間を図の中へ移してください。' };
    }
    const hatchCurves: ResolvedDrawingCurve[] = [];
    const cuttingAreas: NonNullable<ResolvedDrawingView['cuttingAreas']>[number][] = [];
    const componentKeys = [...new Set((raw.cuttingAreas ?? []).map((area) => JSON.stringify([area.bodyId, area.occurrenceId])))].sort();
    for (const area of raw.cuttingAreas ?? []) {
      const paperCurves = area.curves.map((curve) => transformCurve({ curve, provenance: {} }, center, view, scale).curve);
      const loops = sectionBoundaryLoops(paperCurves);
      if (loops === null) return { ok: false, message: '切り口の輪郭を閉じられません。切断面の位置を確認してください。' };
      cuttingAreas.push({ point: area.point, normal: area.normal, loops });
      const hatch = checkedHatchArea({ loops, ...hatchStyle(componentKeys.indexOf(JSON.stringify([area.bodyId, area.occurrenceId]))) });
      if (!hatch.ok) return { ok: false, message: hatch.reason === 'budget'
        ? 'ハッチングが細かすぎます。図の縮尺や切断面の位置を調整してください。'
        : '切り口の座標を計算できません。切断面の位置を確認してください。' };
      // 先に閉じた切り口へハッチを入れ、その後で詳細/部分図の範囲に切る。
      const rawHatches = paperLinesToRaw(hatch.segments);
      hatchCurves.push(...broken(mapped(rawHatches)).map((item) => item.curve));
    }
    views.push({
      viewId: view.id,
      name: view.name,
      position: view.position,
      scale,
      visible: broken(visible),
      hidden: broken(hidden),
      cuttingCurves: broken(cutting).map((item) => item.curve),
      ...(hatchCurves.length === 0 ? {} : { hatchCurves }),
      ...(centerCurves.length === 0 ? {} : { centerCurves }),
      ...(centerMarks.length === 0 ? {} : { centerMarks }),
      ...(cuttingAreas.length === 0 ? {} : { cuttingAreas }),
      ...(breakLines?.ok === true ? { breakCurves: breakLines.breakLines
        .filter((line) => line.points.some((point) => Math.hypot(point[0] - line.points[0][0], point[1] - line.points[0][1]) > 1e-9))
        .map((line): ResolvedDrawingCurve => ({ kind: 'polyline', points: line.points, closed: false })) } : {}),
    });
  }
  const decorated = addDrawingViewDecorations(document, views, viewFrames);
  return { ok: true, views: source.sheetFlat === undefined ? decorated
    : addSheetBendDecorations(document, decorated, viewFrames, source.center, source.sheetFlat.bends), viewFrames, failures, cancelled };
}

function projectionRequest(id: string, view: DrawingView): DrawingProjectionRequest['views'][number] {
  const opposite = (value: number): number => value === 0 ? 0 : -value;
  return { id, origin: [0, 0, 0], normal: [opposite(view.direction[0]), opposite(view.direction[1]), opposite(view.direction[2])], xDir: view.xDir, includeHidden: view.showHidden, mode: 'precise' };
}

function projectedCenter(center: Vector3, view: DrawingView): Point2 {
  // DrawingView.directionは見る向き。OCCTの投影平面法線はその反対。
  const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir });
  if (basis === null) throw new Error('この向きでは図を作れません。');
  const dot = (axis: Vector3): number => axis[0] * center[0] + axis[1] * center[1] + axis[2] * center[2];
  return [dot(basis.x), dot(basis.y)];
}

/** テスト・文書破棄時に、そのカーネルの投影記憶だけを捨てる。 */
export function clearDrawingProjectionCache(kernel: DrawingResolveKernel): void {
  projectionCaches.delete(kernel);
}
