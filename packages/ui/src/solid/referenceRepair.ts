import { canonicalDrawingSourceText } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { activeDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentRepairSlots, repairContextReady, repairContextTokens, type CurrentRepairSlot } from './referenceRepairContext.js';
import { repairCandidates, repairResolution, sameRepairReference, type RepairCandidate } from './referenceRepairCandidates.js';
import type { RepairConsumer } from './referenceRepairSlots.js';
import { repairImpactGraph } from './referenceRepairImpactGraph.js';
import { currentMathGeometry } from '../math/mathGeometryResults.js';
import { repairConsumerIssues } from './referenceRepairIssues.js';
import { clearDrawingRepairDescriptor } from '../drawing/referenceRepairProjection.js';
import { beginReferenceRepairPreview, clearReferenceRepairPreview } from './referenceRepairPreview.js';

export interface RepairImpact {
  readonly key: string;
  readonly ownerId: string;
  readonly name: string;
  readonly consumer: RepairConsumer;
  readonly status: 'matched' | 'missing' | 'ambiguous' | 'pending';
  readonly issue?: string;
}

export interface ReferenceRepairSession {
  readonly tokens: readonly unknown[];
  readonly slot: CurrentRepairSlot;
  readonly candidates: readonly RepairCandidate[];
  readonly impacts: readonly RepairImpact[];
  readonly status: 'matched' | 'missing' | 'ambiguous' | 'pending';
}

const revoked = new WeakSet<ReferenceRepairSession>();
const retireBorrows = new WeakMap<ReferenceRepairSession, () => void>();
function weakIdentityTokens(tokens: readonly unknown[]): readonly unknown[] {
  return tokens.map(token => (typeof token === 'object' && token !== null || typeof token === 'function') ? new WeakRef(token) : token);
}
const subscriptions = new WeakMap<ReferenceRepairSession, () => void>();
const hovered = new WeakMap<ReferenceRepairSession, string>();
let repairHoverOwner: WeakRef<ReferenceRepairSession> | null = null;

export function referenceRepairCurrent(session: ReferenceRepairSession, state = useAppStore.getState()): boolean {
  return !revoked.has(session) && repairContextReady(state)
    && repairContextTokens(state).every((token, index) => {
      const captured = session.tokens[index];
      return captured instanceof WeakRef ? captured.deref() === token : captured === token;
    });
}

/** Read only the hover owned by this exact current repair session. */
export function currentReferenceRepairHoverId(session: ReferenceRepairSession, state = useAppStore.getState()): string | null {
  const id = hovered.get(session);
  return id !== undefined && repairHoverOwner?.deref() === session && state.hoveredElementId === id
    && referenceRepairCurrent(session, state) ? id : null;
}

/** Inspect every affected slot again, including the other side of a dimension or mate. */
export function referenceRepairImpacts(state: AppState, source: CurrentRepairSlot): readonly RepairImpact[] {
  const slots = currentRepairSlots(state), affected = new Set([source.ownerId]);
  const sameSource = (slot: CurrentRepairSlot): boolean => slot.componentId === source.componentId && slot.sourceRef === source.sourceRef;
  for (const slot of slots) if (sameSource(slot) && (sameRepairReference(slot.reference, source.reference)
    || slot.reference.bodyFeatureId === source.reference.bodyFeatureId
      && slot.reference.origin !== undefined && source.reference.origin !== undefined
      && canonicalDrawingSourceText(slot.reference.origin) === canonicalDrawingSourceText(source.reference.origin))) affected.add(slot.ownerId);
  const active = activeDocument(state);
  const graph = repairImpactGraph(state, slots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, dependencies] of graph) if (!affected.has(id) && dependencies.some(id => affected.has(id))) {
      affected.add(id); changed = true;
    }
  }
  const ready = repairContextReady(state);
  const issues = ready ? repairConsumerIssues(state) : new Map<string, string>();
  const impacts: RepairImpact[] = slots.filter(slot => affected.has(slot.ownerId)).map(slot => ({
    key: slot.key, ownerId: slot.ownerId, name: slot.name, consumer: slot.consumer,
    status: ready && slot.available ? repairResolution(slot).status : 'pending',
    ...(issues.has(slot.ownerId) ? { issue: issues.get(slot.ownerId) ?? '' } : {}),
  }));
  if (active.kind === 'part') for (const feature of [...active.document.references, ...active.document.solids]) {
    if (!affected.has(feature.id) || impacts.some(item => item.ownerId === feature.id)) continue;
    impacts.push({ key: feature.id, ownerId: feature.id, name: feature.name,
      consumer: feature.kind.startsWith('reference') ? 'reference' : 'machining',
      status: !ready ? 'pending' : state.partErrors.some(error => error.featureId === feature.id) ? 'missing' : 'matched' });
  }
  if (active.kind === 'part') for (const definition of active.document.mathGeometry ?? []) {
    if (!affected.has(definition.id)) continue;
    const results = currentMathGeometry(state), outcome = results.status === 'current' ? results.outcomes.get(definition.id) : undefined;
    const index = impacts.findIndex(item => item.ownerId === definition.id);
    const result: RepairImpact = { key: definition.id, ownerId: definition.id, name: definition.name, consumer: 'dimension',
      status: !ready || outcome === undefined ? 'pending' : outcome.status === 'value' ? 'matched'
        : outcome.reason === 'ambiguous-reference' ? 'ambiguous' : 'missing',
      ...(outcome?.status === 'unresolved' ? { issue: outcome.message } : {}),
    };
    if (index === -1) impacts.push(result);
    else impacts[index] = { ...result, key: impacts[index].key };
  }
  if (active.kind === 'drawing') for (const item of [...active.document.dimensions, ...active.document.datums,
    ...active.document.gdtFrames, ...active.document.weldSymbols]) {
    if (!affected.has(item.id) || impacts.some(impact => impact.ownerId === item.id)) continue;
    impacts.push({ key: item.id, ownerId: item.id, name: item.id,
      consumer: active.document.dimensions.some(dimension => dimension.id === item.id) ? 'dimension' : 'annotation',
      status: !ready ? 'pending' : issues.has(item.id) ? 'missing' : 'matched',
      ...(issues.has(item.id) ? { issue: issues.get(item.id) ?? '' } : {}) });
  }
  return impacts;
}

export function beginReferenceRepair(key: string): ReferenceRepairSession | null {
  const state = useAppStore.getState();
  if (!repairContextReady(state)) return null;
  const slot = currentRepairSlots(state).find(slot => slot.key === key);
  if (slot === undefined) return null;
  // No old session token, slot getter or callback retains the original AppState/mesh graph.
  const { bodies, apply: _apply, hoverId: _hoverId, ...metadata } = slot;
  void _apply; void _hoverId; // Excluded callbacks must never become part of the borrowed metadata closure.
  const weakBodies = bodies.map(body => new WeakRef(body));
  const lifetime: { active: boolean; candidates: readonly RepairCandidate[] } = { active: true, candidates: repairCandidates(slot) };
  const currentSlot = (state: AppState): CurrentRepairSlot | undefined => lifetime.active
    ? currentRepairSlots(state).find(current => current.key === metadata.key && current.reference === metadata.reference) : undefined;
  const borrowed: CurrentRepairSlot = { ...metadata,
    get bodies() { return !lifetime.active ? [] : weakBodies.flatMap(ref => { const body = ref.deref(); return body === undefined ? [] : [body]; }); },
    hoverId: (reference, owner) => currentSlot(useAppStore.getState())?.hoverId(reference, owner) ?? null,
    apply: (state, reference) => currentSlot(state)?.apply(state, reference),
  };
  const session: ReferenceRepairSession = { tokens: weakIdentityTokens(repairContextTokens(state)), slot: borrowed,
    get candidates() { return lifetime.candidates; }, status: slot.available ? repairResolution(slot).status : 'pending', impacts: referenceRepairImpacts(state, slot) };
  retireBorrows.set(session, () => { lifetime.active = false; lifetime.candidates = []; });
  subscriptions.set(session, useAppStore.subscribe(next => {
    if (!referenceRepairCurrent(session, next)) cancelReferenceRepair(session);
  }));
  return session;
}

export function hoverReferenceRepair(session: ReferenceRepairSession, candidate: RepairCandidate | null): boolean {
  const state = useAppStore.getState();
  if (candidate === null) {
    const id = hovered.get(session);
    hovered.delete(session);
    clearReferenceRepairPreview(session);
    if (id !== undefined) clearDrawingRepairDescriptor(id);
    if (repairHoverOwner?.deref() === session) {
      repairHoverOwner = null;
      if (id !== undefined && state.hoveredElementId === id) state.setHovered(null);
    }
    return true;
  }
  if (!referenceRepairCurrent(session, state) || !session.candidates.includes(candidate)) return false;
  const id = session.slot.hoverId(candidate.reference, session);
  if (id === null) {
    hoverReferenceRepair(session, null);
    return false;
  }
  hovered.set(session, id);
  repairHoverOwner = new WeakRef(session);
  beginReferenceRepairPreview(session, candidate, id, state, referenceRepairCurrent);
  state.setHovered(id);
  return true;
}

export function cancelReferenceRepair(session: ReferenceRepairSession): void {
  revoked.add(session);
  retireBorrows.get(session)?.();
  retireBorrows.delete(session);
  subscriptions.get(session)?.();
  subscriptions.delete(session);
  hoverReferenceRepair(session, null);
}

export function commitReferenceRepair(session: ReferenceRepairSession, candidate: RepairCandidate): 'applied' | 'stale' | 'unavailable' | 'unchanged' {
  const state = useAppStore.getState();
  if (!referenceRepairCurrent(session, state)) return 'stale';
  if (!session.candidates.includes(candidate) || !candidate.selectable) return 'unavailable';
  const current = currentRepairSlots(state).find(slot => slot.key === session.slot.key);
  if (current === undefined || current.reference !== session.slot.reference) return 'stale';
  const verified = repairCandidates(current).find(item => item.body === candidate.body
    && item.selectable && sameRepairReference(item.reference, candidate.reference));
  if (verified === undefined) return 'unavailable';
  if (sameRepairReference(current.reference, verified.reference)) return 'unchanged';
  hoverReferenceRepair(session, null);
  if (!referenceRepairCurrent(session)) return 'stale';
  cancelReferenceRepair(session);
  current.apply(useAppStore.getState(), verified.reference);
  return 'applied';
}
