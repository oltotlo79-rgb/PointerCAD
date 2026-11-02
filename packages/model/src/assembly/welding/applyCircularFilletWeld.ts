/** Root occurrence commit only. Consumer: future UI and these two pure tests.
 * No child definition mutation and no public/Worker/save variant is added.
 */
import { addComponent, createComponentFor, removeComponent } from '../assemblyEdit.js';
import { jointOccurrencePath } from '../jointOccurrence.js';
import { appendJointOccurrenceComponents, prepareJointOccurrencePair, type JointOccurrenceCommandContext } from '../jointOccurrenceSelection.js';
import { canonicalTextOf } from '../partLibrary.js';
import type { AssemblyDocument, JointOccurrenceConnection } from '../types.js';
import { circularFilletWeldState, planCircularFilletWeld, type CircularFilletWeldFailure,
  type CircularFilletWeldPlan, type CircularFilletWeldRequest } from './planCircularFilletWeld.js';

export type ApplyCircularFilletWeldResult = { readonly ok: true; readonly document: AssemblyDocument;
  readonly componentIds: readonly string[]; readonly connection: JointOccurrenceConnection }
  | { readonly ok: false; readonly document: AssemblyDocument; readonly reason: CircularFilletWeldFailure };

export function applyCircularFilletWeld(context: JointOccurrenceCommandContext, request: CircularFilletWeldRequest,
  preview: CircularFilletWeldPlan): ApplyCircularFilletWeldResult {
  const document = context.inputs.document;
  const refuse = (reason: CircularFilletWeldFailure): ApplyCircularFilletWeldResult => ({ ok: false, document, reason });
  if (preview.inputs.document !== document || preview.inputs.library !== context.inputs.library
    || preview.inputs.subAssemblies !== context.inputs.subAssemblies || preview.view !== context.view || preview.resolved !== context.view.resolved
    || canonicalTextOf(request) !== canonicalTextOf(preview.request)) return refuse('preview-changed');
  const current = planCircularFilletWeld(context, request);
  if (!current.ok) return refuse(current.reason);
  if (current.plan.identity !== preview.identity) return refuse('preview-changed');
  const firstPath = jointOccurrencePath(request.plane.path), secondPath = jointOccurrencePath(request.cylinder.path);
  if (firstPath === null || secondPath === null) return refuse('invalid-request');
  const prepared = prepareJointOccurrencePair(context, firstPath, secondPath);
  if (!prepared.ok) return refuse(prepared.reason);
  const pair = prepared.pair;
  let staged = pair.geometryDocument;
  const generatedIds: string[] = [];
  for (const bead of current.plan.beads) {
    const component = { ...createComponentFor(staged, bead.source, { partName: request.weldId, placement: bead.placement }), materialId: bead.materialId };
    staged = addComponent(staged, component); generatedIds.push(component.id);
  }
  // Existing root append allocates while every old bead still exists, then joins
  // the real motion owners and all existing rigid-group members without moving them.
  const appended = appendJointOccurrenceComponents(context, pair, staged, generatedIds, 'weld');
  if (!appended.ok) return refuse(appended.reason);
  const finalState = circularFilletWeldState(context, pair);
  if (context.inputs.document !== document || context.inputs.library !== preview.inputs.library
    || context.inputs.subAssemblies !== preview.inputs.subAssemblies || context.view !== preview.view || context.view.resolved !== preview.resolved
    || canonicalTextOf(request) !== canonicalTextOf(preview.request)
    || finalState !== current.plan.state) return refuse('preview-changed');
  let next = appended.document;
  for (const id of current.plan.replacedComponentIds) next = removeComponent(next, id);
  if (current.plan.connectionIndex !== null) {
    const originals = new Map(document.components.map(component => [component.id, component]));
    // Association validation already forbids every old-bead mate/joint target.
    // Preserve the original constraints, including their immutable identities.
    next = { ...next, mates: document.mates, joints: document.joints,
      components: next.components.map(c => originals.get(c.id) ?? c),
      jointOccurrenceConnections: (document.jointOccurrenceConnections ?? []).map((connection, index) =>
        index === current.plan.connectionIndex ? appended.connection : connection) };
  }
  return { ok: true, document: next, componentIds: appended.componentIds, connection: appended.connection };
}
