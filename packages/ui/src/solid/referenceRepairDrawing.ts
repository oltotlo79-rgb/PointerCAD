import type { DimensionTarget, DrawingDocument, GdtFeature } from '@pointercad/drawing';
import { collectRepairSlots, type RepairConsumer, type RepairSlot } from './referenceRepairSlots.js';
import type { RepairRequirement } from './referenceRepairGeometry.js';

export function drawingRepairSlots(document: DrawingDocument): readonly RepairSlot<DrawingDocument>[] {
  const slots: RepairSlot<DrawingDocument>[] = [];
  function target(consumer: RepairConsumer, id: string, field: string, value: DimensionTarget,
    replace: (next: Extract<DimensionTarget, { kind: 'subShape' }>) => DrawingDocument, requirement: RepairRequirement = 'same-kind'): void {
    if (value.kind !== 'subShape') return;
    collectRepairSlots(slots, consumer, id, id, value, (value, map) => ({ ...value, ref: map(value.ref, field, requirement) }), replace,
      { sourceRef: value.sourceRef, ...(value.componentId === undefined ? {} : { componentId: value.componentId }) });
  }
  for (const dimension of document.dimensions) dimension.targets.forEach((value, index) => {
    target('dimension', dimension.id, `targets:${index}`, value, next => ({ ...document,
      dimensions: document.dimensions.map(item => item === dimension
        ? { ...dimension, targets: dimension.targets.map((item, at) => at === index ? next : item) } : item) }),
    dimension.kind === 'radius' || dimension.kind === 'diameter' || dimension.kind === 'arcLength' ? 'circle'
      : dimension.kind === 'sphereRadius' || dimension.kind === 'sphereDiameter' ? 'sphere' : 'same-kind');
  });
  for (const annotation of document.annotations) {
    if (annotation.sourceTarget !== undefined) target('annotation', annotation.id, 'sourceTarget', annotation.sourceTarget,
      next => ({ ...document, annotations: document.annotations.map(item => item === annotation ? { ...annotation, sourceTarget: next } : item) }));
  }
  for (const balloon of document.balloons) {
    if (balloon.sourceTarget !== undefined) target('annotation', balloon.id, 'sourceTarget', balloon.sourceTarget,
      next => ({ ...document, balloons: document.balloons.map(item => item === balloon ? { ...balloon, sourceTarget: next } : item) }));
  }
  for (const weld of document.weldSymbols) target('annotation', weld.id, 'target', weld.target,
    next => ({ ...document, weldSymbols: document.weldSymbols.map(item => item === weld ? { ...weld, target: next } : item) }));
  function gdt(id: string, feature: GdtFeature, replace: (feature: GdtFeature) => DrawingDocument): void {
    if (feature.kind !== 'medianPlane') {
      target('annotation', id, 'target', feature.target, next => replace({ ...feature, target: next }));
      return;
    }
    target('annotation', id, 'first', feature.targets[0], next => replace({ ...feature, targets: [next, feature.targets[1]] }));
    target('annotation', id, 'second', feature.targets[1], next => replace({ ...feature, targets: [feature.targets[0], next] }));
  }
  for (const datum of document.datums) gdt(datum.id, datum.feature,
    feature => ({ ...document, datums: document.datums.map(item => item === datum ? { ...datum, feature } : item) }));
  for (const frame of document.gdtFrames) gdt(frame.id, frame.feature,
    feature => ({ ...document, gdtFrames: document.gdtFrames.map(item => item === frame ? { ...frame, feature } : item) }));
  return slots;
}
