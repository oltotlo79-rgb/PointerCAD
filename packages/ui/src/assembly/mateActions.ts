import { findComponent, type JointKind, type MateKind, type MateTarget, type OriginElement } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { appendMateTarget, assemblyTargetId, availableMateKinds, commitJoint, commitMate, createMateDraft, defaultMateSource,
  editMateDraft, refreshMateDraft, removeMate, resolveCurrentMateTarget, toggleMateFlipped,
  type AssemblyMateDraft, type JointCommandOutcome, type MateCommandOutcome } from './mateCommands.js';

type MateState = ReturnType<typeof useAppStore.getState>;

export function mateDraftCheck(state: MateState): MateCommandOutcome | null {
  const { assembly, assemblyMateDraft: draft, assemblyView: view } = state;
  if (assembly === null || draft === null || draft.documentId !== state.activeDocumentId) return null;
  if (state.assemblyPlacement !== null || state.isComputing || view === null
    || (view.sourceDocument !== undefined && view.sourceDocument !== assembly)) {
    return { ok: false, reason: 'stale', message: t('assembly.mate.waitForGeometry') };
  }
  for (const target of draft.targets) {
    const resolved = resolveCurrentMateTarget(assembly, view, target);
    if (!resolved.ok) return { ok: false, reason: 'stale', message: resolved.message };
  }
  return commitMate(assembly, refreshMateDraft(assembly, view, draft));
}

export function mateFailureText(outcome: MateCommandOutcome | null): string | null {
  if (outcome === null || outcome.ok) return null;
  return outcome.message ?? outcome.error?.message ?? t(outcome.reason === 'targets' ? 'assembly.mate.needTwo'
    : outcome.reason === 'sameComponent' ? 'assembly.mate.differentComponents'
      : outcome.reason === 'stale' ? 'assembly.mate.targetMissing' : 'assembly.mate.invalidTargets');
}

function putDraft(draft: AssemblyMateDraft): void {
  const state = useAppStore.getState();
  const next = state.assembly !== null && state.assemblyView !== null
    ? refreshMateDraft(state.assembly, state.assemblyView, draft) : draft;
  useAppStore.setState({ assemblyMateDraft: next, selection: next.targets.map(assemblyTargetId) });
}

/** 対象先行でもコマンド先行でも同じdraftを使う。種類変更では対象を捨てない。 */
export function startMate(kind: MateKind): void {
  const state = useAppStore.getState();
  if (state.assembly === null || state.assemblyPlacement !== null) return;
  const previous = state.assemblyMateDraft;
  if (previous === null && state.selectionKind === 'body') useAppStore.setState({ selectionKind: 'face' });
  const draft = previous?.documentId === state.activeDocumentId ? previous : createMateDraft(state.activeDocumentId, kind);
  putDraft({ ...draft, kind, jointKind: undefined, mode: 'command', source: draft.kind === kind ? draft.source : defaultMateSource(kind),
    alignmentChosen: draft.kind === kind ? draft.alignmentChosen : false, issue: null });
}

export function startJoint(kind: JointKind): void {
  const state = useAppStore.getState();
  if (state.assembly === null || state.assemblyPlacement !== null) return;
  const previous = state.assemblyMateDraft;
  if (previous === null && state.selectionKind === 'body') useAppStore.setState({ selectionKind: 'face' });
  const draft = previous?.documentId === state.activeDocumentId
    ? previous
    : createMateDraft(state.activeDocumentId, 'coincident');
  putDraft({ ...draft, jointKind: kind, mode: 'command', issue: null });
}

export function cancelMate(): void {
  useAppStore.setState({ assemblyMateDraft: null, selection: [], hoveredElementId: null });
}

export function updateMateSource(source: string): void {
  const draft = useAppStore.getState().assemblyMateDraft;
  if (draft !== null) useAppStore.setState({ assemblyMateDraft: { ...draft, source, issue: null } });
}

export function toggleDraftFlipped(): void {
  const draft = useAppStore.getState().assemblyMateDraft;
  if (draft !== null) useAppStore.setState({ assemblyMateDraft: { ...draft, flipped: !draft.flipped, alignmentChosen: true, issue: null } });
}

export function removeDraftTarget(index: number): void {
  const draft = useAppStore.getState().assemblyMateDraft;
  if (draft !== null) putDraft({ ...draft, targets: draft.targets.filter((_, i) => i !== index),
    targetKinds: draft.targetKinds.filter((_, i) => i !== index), alignmentChosen: false, issue: null });
}

export function addMateTarget(target: MateTarget): boolean {
  const state = useAppStore.getState();
  if (state.assembly === null || state.assemblyPlacement !== null || state.assemblyView === null || state.isComputing) return false;
  let draft = state.assemblyMateDraft;
  if (draft !== null && draft.documentId !== state.activeDocumentId) return false;
  const resolved = resolveCurrentMateTarget(state.assembly, state.assemblyView, target);
  if (!resolved.ok) {
    if (draft !== null) useAppStore.setState({ assemblyMateDraft: { ...draft, issue: resolved.message } });
    return false;
  }
  draft ??= { ...createMateDraft(state.activeDocumentId, 'coincident'), mode: 'selection' };
  const next = appendMateTarget(draft, target, resolved.target.kind);
  if (next === null) {
    useAppStore.setState({ assemblyMateDraft: { ...draft, issue: t(draft.targets.length >= 2 ? 'assembly.mate.needTwo' : 'assembly.mate.differentComponents') } });
    return false;
  }
  putDraft({ ...next, issue: null });
  return true;
}

export function addSelectedOriginTarget(element: OriginElement): boolean {
  const state = useAppStore.getState();
  const assembly = state.assembly;
  if (assembly === null) return false;
  const components = state.selection.filter((id) => findComponent(assembly, id) !== undefined);
  return components.length === 1 && addMateTarget({ kind: 'origin', componentId: components[0], element });
}

export function commitMateDraft(): MateCommandOutcome | null {
  const state = useAppStore.getState();
  const outcome = mateDraftCheck(state);
  if (outcome?.ok === true) {
    state.applyAssembly(outcome.document);
    useAppStore.setState({ selection: [outcome.mate.id], hoveredElementId: null });
  } else if (outcome !== null && state.assemblyMateDraft !== null) {
    useAppStore.setState({ assemblyMateDraft: { ...state.assemblyMateDraft, issue: mateFailureText(outcome) } });
  }
  return outcome;
}

export function updateJointRangeSource(bound: 'min' | 'max', source: string): void {
  const draft = useAppStore.getState().assemblyMateDraft;
  if (draft === null) return;
  useAppStore.setState({ assemblyMateDraft: {
    ...draft,
    [bound === 'min' ? 'minSource' : 'maxSource']: source,
    issue: null,
  } });
}

export function jointDraftCheck(state: MateState, kind: JointKind): JointCommandOutcome | null {
  const draft = state.assemblyMateDraft;
  const assembly = state.assembly;
  const view = state.assemblyView;
  if (assembly === null || view === null || draft === null || draft.jointKind !== kind
    || draft.documentId !== state.activeDocumentId || draft.targets.length !== 2
    || state.assemblyPlacement !== null || state.isComputing) return null;
  const resolved = draft.targets.map((target) => resolveCurrentMateTarget(assembly, view, target));
  const stale = resolved.find((result) => !result.ok);
  if (stale !== undefined && !stale.ok) return { ok: false, reason: 'stale', message: stale.message };
  if (kind !== 'ball' && !resolved.every((result) => result.ok && 'direction' in result.target)) {
    return { ok: false, reason: 'kind' };
  }
  return commitJoint(assembly, draft);
}

export function jointFailureText(outcome: JointCommandOutcome | null): string | null {
  if (outcome === null || outcome.ok) return null;
  return outcome.message ?? outcome.error?.message ?? t(outcome.reason === 'targets' ? 'assembly.mate.needTwo'
    : outcome.reason === 'sameComponent' ? 'assembly.mate.differentComponents'
      : outcome.reason === 'stale' ? 'assembly.mate.targetMissing'
        : outcome.reason === 'range' ? 'assembly.joint.invalidRange' : 'assembly.joint.invalidTargets');
}

export function jointDraftReady(state: MateState, kind: JointKind): boolean {
  return jointDraftCheck(state, kind)?.ok === true;
}

export function jointKindReadiness(state: MateState, kind: JointKind): {
  readonly ready: boolean; readonly reasonKey: 'assembly.mate.notReady' | null;
} {
  const assembly = state.assembly;
  if (assembly === null || state.assemblyPlacement !== null
    || assembly.components.filter((component) => !component.suppressed).length < 2) {
    return { ready: false, reasonKey: 'assembly.mate.notReady' };
  }
  const draft = state.assemblyMateDraft;
  if (draft === null || draft.targets.length < 2) return { ready: true, reasonKey: null };
  const view = state.assemblyView;
  if (draft.targets.length !== 2 || view === null) {
    return { ready: false, reasonKey: 'assembly.mate.notReady' };
  }
  const resolved = draft.targets.map((target) =>
    resolveCurrentMateTarget(assembly, view, target));
  const ready = resolved.every((result) => result.ok)
    && (kind === 'ball' || resolved.every((result) =>
      result.ok && 'direction' in result.target));
  return ready
    ? { ready: true, reasonKey: null }
    : { ready: false, reasonKey: 'assembly.mate.notReady' };
}

export function commitJointDraft(): boolean {
  const state = useAppStore.getState();
  const draft = state.assemblyMateDraft;
  if (draft?.jointKind === undefined) return false;
  const outcome = jointDraftCheck(state, draft.jointKind);
  if (outcome?.ok !== true) {
    if (outcome !== null) useAppStore.setState({ assemblyMateDraft: { ...draft, issue: jointFailureText(outcome) } });
    return false;
  }
  state.applyAssembly(outcome.document);
  useAppStore.setState({ selection: [outcome.joint.id], hoveredElementId: null });
  return true;
}

export function handleMateKey(key: string, isComposing = false): boolean {
  if (isComposing || useAppStore.getState().assemblyMateDraft === null) return false;
  if (key === 'Escape') { cancelMate(); return true; }
  if (key === 'Enter') {
    if (useAppStore.getState().assemblyMateDraft?.jointKind === undefined) commitMateDraft();
    else commitJointDraft();
    return true;
  }
  return false;
}

export function mateKindReadiness(state: MateState, kind: MateKind): { readonly ready: boolean; readonly reasonKey: 'assembly.mate.notReady' | 'assembly.mate.needTwo' | 'assembly.mate.invalidTargets' | null } {
  if (state.assembly === null || state.assemblyPlacement !== null || state.assembly.components.filter((c) => !c.suppressed).length < 2)
    return { ready: false, reasonKey: 'assembly.mate.notReady' };
  const draft = state.assemblyMateDraft;
  if (draft === null || draft.targets.length < 2) return { ready: true, reasonKey: null };
  if (draft.targets.length !== 2) return { ready: false, reasonKey: 'assembly.mate.needTwo' };
  const current = state.assemblyView === null ? draft : refreshMateDraft(state.assembly, state.assemblyView, draft);
  const [a, b] = current.targetKinds;
  return a !== undefined && b !== undefined && availableMateKinds(a, b).includes(kind)
    ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.mate.invalidTargets' };
}

export function editAssemblyMate(mateId: string): void {
  const state = useAppStore.getState();
  if (state.assemblyPlacement !== null) return;
  const mate = state.assembly?.mates.find((item) => item.id === mateId);
  if (mate !== undefined) putDraft(editMateDraft(state.activeDocumentId, mate));
}

export function deleteAssemblyMate(mateId: string): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  const next = removeMate(state.assembly, mateId);
  if (next !== state.assembly) state.applyAssembly(next);
}

export function flipAssemblyMate(mateId: string): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  const next = toggleMateFlipped(state.assembly, mateId);
  if (next !== state.assembly) state.applyAssembly(next);
}
