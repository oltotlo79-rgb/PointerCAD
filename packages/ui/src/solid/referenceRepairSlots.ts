import type { PartDocument, SubShapeRef } from '@pointercad/model';
import { repairCoordinate, repairReference, type RepairMapper, type RepairRequirement } from './referenceRepairGeometry.js';
import { repairSketch, repairSolid } from './referenceRepairFeatures.js';
import { repairMath } from './referenceRepairMath.js';

export type RepairConsumer = 'machining' | 'appearance' | 'reference' | 'sketch' | 'selection' | 'dimension' | 'mate' | 'annotation';
export interface RepairSlot<Document> {
  readonly key: string;
  readonly consumer: RepairConsumer;
  readonly ownerId: string;
  readonly name: string;
  readonly field: string;
  readonly reference: SubShapeRef;
  readonly requirement: RepairRequirement;
  readonly componentId?: string;
  readonly sourceRef?: string;
  readonly replace: (reference: SubShapeRef) => Document;
}

export function collectRepairSlots<Document, Value>(
  slots: RepairSlot<Document>[], consumer: RepairConsumer, ownerId: string, name: string,
  value: Value, adapter: (value: Value, map: RepairMapper) => Value, replace: (value: Value) => Document,
  context: { readonly componentId?: string; readonly sourceRef?: string } = {},
): void {
  adapter(value, (reference, field, requirement = 'same-kind') => {
    slots.push({ key: JSON.stringify([consumer, ownerId, field, context.componentId, context.sourceRef]),
      consumer, ownerId, name, field, reference, requirement, ...context,
      replace: next => replace(adapter(value, (original, slot) => slot === field && original === reference ? next : original)) });
    return reference;
  });
}

export function partRepairSlots(document: PartDocument): readonly RepairSlot<PartDocument>[] {
  const slots: RepairSlot<PartDocument>[] = [];
  for (const feature of document.solids) collectRepairSlots(slots, 'machining', feature.id, feature.name,
    feature, repairSolid, next => ({ ...document, solids: document.solids.map(item => item === feature ? next : item) }));
  for (const feature of document.references) collectRepairSlots(slots, 'reference', feature.id, feature.name,
    feature, repairReference, next => ({ ...document, references: document.references.map(item => item === feature ? next : item) }));
  for (const sketch of document.sketches) for (const feature of sketch.features) {
    collectRepairSlots(slots, 'sketch', `${sketch.id}/${feature.id}`, feature.name, feature, repairSketch,
      next => ({ ...document, sketches: document.sketches.map(item => item === sketch
        ? { ...sketch, features: sketch.features.map(item => item === feature ? next : item) } : item) }));
  }
  for (const entry of document.appearance.entries) {
    if (entry.target.kind !== 'face') continue;
    collectRepairSlots(slots, 'appearance', entry.id, entry.id, entry.target,
      (target, map) => ({ ...target, ref: map(target.ref, 'face') }),
      target => ({ ...document, appearance: { ...document.appearance,
        entries: document.appearance.entries.map(item => item === entry ? { ...entry, target } : item) } }));
  }
  for (const set of document.selectionSets) collectRepairSlots(slots, 'selection', set.id, set.name, set,
    (value, map) => ({ ...value, members: value.members.map((member, index) => member.kind === 'body' ? member
      : { ...member, ref: map(member.ref, `members:${index}`) }) }),
    next => ({ ...document, selectionSets: document.selectionSets.map(item => item === set ? next : item) }));
  for (const definition of document.mathGeometry ?? []) collectRepairSlots(slots, 'dimension', definition.id, definition.name,
    definition.quantity, repairMath, quantity => ({ ...document,
      mathGeometry: document.mathGeometry?.map(item => item === definition ? { ...definition, quantity } : item) }));
  for (const canvas of document.canvases) collectRepairSlots(slots, 'reference', canvas.id, canvas.name,
    canvas.origin, (value, map) => repairCoordinate(value, map, 'origin'),
    origin => ({ ...document, canvases: document.canvases.map(item => item === canvas ? { ...canvas, origin } : item) }));
  return slots;
}
