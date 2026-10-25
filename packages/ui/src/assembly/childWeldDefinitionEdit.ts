import {
  applyFilletWeld, filletWeldSegmentOptions, MAX_SUB_ASSEMBLY_DEPTH, planFilletWeldEdit,
  type AssemblyDocument, type FilletWeldRejection, type PartLibrary, type WeldBodyLookup,
} from '@pointercad/model';
import type { AssemblyFilletWeldDraft } from './filletWeldDraft.js';
import { nestedWeldEditRequest } from './nestedWeldDraft.js';

/**
 * A weld group stored inside a child DEFINITION, reached through one exact occurrence path ending at one of its beads.
 * Editing it edits the shared definition: every placement of that definition changes. The scope is therefore explicit
 * and the number of actual placement paths of that definition (suppressed ones included) is part of the confirmation.
 */
export interface ChildWeldDefinitionTarget {
  readonly path: readonly string[];
  readonly assemblyRef: string;
  /** The definition object at selection time; a different object at commit time means the target is stale. */
  readonly child: AssemblyDocument;
  readonly weldId: string;
  readonly affectedPlacements: number;
}

export type ChildWeldDefinitionRefusal =
  | 'pathTooShort' | 'occurrenceMissing' | 'occurrenceSuppressed' | 'notSubAssembly' | 'definitionMissing'
  | 'beadMissing' | 'beadSuppressed' | 'notWeld' | 'definitionTreeInvalid';

/**
 * What the user confirmed in the product: the definition scope and the exact number of affected placements. The same
 * confirmation states that saved analysis settings must be rechecked: they stay stored, are never remapped or deleted,
 * and the changed CAD source stamp refuses them until they are confirmed again.
 */
export interface ChildWeldDefinitionScope {
  readonly scope: 'definition';
  readonly assemblyRef: string;
  readonly affectedPlacements: number;
}

export type ChildWeldDefinitionCommit =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly library: PartLibrary; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly reason: 'stale' | 'confirmationRequired' | 'invalidDraft' }
  | { readonly ok: false; readonly reason: 'planRefused' | 'applyRefused'; readonly rejections: readonly FilletWeldRejection[] };

/**
 * Number of actual placement paths of `assemblyRef` reachable from the root: a parent placed twice that places the
 * definition twice gives 4. Suppressed placements are included (they still reference the shared definition); library
 * definitions that the root never reaches do not contribute. Depth follows resolveAssembly exactly: the root document
 * is depth 0 and a subassembly placement is refused when depth + 1 > MAX_SUB_ASSEMBLY_DEPTH, so exactly eight nested
 * levels are counted and a ninth is refused. Returns null for a reachable tree that is cyclic, too deep or references
 * a missing definition, so such a target is refused instead of guessed.
 */
export function definitionPlacementCount(document: AssemblyDocument, library: PartLibrary, assemblyRef: string): number | null {
  const walk = (owner: AssemblyDocument, depth: number, ancestors: readonly string[]): number | null => {
    let count = 0;
    for (const component of owner.components) {
      if (component.source.kind !== 'subAssembly') continue;
      const ref = component.source.assemblyRef;
      const child = library.assemblies?.get(ref);
      if (ancestors.includes(ref) || depth + 1 > MAX_SUB_ASSEMBLY_DEPTH || child === undefined) return null;
      const nested = walk(child, depth + 1, [...ancestors, ref]);
      if (nested === null) return null;
      count += (ref === assemblyRef ? 1 : 0) + nested;
    }
    return count;
  };
  return walk(document, 0, []);
}

/**
 * Resolve the exact path: every ancestor is a unique, unsuppressed subassembly occurrence with an embedded definition,
 * and the last id is an unsuppressed fillet weld bead of the innermost definition. Nothing is guessed or remapped.
 */
export function childWeldDefinitionTarget(
  document: AssemblyDocument, library: PartLibrary, path: readonly string[],
): ChildWeldDefinitionTarget | { readonly refusal: ChildWeldDefinitionRefusal } {
  if (path.length < 2) return { refusal: 'pathTooShort' };
  if (path.length - 1 > MAX_SUB_ASSEMBLY_DEPTH) return { refusal: 'definitionTreeInvalid' };
  let current = document;
  let assemblyRef: string | null = null;
  const ancestors: string[] = [];
  for (const id of path.slice(0, -1)) {
    const rows = current.components.filter((component) => component.id === id);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) return { refusal: 'occurrenceMissing' };
    if (row.suppressed) return { refusal: 'occurrenceSuppressed' };
    if (row.source.kind !== 'subAssembly') return { refusal: 'notSubAssembly' };
    if (ancestors.includes(row.source.assemblyRef)) return { refusal: 'definitionTreeInvalid' };
    const next = library.assemblies?.get(row.source.assemblyRef);
    if (next === undefined) return { refusal: 'definitionMissing' };
    current = next;
    assemblyRef = row.source.assemblyRef;
    ancestors.push(assemblyRef);
  }
  const beads = current.components.filter((component) => component.id === path[path.length - 1]);
  const bead = beads[0];
  if (beads.length !== 1 || bead === undefined || assemblyRef === null) return { refusal: 'beadMissing' };
  if (bead.suppressed) return { refusal: 'beadSuppressed' };
  const options = bead.source.kind === 'standardPart' && bead.source.catalog === 'filletWeld'
    ? filletWeldSegmentOptions(bead.source.options) : null;
  if (options === null) return { refusal: 'notWeld' };
  const affectedPlacements = definitionPlacementCount(document, library, assemblyRef);
  if (affectedPlacements === null || affectedPlacements < 1) return { refusal: 'definitionTreeInvalid' };
  return { path: [...path], assemblyRef, child: current, weldId: options.weldId, affectedPlacements };
}

/**
 * One atomic edit of the shared definition with the existing planner and apply step. The target is resolved again
 * from the CURRENT document and library and must be the same definition object, ref, weld and placement count that
 * the user confirmed; otherwise nothing is produced. The root document is returned unchanged (same object): only the
 * definition in the library is replaced, so the caller's applyAssembly(document, library) is one Undo step.
 */
export function commitChildWeldDefinitionEdit(
  document: AssemblyDocument, library: PartLibrary, target: ChildWeldDefinitionTarget,
  draft: AssemblyFilletWeldDraft, confirmed: ChildWeldDefinitionScope | null, bodiesOf: WeldBodyLookup,
  partRevisions: ReadonlyMap<string, string> = new Map(),
): ChildWeldDefinitionCommit {
  const current = childWeldDefinitionTarget(document, library, target.path);
  if ('refusal' in current || current.child !== target.child || current.assemblyRef !== target.assemblyRef
    || current.weldId !== target.weldId || draft.weldId !== target.weldId) return { ok: false, reason: 'stale' };
  if (confirmed === null || confirmed.scope !== 'definition' || confirmed.assemblyRef !== current.assemblyRef
    || confirmed.affectedPlacements !== current.affectedPlacements) return { ok: false, reason: 'confirmationRequired' };
  const request = nestedWeldEditRequest(current.child, draft);
  if (request === null) return { ok: false, reason: 'invalidDraft' };
  const plan = planFilletWeldEdit(current.child, request, partRevisions, bodiesOf);
  if (!plan.ok) return { ok: false, reason: 'planRefused', rejections: plan.rejections };
  const applied = applyFilletWeld(current.child, plan.plan, partRevisions);
  if (!applied.ok) return { ok: false, reason: 'applyRefused', rejections: applied.rejections };
  const assemblies = new Map<string, AssemblyDocument>(library.assemblies ?? []);
  assemblies.set(current.assemblyRef, applied.document);
  return { ok: true, document, library: { ...library, assemblies }, componentIds: applied.componentIds };
}
