/** Test-only EX-18 context-route inputs. Never read oracle expectations to construct geometry. */
import { expressionValueFromNumber as value } from '@pointercad/expression';

import type { KernelBridge, SolidBody } from '../kernelBridge.js';
import { createSubShapeReference } from '../kernelBridge/createSubShapeReference.js';
import { appendReference, appendSolid, createEmptyPartDocument, replaceSketch } from '../part/createPartDocument.js';
import { buildEx18ExpressionFlange, buildEx18SketchBracket, buildEx18SewnOblique } from '../part/ex18RouteBuilders.js';
import type { PartDocument, PrimitiveFeature, ReferencePointFeature, SubShapeRef } from '../part/types.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import type { CoordinateInput } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { addComponent, createComponentFor } from './assemblyEdit.js';
import type { ContextReferenceLink } from './contextReference.js';
import { createAssemblyDocument } from './createAssemblyDocument.js';
import { embedPart, type PartLibrary } from './partLibrary.js';
import type { Placement } from './types.js';

export type Ex18ContextShape = 'A' | 'B' | 'C';
export const EX18_CONTEXT_POINT_ID = 'context-point-P';

export function contextPlacement(position: Vec3, rotation: Placement['rotation'] = [0, 0, 0, 1]): Placement {
  return { position: [value(position[0]), value(position[1]), value(position[2])], rotation };
}

function relative(pointId: string, offset: Vec3 = [0, 0, 0]): CoordinateInput {
  return { mode: 'relative', base: { kind: 'point', pointId },
    dx: value(offset[0]), dy: value(offset[1]), dz: value(offset[2]) };
}

/** A/B drive the machining centre; C drives one vertex and all other vertices relative to it. */
export async function buildEx18ContextPart(shape: Ex18ContextShape, bridge: KernelBridge) {
  const built = shape === 'A' ? await buildEx18SketchBracket(bridge)
    : shape === 'B' ? await buildEx18ExpressionFlange(bridge) : buildEx18SewnOblique();
  const initial: Vec3 = shape === 'A' ? [8, 15, 10] : shape === 'B' ? [-2, 0, 25] : [-2, 0, 0];
  const reference: ReferencePointFeature = { id: EX18_CONTEXT_POINT_ID, name: 'P', visible: true, kind: 'referencePoint',
    definition: { kind: 'coordinate', at: absoluteCoordinate(...initial) } };
  const sketch = built.part.sketches[0];
  const final = built.part.solids.find(feature => feature.id === built.finalId);
  const drivenId = shape === 'C' ? sketch.features.find(feature => feature.kind === 'point')?.id
    : final?.kind === 'hole' ? final.centers[0]?.pointFeatureId : undefined;
  if (drivenId === undefined) throw new Error('EX18 context route has no driven sketch point');
  const linked = replaceSketch(built.part, { ...sketch, features: sketch.features.map(feature => {
    if (feature.id === drivenId && feature.kind === 'point') return { ...feature, at: relative(reference.id) };
    if (shape !== 'C' || feature.kind !== 'point') return feature;
    if (feature.at.mode !== 'absolute') throw new Error('EX18 C input vertex must be absolute');
    return { ...feature, at: relative(drivenId, [feature.at.x.value, feature.at.y.value, feature.at.z.value]) };
  }) });
  return { part: appendReference(linked, reference), finalId: built.finalId, drivenId };
}

/** A real source face at local (12,-8,4), deliberately away from the part origin. */
export function buildEx18ContextSource(kind: 'box' | 'cylinder' = 'box'): PartDocument {
  const id = `source-${kind}`;
  const primitive: PrimitiveFeature = { id, name: id, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: kind === 'box' ? absoluteCoordinate(12, -8, 2) : absoluteCoordinate(12, -8, 0) },
    axis: { kind: 'world', axis: 'z' },
    shape: kind === 'box' ? { kind: 'box', sizeX: value(6), sizeY: value(8), sizeZ: value(4) }
      : { kind: 'cylinder', radius: value(5), height: value(4) } };
  return appendSolid(createEmptyPartDocument(), primitive);
}

/** Capture through the product's current-face selection API, with no guessed index or stale fingerprint. */
export function ex18ContextSourceFace(body: SolidBody): SubShapeRef {
  const tops = body.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 && Math.abs(face.centroid[2] - 4) < 1e-9);
  const [top] = tops;
  if (!body.isValid || tops.length !== 1 || top === undefined) throw new Error('EX18 source top face is not unique');
  const reference = createSubShapeReference(body, 'face', top.index);
  if (reference === null) throw new Error('EX18 source face capture refused');
  return reference;
}

export async function buildEx18ContextAssembly(part: PartDocument, sourcePart: PartDocument, source: SubShapeRef,
  sourcePlacement: Placement, targetPlacement = contextPlacement([0, 0, 0])) {
  const empty: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
  const target = await embedPart(empty, part, 'context-target.pcad', 'context-target.pcad');
  const origin = await embedPart(target.library, sourcePart, 'context-source.pcad', 'context-source.pcad');
  let document = createAssemblyDocument('EX18 context route');
  const a = { ...createComponentFor(document, { kind: 'part', partRef: target.partRef }), placement: targetPlacement };
  document = addComponent(document, a);
  const b = { ...createComponentFor(document, { kind: 'part', partRef: origin.partRef }), placement: sourcePlacement };
  document = addComponent(document, b);
  const link: ContextReferenceLink = { id: 'context-1', targetComponentId: a.id, targetReferenceId: EX18_CONTEXT_POINT_ID,
    sourceComponentId: b.id, source };
  return { document, library: origin.library, a, b, link, targetRef: target.partRef, sourceRef: origin.partRef };
}
