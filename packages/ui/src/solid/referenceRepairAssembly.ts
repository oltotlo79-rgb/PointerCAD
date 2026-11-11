import type { AssemblyDocument } from '@pointercad/model';
import { collectRepairSlots, type RepairSlot } from './referenceRepairSlots.js';

export function assemblyRepairSlots(document: AssemblyDocument): readonly RepairSlot<AssemblyDocument>[] {
  const slots: RepairSlot<AssemblyDocument>[] = [];
  for (const mate of document.mates) for (const side of ['a', 'b'] as const) {
    const target = mate[side];
    if (target.kind !== 'subShape') continue;
    collectRepairSlots(slots, 'mate', mate.id, mate.name, target,
      (value, map) => ({ ...value, ref: map(value.ref, side) }),
      next => ({ ...document, mates: document.mates.map(item => item === mate ? { ...mate, [side]: next } : item) }),
      { componentId: target.componentId });
  }
  for (const joint of document.joints) for (const side of ['a', 'b'] as const) {
    const target = joint[side];
    if (target.kind !== 'subShape') continue;
    collectRepairSlots(slots, 'mate', joint.id, joint.name, target,
      (value, map) => ({ ...value, ref: map(value.ref, side) }),
      next => ({ ...document, joints: document.joints.map(item => item === joint ? { ...joint, [side]: next } : item) }),
      { componentId: target.componentId });
  }
  return slots;
}
