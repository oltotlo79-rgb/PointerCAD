import type { AssemblyDocument, RigidPlacement } from '@pointercad/model';
import {
  crossLevelDragRefusal, crossLevelMotionFollow, type AssemblyCrossLevelGearNotice, type AssemblyOccurrenceDrive,
} from '../store/assemblyOccurrenceDriveSlice.js';
import type { AssemblyView } from '../store/assemblySlice.js';

/**
 * A component drag that turns the parent joint of a saved cross-level gear or the joint of a saved cross-level cam
 * (EX12). The drag's own solve (solveMateDrag) gives the parent placements; the coupled child placements are solved by
 * the same follow as every other parent-level motion (crossLevelMotionFollow), so there is no second solver. Such a
 * drag is joint motion: its frames and its release publish the parent and every coupled child together, never a
 * document edit. It is refused whole when a coupled child cannot follow, when the relations cannot be evaluated, or
 * when the drag also moves a component that no joint connects (that part is a placement edit and a coupled release
 * could not save it: an ambiguous mixed edit). A drag that turns no coupled joint is ordinary (a document edit).
 */
export type CoupledDragOutcome =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'coupled'; readonly drives: ReadonlyMap<string, AssemblyOccurrenceDrive>; readonly values: ReadonlyMap<string, number> }
  | { readonly kind: 'refused'; readonly notice: AssemblyCrossLevelGearNotice };

function samePlacement(a: RigidPlacement, b: RigidPlacement): boolean {
  return a.position.every((value, axis) => value === b.position[axis]) && a.rotation.every((value, axis) => value === b.rotation[axis]);
}

/** Ids of the components the drag moved (exact comparison with the drag start, like componentDragDocument). */
export function movedDragComponents(initial: ReadonlyMap<string, RigidPlacement>, placements: ReadonlyMap<string, RigidPlacement>): readonly string[] {
  return [...initial].filter(([id, before]) => {
    const after = placements.get(id);
    return after !== undefined && !samePlacement(before, after);
  }).map(([id]) => id);
}

/** A component that at least one active joint of the document connects. */
function jointed(document: AssemblyDocument, componentId: string): boolean {
  return document.joints.some(joint => !joint.suppressed && (joint.a.componentId === componentId || joint.b.componentId === componentId));
}

/**
 * The coupled part of one drag result. The motion starts from the drag start (`initial`, the resolved placements the drag
 * was prepared on) with no earlier child drive, so a coupled frame or release never mixes an older motion into it.
 */
export function coupledDragFollow(drag: { readonly document: AssemblyDocument; readonly view: AssemblyView;
  readonly initial: ReadonlyMap<string, RigidPlacement> }, placements: ReadonlyMap<string, RigidPlacement>): CoupledDragOutcome {
  // The same detection as before (it reads which coupled joints moved); null = this drag turns no coupled joint.
  const detected = crossLevelDragRefusal({ assembly: drag.document }, drag.initial, placements);
  if (detected === null) return { kind: 'ordinary' };
  if (detected.code !== 'coupled-motion') return { kind: 'refused', notice: detected };
  const loose = movedDragComponents(drag.initial, placements).find(id => !jointed(drag.document, id));
  if (loose !== undefined) return { kind: 'refused', notice: { couplingId: detected.couplingId, code: 'coupled-drag-mixed' } };
  const follow = crossLevelMotionFollow({ assembly: drag.document, assemblyView: drag.view, assemblyOccurrenceDrives: new Map(),
    assemblyMotionPlacements: drag.initial, assemblyMotionSourceDocument: drag.document }, placements, new Map());
  if (!follow.ok) return { kind: 'refused', notice: follow.notice };
  return { kind: 'coupled', drives: follow.drives, values: follow.values };
}
