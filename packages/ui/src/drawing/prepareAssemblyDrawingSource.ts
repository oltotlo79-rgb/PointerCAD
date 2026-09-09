import { buildBom, buildStandardPartFromSource, drawingSourceCenter, EMPTY_PART_LIBRARY, resolveConstrainedAssembly,
  type AssemblyDocument, type AssemblyKernelBridge, type BomResolvedData, type DrawingDimensionInstance,
  type DrawingSourceInput, type DrawingSourceResolution, type ResolvedAssembly, type ResolvedPart,
  type PartDocument, type SolidBody } from '@pointercad/model';
import { collectAssemblyPartSources } from '../assembly/attachAssembly.js';
import { flattenAssemblyGeometry } from '../viewport/createAssemblyLayer.js';
import { t } from '../i18n/t.js';
import type { DrawingPartRecomputer } from './attachDrawing.js';

export interface PreparedAssemblyDrawing {
  readonly result: DrawingSourceResolution;
  readonly owners: ReadonlyMap<string, readonly string[]>;
}

function bomData(resolved: ResolvedAssembly,
  bodies: ReadonlyMap<string, readonly SolidBody[]>, documents: ReadonlyMap<string, PartDocument>): BomResolvedData {
  const subAssemblies = new Map<string, { assembly: AssemblyDocument; resolved: BomResolvedData }>();
  for (const nested of resolved.subAssemblies?.values() ?? []) {
    subAssemblies.set(nested.assemblyRef, { assembly: nested.assembly,
      resolved: bomData(nested.resolved, bodies, documents) });
  }
  return { partKeys: resolved.partKeys, bodies, documents, subAssemblies };
}

/** 組図自身の名前空間で各部品を一度だけ計算し、解決した合致と原本から表を導く。 */
export async function prepareAssemblyDrawingSource(source: Extract<DrawingSourceInput, { sourceKind: 'assembly' }>,
  sourceRef: string, documentId: string, bridge: AssemblyKernelBridge, recompute: DrawingPartRecomputer,
  shouldCancel: () => boolean, retain: (id: string) => void): Promise<PreparedAssemblyDrawing> {
  const library = source.library ?? EMPTY_PART_LIBRARY;
  const { references, standardSources } = collectAssemblyPartSources(source.document, library);
  const resolvedParts = new Map<string, ResolvedPart>();
  const bodies = new Map<string, readonly SolidBody[]>();
  const documents = new Map<string, PartDocument>();
  const owners = new Map<string, readonly string[]>();
  for (const ref of references) {
    if (shouldCancel()) throw new Error(t('drawing.error.viewFailed'));
    const standard = standardSources.get(ref);
    const document = standard === undefined ? library.parts.get(ref) : buildStandardPartFromSource(standard);
    if (document === undefined || document === null) throw new Error(t('drawing.error.selectSource'));
    const partId = `drawing:${documentId}:${sourceRef}:${ref}`;
    retain(partId);
    const result = await recompute(document, { partId, importedShapes: library.attachments.get(ref)?.shapes, shouldCancel,
      onResolved: (resolved) => { resolvedParts.set(ref, resolved); } });
    if (shouldCancel() || result.cancelled) throw new Error(t('drawing.error.viewFailed'));
    if (result.errors.length > 0) throw new Error(result.errors.map((error) => error.message).join('\n'));
    const resolved = resolvedParts.get(ref);
    if (resolved === undefined) throw new Error(t('drawing.error.viewFailed'));
    const keys = resolved.steps.filter((step) => step.visible && result.bodies.some((body) => body.featureId === step.featureId)).map((step) => step.key);
    if ((await bridge.checkShapeAvailability(partId, keys)).missingKeys.length > 0) throw new Error(t('drawing.error.viewFailed'));
    owners.set(partId, keys); bodies.set(ref, result.bodies); documents.set(ref, document);
  }
  const resolved = resolveConstrainedAssembly(source.document, bodies, { library, resolvedParts,
    standardPart: buildStandardPartFromSource, subAssemblies: library.assemblies });
  if (!resolved.ok) throw new Error(resolved.messages.length > 0 ? resolved.messages.join('\n') : t('drawing.error.assemblyConstraints'));
  const flat = flattenAssemblyGeometry(source.document, resolved.resolved);
  const dimensionInstances: DrawingDimensionInstance[] = [];
  for (const component of flat.components) {
    if (!component.visible) continue;
    const ref = flat.partKeys.get(component.id), placement = flat.placements.get(component.id);
    if (ref === undefined || placement === undefined) throw new Error(t('drawing.error.viewFailed'));
    for (const body of bodies.get(ref) ?? []) {
      const step = resolvedParts.get(ref)?.steps.find((entry) => entry.visible && entry.featureId === body.featureId);
      if (step === undefined) throw new Error(t('drawing.error.viewFailed'));
      dimensionInstances.push({ sourceRef, componentId: component.id, bodyId: step.key, body, placement });
    }
  }
  const center = drawingSourceCenter(dimensionInstances);
  if (center === null) throw new Error(t('drawing.error.noSolid'));
  return { owners, result: { dimensionInstances, center,
    bodyIds: [...new Set(dimensionInstances.map((instance) => instance.bodyId))],
    instances: dimensionInstances.map((instance) => ({ bodyId: instance.bodyId, occurrenceId: instance.componentId ?? '', placement: instance.placement })),
    bomRows: buildBom(source.document, bomData(resolved.resolved, bodies, documents), source.document.bom) } };
}
