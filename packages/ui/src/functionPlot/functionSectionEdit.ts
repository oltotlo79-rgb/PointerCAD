import { expressionValueFromNumber as number, multiplyExpression } from '@pointercad/expression';
import type { FunctionPlotAxis, PartDocument } from '@pointercad/model';

export interface FunctionSectionAddress { readonly sketchId: string; readonly featureId: string }

/** Infer editable coordinate sections from existing persisted references; no duplicate metadata. */
export function readFunctionSection(document: PartDocument, address: FunctionSectionAddress) {
  const section = document.sketches.find(sketch => sketch.id === address.sketchId)?.features.find(feature => feature.id === address.featureId);
  if (section?.kind !== 'planeSection') return null;
  const parent = document.solids.find(feature => feature.id === section.targetFeatureId);
  const reference = document.references.find(feature => feature.id === section.planeId);
  if (parent?.kind !== 'functionSurface' || reference?.kind !== 'referencePlane' || reference.plane.kind !== 'workPlane') return null;
  const plane = reference.plane;
  if (plane.planeId !== 'xy' && plane.planeId !== 'xz' && plane.planeId !== 'yz') return null;
  const axis: FunctionPlotAxis = plane.planeId === 'xy' ? 'Z' : plane.planeId === 'xz' ? 'Y' : 'X';
  return { parent, planeId: reference.id, axis, coordinate: axis === 'Y' ? multiplyExpression(plane.offset, number(-1)) : plane.offset };
}
