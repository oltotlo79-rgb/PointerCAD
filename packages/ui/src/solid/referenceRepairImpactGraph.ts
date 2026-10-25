import { analyzeMathGeometryDependencies, historyDependencies, referencedSketchIds } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { activeDocument } from '../store/documentKind.js';
import type { CurrentRepairSlot } from './referenceRepairContext.js';

/** Dependencies also include consumers without their own SubShapeRef (measurements, dependent operations and datum frames). */
export function repairImpactGraph(state: AppState, slots: readonly CurrentRepairSlot[]): ReadonlyMap<string, readonly string[]> {
  const active = activeDocument(state), graph = new Map<string, readonly string[]>();
  const add = (id: string, dependencies: readonly string[]): void => { graph.set(id, [...(graph.get(id) ?? []), ...dependencies]); };
  for (const slot of slots) add(slot.ownerId, [slot.reference.bodyFeatureId]);
  if (active.kind === 'part') {
    const document = active.document;
    for (const [id, dependencies] of historyDependencies(document)) add(id, dependencies);
    for (const sketch of document.sketches) add(sketch.id, sketch.features.map(feature => `${sketch.id}/${feature.id}`));
    for (const solid of document.solids) add(solid.id, referencedSketchIds(solid, document.sketches));
    if ((document.mathGeometry?.length ?? 0) > 0) {
      const analysis = analyzeMathGeometryDependencies(document);
      for (const [id, targets] of analysis.targets) add(id, [...targets]);
      for (const [id, definitions] of analysis.ownerGeometry) add(id, [...definitions]);
    }
  } else if (active.kind === 'drawing') {
    for (const datum of active.document.datums) add(datum.id, datum.sizeDimensionId === undefined ? [] : [datum.sizeDimensionId]);
    for (const frame of active.document.gdtFrames) add(frame.id, [
      ...(frame.sizeDimensionId === undefined ? [] : [frame.sizeDimensionId]),
      ...frame.segments.flatMap(segment => [...segment.basicDimensionIds,
        ...segment.datums.flatMap(datum => datum.kind === 'single' ? [datum.member.datumId] : datum.members.map(member => member.datumId))]),
    ]);
  }
  return graph;
}
