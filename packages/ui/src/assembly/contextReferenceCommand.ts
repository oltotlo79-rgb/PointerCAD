/**
 * 組立の文脈の参照の確定。model の `commitContextReference` を呼び、結果を `applyAssembly`
 * (1回が Undo の1段)へ渡す。元の点は、確定を始めた時の表示の形(`assemblyView`)から引く。
 *
 * 部品の一式のハッシュを待つ間に、次のどれかが変わったら古い計算は書かない(`stale`):
 * 組立・部品の一式・表示の形(作り直し)・Undo の履歴(Undo して戻した場合も、履歴の山は別のものになる)。
 * 形の計算中、または表示の形が今の組立のものでない時は、始めない。
 */

import { canPersistAssemblyPartEdit } from '@pointercad/io';
import {
  type AssemblyComponent, createAssemblyDocumentBundle, commitContextReference, contextPointResolverFromBodies, type ContextReferenceLink,
  type ContextReferenceRejection, resolveSubShapeReference,
} from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { beginDocumentRequest } from '../store/documentRequest.js';

import { contextPlanePoints, contextSource, currentAssemblyContext } from './assemblyContextGeometry.js';
import { sharedPartOccurrenceCount } from './partOccurrenceCount.js';

export type ContextReferenceCommandResult =
  | { readonly status: 'committed' | 'unchanged' | 'saveFailed' }
  | { readonly status: 'rejected'; readonly rejection: ContextReferenceRejection }
  /** 始めた時と組立・一式・表示の形・履歴のどれかが違う。何も書いていない。 */
  | { readonly status: 'stale' }
  /** 組立が無い、形の計算中、または表示の形が今の組立のものでない。 */
  | { readonly status: 'notReady' };

/** 置いた部品の今のボディ(締結の `boltedJointDraft.ts` と同じ引き方)。 */
export function contextBodiesOf(view: AssemblyView, component: AssemblyComponent) {
  const key = view.resolved.partKeys.get(component.id);
  return key === undefined ? null : view.bodies.get(key) ?? null;
}

export async function runContextReferenceCommit(
  get: () => AppState, link: ContextReferenceLink, operation: 'commit' | 'detach' = 'commit',
  ownsForm: () => boolean = () => true,
): Promise<ContextReferenceCommandResult> {
  const before = get();
  const { assembly: document, assemblyLibrary: library, assemblyView: view, assemblyUndoStack: history } = before;
  if (document === null) return { status: 'notReady' };
  const request = beginDocumentRequest('assembly.contextReferenceCommit', before);
  const binding = link.plane;
  if (operation === 'detach') {
    const links = document.contextReferences;
    if (!ownsForm() || binding === undefined || links === undefined || !links.includes(link)) return { status: 'stale' };
    before.applyAssembly({ ...document, contextReferences: links.filter(other => other !== link) }, library);
    return { status: 'committed' };
  }
  if (view === null || view.sourceDocument !== document || before.isComputing) return { status: 'notReady' };
  if (binding !== undefined) {
    if (currentAssemblyContext(before) !== view) return { status: 'notReady' };
    const occurrences = sharedPartOccurrenceCount(document, library, binding.targetPartRef);
    if (!occurrences.complete || occurrences.count !== 1) {
      return { status: 'rejected', rejection: { code: 'targetPartShared', linkId: link.id } };
    }
  }
  const current = (state: AppState): boolean => ownsForm() && request.isCurrent() && state.assembly === document
    && state.assemblyLibrary === library && state.assemblyView === view && state.assemblyUndoStack === history && !state.isComputing
    && (binding === undefined || (currentAssemblyContext(state) === view
      && state.partEdit?.id === before.partEdit?.id && state.selection === before.selection
      && state.cancelRequestCount === before.cancelRequestCount && state.numericInputRevision === before.numericInputRevision));
  const resolvePoint = contextPointResolverFromBodies(component => contextBodiesOf(view, component), resolveSubShapeReference);
  try {
    const result = await commitContextReference(document, library, link, resolvePoint, candidate => {
      const source = contextSource(before, candidate.targetComponentId, candidate.sourceComponentId, candidate.source.bodyFeatureId);
      return source === null ? null : contextPlanePoints(source, candidate.source, true);
    });
    if (!current(get())) return { status: 'stale' };
    if ('code' in result) return { status: 'rejected', rejection: result };
    if (result.document === document && result.library === library) return { status: 'unchanged' };
    if (binding !== undefined) {
      const fits = await canPersistAssemblyPartEdit(createAssemblyDocumentBundle(result.document, result.library));
      if (!current(get())) return { status: 'stale' };
      if (!fits) return { status: 'saveFailed' };
    }
    get().applyAssembly(result.document, result.library);
    return { status: 'committed' };
  } catch {
    return { status: current(get()) ? 'saveFailed' : 'stale' };
  }
}
