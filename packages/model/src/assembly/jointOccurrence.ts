import type { ResolvedPart } from '../part/resolvePart.js';
import { componentSourceKey, PLACEMENT_QUATERNION_TOLERANCE, validPlacement } from './fastening/frames.js';
import type { PartLibrary } from './partLibrary.js';
import type { RigidPlacement } from './placementMath.js';
import { MAX_SUB_ASSEMBLY_DEPTH, partKeyOf, type ResolvedAssembly } from './resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument } from './types.js';

/** IDs are separate array elements, never a slash-delimited viewport label. */
export type JointOccurrencePath = readonly [string, ...string[]];

export interface JointOccurrenceInputs {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
  readonly subAssemblies: ReadonlyMap<string, AssemblyDocument>;
}

/** Capture these inputs with the completed solve, not when a later pick occurs.
 * ResolvedAssembly itself has no source stamp. The producer must retain this pair
 * atomically and follow the existing immutable document/library contract.
 */
export interface JointOccurrenceView {
  readonly source: JointOccurrenceInputs;
  readonly resolved: ResolvedAssembly;
}

export type JointOccurrenceFailureCode =
  | 'invalid-path' | 'stale-view' | 'missing-component' | 'ambiguous-component'
  | 'suppressed-component' | 'invalid-placement' | 'not-subassembly'
  | 'missing-subassembly' | 'cyclic-path' | 'depth-exceeded' | 'inconsistent-tree'
  | 'unresolved-view' | 'unsupported-leaf' | 'missing-source' | 'ambiguous-source'
  | 'unsupported-geometry';

export interface ResolvedJointOccurrence {
  readonly path: JointOccurrencePath;
  /** Collision-free occurrence key; geometry may be shared by several paths. */
  readonly occurrenceKey: string;
  readonly motionOwnerId: string;
  readonly leafDocument: AssemblyDocument;
  readonly leafComponent: AssemblyComponent;
  readonly partKey: string;
  readonly sourceKey: string;
  readonly resolvedPart: ResolvedPart;
  /** Already composed world placement, including solved ancestor constraints. */
  readonly worldPlacement: RigidPlacement;
}

export type JointOccurrenceResult =
  | { readonly ok: true; readonly occurrence: ResolvedJointOccurrence }
  | { readonly ok: false; readonly code: JointOccurrenceFailureCode; readonly index: number };

/** Copies the array; no trimming, splitting or rewriting otherwise valid IDs. */
export function jointOccurrencePath(ids: readonly string[]): JointOccurrencePath | null {
  const first = ids[0];
  if (typeof first !== 'string' || first.length === 0) return null;
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return null;
  }
  return [first, ...ids.slice(1)];
}

function failure(code: JointOccurrenceFailureCode, index: number): JointOccurrenceResult {
  return { ok: false, code, index };
}

function validWorldPlacement(placement: RigidPlacement): boolean {
  return placement.position.every(Number.isFinite) && placement.rotation.every(Number.isFinite)
    && Math.abs(Math.hypot(...placement.rotation) - 1) <= PLACEMENT_QUATERNION_TOLERANCE;
}

function samePlacement(a: RigidPlacement, b: RigidPlacement): boolean {
  return a.position.every((value, index) => value === b.position[index])
    && a.rotation.every((value, index) => value === b.rotation[index]);
}

/** Resolve identity and geometry only. This does not grant movement, select a
 * face, validate a physical connection, or mutate a shared child document.
 */
export function resolveJointOccurrence(
  inputs: JointOccurrenceInputs,
  ids: readonly string[],
  view: JointOccurrenceView,
): JointOccurrenceResult {
  const path = jointOccurrencePath(ids);
  if (path === null) return failure('invalid-path', 0);
  if (inputs.document !== view.source.document || inputs.library !== view.source.library
      || inputs.subAssemblies !== view.source.subAssemblies) return failure('stale-view', 0);
  if (path.length - 1 > MAX_SUB_ASSEMBLY_DEPTH) return failure('depth-exceeded', MAX_SUB_ASSEMBLY_DEPTH);
  let document = inputs.document;
  let resolved = view.resolved;
  const ancestors = new Set<string>();
  for (const [index, id] of path.entries()) {
    const matches = document.components.filter(component => component.id === id);
    const component = matches[0];
    if (component === undefined) return failure('missing-component', index);
    if (matches.length !== 1) return failure('ambiguous-component', index);
    if (component.suppressed) return failure('suppressed-component', index);
    if (!validPlacement(component.placement)) return failure('invalid-placement', index);
    const placement = resolved.placements.get(id);
    if (placement === undefined) return failure('inconsistent-tree', index);
    if (!validWorldPlacement(placement)) return failure('invalid-placement', index);
    if (index < path.length - 1) {
      if (component.source.kind !== 'subAssembly') return failure('not-subassembly', index);
      const ref = component.source.assemblyRef;
      if (ancestors.has(ref)) return failure('cyclic-path', index);
      const child = inputs.subAssemblies.get(ref);
      if (child === undefined) return failure('missing-subassembly', index);
      // Where the library also carries assemblies, conflicting documents are unsafe.
      const libraryChild = inputs.library.assemblies?.get(ref);
      if (libraryChild !== undefined && libraryChild !== child) return failure('inconsistent-tree', index);
      const nested = resolved.subAssemblies?.get(id);
      if (nested === undefined || nested.componentId !== id || nested.assemblyRef !== ref
          || nested.assembly !== child || !samePlacement(nested.placement, placement)
          || resolved.partKeys.get(id) !== partKeyOf(component.source)) {
        return failure('inconsistent-tree', index);
      }
      if (resolved.errors.length > 0) return failure('unresolved-view', index);
      ancestors.add(ref);
      document = child;
      resolved = nested.resolved;
      continue;
    }
    if (component.source.kind === 'subAssembly') return failure('unsupported-leaf', index);
    const source = component.source;
    const revisions = new Map<string, string>();
    if (source.kind === 'part') {
      if (!inputs.library.parts.has(source.partRef)) return failure('missing-source', index);
      const files = inputs.library.partFiles.filter(file => file.ref === source.partRef);
      if (files.length > 1) return failure('ambiguous-source', index);
      const file = files[0];
      if (file === undefined || file.contentHash.trim() === '') return failure('missing-source', index);
      revisions.set(source.partRef, `${file.contentHash}:${file.attachmentsDigest}`);
    }
    const sourceKey = componentSourceKey(component, revisions);
    if (sourceKey === null) return failure('missing-source', index);
    const partKey = partKeyOf(source);
    const part = resolved.parts.get(partKey);
    if (resolved.partKeys.get(id) !== partKey || part === undefined || resolved.subAssemblies?.has(id)) {
      return failure('inconsistent-tree', index);
    }
    if (resolved.errors.length > 0 || part.errors.length > 0) return failure('unresolved-view', index);
    // Mesh-only/empty leaves cannot supply the analytic faces required by either command.
    if (!part.steps.some(step => step.visible && part.liveBodyIds.includes(step.featureId))) {
      return failure('unsupported-geometry', index);
    }
    return { ok: true, occurrence: { path, occurrenceKey: JSON.stringify(path), motionOwnerId: path[0],
      leafDocument: document, leafComponent: component, partKey, sourceKey,
      resolvedPart: part, worldPlacement: placement } };
  }
  return failure('invalid-path', 0);
}
