import { drawingViewBasis, type DrawingDocument, type DrawingSource, type Vector3 } from '@pointercad/drawing';
import { createDrawingResolveKernel, drawingSourceInputOf, IDENTITY_PLACEMENT, recomputePart, refreshDrawing, resolveHoleSchedule,
  type AssemblyKernelBridge, type DrawingKernelBridge, type DrawingSourceLibrary, type DrawingSourceResolution,
  type EmbeddedDrawingSource, type HoleScheduleResult, type ImportedShapeBytes, type PartDocument, type PartRecomputeOptions, type PartRecomputeResult, type ResolvedPart,
} from '@pointercad/model';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { prepareAssemblyDrawingSource, type PreparedAssemblyDrawing } from './prepareAssemblyDrawingSource.js';

export type DrawingPartRecomputer = (document: PartDocument, options: PartRecomputeOptions) => Promise<PartRecomputeResult>;
interface Request {
  readonly document: DrawingDocument;
  readonly sources: DrawingSourceLibrary;
  readonly importedShapes: ImportedShapeBytes;
  readonly documentId: string;
}
interface Prepared {
  readonly partId: string;
  readonly document: PartDocument;
  readonly importedShapes: ImportedShapeBytes;
  readonly result: DrawingSourceResolution;
  readonly resolved: ResolvedPart;
  readonly holes: Map<string, HoleScheduleResult>;
}

/** メッシュの座標全体で外接範囲を取る。球の頂点の欠落や大配列のspreadに依存しない。 */
function sourceCenter(result: PartRecomputeResult): Vector3 {
  let xmin = Infinity, ymin = Infinity, zmin = Infinity;
  let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
  for (const body of result.bodies) {
    const values = body.mesh.positions;
    for (let index = 0; index + 2 < values.length; index += 3) {
      const x = values[index], y = values[index + 1], z = values[index + 2];
      if (![x, y, z].every(Number.isFinite)) throw new Error(t('drawing.error.viewFailed'));
      xmin = Math.min(xmin, x); ymin = Math.min(ymin, y); zmin = Math.min(zmin, z);
      xmax = Math.max(xmax, x); ymax = Math.max(ymax, y); zmax = Math.max(zmax, z);
    }
  }
  if (!Number.isFinite(xmin)) throw new Error(t('drawing.error.noSolid'));
  return [(xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2];
}

/** 図面の元部品・投影・寸法を直列に更新し、最新文書だけを画面へ渡す(P8-28/39/40)。 */
export function attachDrawing(
  bridge: AssemblyKernelBridge & DrawingKernelBridge,
  recompute: DrawingPartRecomputer = (document, options) => recomputePart(document, bridge, options),
): () => void {
  let detached = false;
  let running = false;
  let queued: Request | null = null;
  let latest: Request | null = null;
  let current: Request | null = null;
  let prepared: Prepared | null = null;
  let preparedAssembly: { readonly entry: EmbeddedDrawingSource; readonly documentId: string; readonly output: PreparedAssemblyDrawing } | null = null;
  const retained = new Set<string>();

  const obsolete = (request: Request): boolean => detached || latest !== request;
  const release = async (): Promise<void> => {
    prepared = null;
    preparedAssembly = null;
    for (const id of retained) { await bridge.releasePart(id); retained.delete(id); }
  };

  const prepareDrawingSource = async (source: DrawingSource): Promise<DrawingSourceResolution> => {
    const request = current;
    if (request === null || obsolete(request)) throw new Error(t('drawing.error.viewFailed'));
    const entry = request.sources.sources.find((item) => item.metadata.sourceRef === source.sourceRef
      && item.metadata.contentHash === source.contentHash && item.metadata.sourceKind === source.sourceKind);
    if (entry === undefined) throw new Error(t('drawing.error.selectSource'));
    const input = drawingSourceInputOf(entry);
    if (input?.sourceKind === 'assembly') {
      if (preparedAssembly?.entry === entry && preparedAssembly.documentId === request.documentId) {
        let available = true;
        for (const [id, keys] of preparedAssembly.output.owners) {
          if ((await bridge.checkShapeAvailability(id, keys)).missingKeys.length > 0) available = false;
        }
        if (available && !obsolete(request)) return preparedAssembly.output.result;
      }
      await release();
      if (obsolete(request)) throw new Error(t('drawing.error.viewFailed'));
      const output = await prepareAssemblyDrawingSource(input, source.sourceRef, request.documentId,
        bridge, recompute, () => obsolete(request), (id) => { retained.add(id); });
      if (obsolete(request)) throw new Error(t('drawing.error.viewFailed'));
      preparedAssembly = { entry, documentId: request.documentId, output };
      return output.result;
    }
    if (input?.sourceKind !== 'part' || !('sketches' in entry.document)) {
      throw new Error(t('drawing.error.selectSource'));
    }
    const partId = `drawing:${request.documentId}:${source.sourceRef}`;
    if ([...retained].some((id) => id !== partId)) await release();
    if (prepared !== null && prepared.partId === partId && prepared.document === entry.document
      && prepared.importedShapes === request.importedShapes) {
      const available = await bridge.checkShapeAvailability(partId, prepared.result.bodyIds);
      if (available.missingKeys.length === 0) return prepared.result;
      prepared = null;
    }
    if (obsolete(request)) throw new Error(t('drawing.error.viewFailed'));
    retained.add(partId);
    const resolved = new Map<string, ResolvedPart>();
    const result = await recompute(entry.document, { partId, importedShapes: request.importedShapes,
      shouldCancel: () => obsolete(request), onResolved: (part) => { resolved.set(partId, part); } });
    if (result.cancelled || obsolete(request)) throw new Error(t('drawing.error.viewFailed'));
    if (result.errors.length > 0) throw new Error(result.errors.map((error) => error.message).join('\n'));
    const part = resolved.get(partId);
    if (part === undefined || result.bodies.length === 0) throw new Error(t('drawing.error.noSolid'));
    const dimensionInstances = result.bodies.map((body) => {
      // featureIdは文書の名前であり、Workerのshape cache keyではない。
      const step = part.steps.find((item) => item.visible && item.featureId === body.featureId);
      if (step === undefined) throw new Error(t('drawing.error.viewFailed'));
      return { sourceRef: source.sourceRef, bodyId: step.key, body, placement: IDENTITY_PLACEMENT };
    });
    const output = { bodyIds: dimensionInstances.map((instance) => instance.bodyId), dimensionInstances, center: sourceCenter(result) };
    const available = await bridge.checkShapeAvailability(partId, output.bodyIds);
    if (available.missingKeys.length > 0) throw new Error(t('drawing.error.viewFailed'));
    prepared = { partId, document: entry.document, importedShapes: request.importedShapes, result: output, resolved: part, holes: new Map() };
    return output;
  };
  const kernel = createDrawingResolveKernel(bridge, prepareDrawingSource);

  async function withHoleTables(request: Request, source: DrawingSourceResolution): Promise<DrawingSourceResolution> {
    const part = prepared;
    const tables = request.document.tables.filter((table) => table.kind === 'hole');
    if (tables.length === 0) return source;
    const holeTables = new Map<string, HoleScheduleResult>();
    for (const table of tables) {
      const view = request.document.views.find((item) => item.id === table.options.viewId);
      const basis = view === undefined ? null : drawingViewBasis({ normal: view.direction, xDir: view.xDir });
      const x = table.options.datumX ?? 0, y = table.options.datumY ?? 0, z = table.options.datumZ ?? 0;
      if (part === null || basis === null || typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
        holeTables.set(table.id, { ok: false, reason: 'invalidFrame' }); continue;
      }
      const frame = { datum: [x, y, z] as const, x: basis.x, y: basis.y };
      const cacheKey = JSON.stringify(frame);
      const cached = part.holes.get(cacheKey);
      if (cached !== undefined) { holeTables.set(table.id, cached); continue; }
      const result = await resolveHoleSchedule(part.document, part.resolved, bridge, frame,
        { partId: part.partId, shouldCancel: () => obsolete(request) });
      if (obsolete(request)) throw new Error(t('drawing.error.viewFailed'));
      if (!result.ok && (result.reason === 'cancelled' || result.reason === 'kernelFailed')) throw new Error(t('drawing.error.viewFailed'));
      // cancelled/kernelFailedは上で断り、修正可能な穴の指定不備だけを表示へ渡す。
      const rows: HoleScheduleResult = result;
      part.holes.set(cacheKey, rows); holeTables.set(table.id, rows);
    }
    return { ...source, holeTables };
  }

  async function drain(): Promise<void> {
    running = true;
    try {
      while (queued !== null && !detached) {
        const request = queued;
        queued = null;
        current = request;
        const result = await refreshDrawing(request.document, kernel);
        const source = prepared?.result ?? preparedAssembly?.output.result ?? null;
        const output = !obsolete(request) && result.ok && source !== null ? await withHoleTables(request, source) : null;
        if (!obsolete(request)) useAppStore.getState().setDrawingResolution(request.document, result, output);
      }
    } finally {
      running = false;
      current = null;
      if (detached || latest === null) await release();
    }
  }

  function enqueue(): void {
    const state = useAppStore.getState();
    if (state.drawing === null) {
      latest = null; queued = null;
      if (!running) void release().catch(() => { /* Worker終了時は所有先も破棄される。 */ });
      return;
    }
    const request = { document: state.drawing, sources: state.drawingSources,
      importedShapes: state.drawingImportedShapes, documentId: state.activeDocumentId };
    latest = request;
    queued = request;
    useAppStore.setState({ drawingBusy: true, drawingMessage: null, drawingTargets: [] });
    if (!running) void drain().catch((error: unknown) => {
      if (!detached && latest !== null) useAppStore.getState().setDrawingResolution(latest.document,
        { ok: false, message: error instanceof Error ? error.message : t('drawing.error.viewFailed') }, null);
    });
  }
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.drawing !== previous.drawing || next.drawingSources !== previous.drawingSources
      || next.drawingImportedShapes !== previous.drawingImportedShapes || next.activeDocumentId !== previous.activeDocumentId) enqueue();
  });
  enqueue();
  return () => {
    detached = true; latest = null; queued = null; unsubscribe();
    if (!running) void release().catch(() => { /* Worker終了時は所有先も破棄される。 */ });
  };
}
