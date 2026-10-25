/**
 * 組立の文脈の参照の確定(EX-18)。model の `commitContextReference` を呼び、結果を `applyAssembly`
 * (1回が Undo の1段)へ渡す。元の点は、確定を始めた時の表示の形(`assemblyView`)から引く。
 *
 * 部品の一式のハッシュを待つ間に、次のどれかが変わったら古い計算は書かない(`stale`):
 * 組立・部品の一式・表示の形(作り直し)・Undo の履歴(Undo して戻した場合も、履歴の山は別のものになる)。
 * 形の計算中、または表示の形が今の組立のものでない時は、始めない。
 */

import {
  type AssemblyComponent, commitContextReference, contextPointResolverFromBodies, type ContextReferenceLink,
  type ContextReferenceRejection, resolveSubShapeReference,
} from '@pointercad/model';
import type { AssemblySlice, AssemblyView } from '../store/assemblySlice.js';
import { beginDocumentRequest } from '../store/documentRequest.js';

interface ContextReferenceStore {
  readonly assembly: AssemblySlice['assembly'];
  readonly assemblyLibrary: AssemblySlice['assemblyLibrary'];
  readonly assemblyView: AssemblySlice['assemblyView'];
  readonly assemblyUndoStack: AssemblySlice['assemblyUndoStack'];
  readonly isComputing: boolean;
  readonly applyAssembly: AssemblySlice['applyAssembly'];
}

export type ContextReferenceCommandResult =
  | { readonly status: 'committed' }
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
  get: () => ContextReferenceStore, link: ContextReferenceLink,
): Promise<ContextReferenceCommandResult> {
  const before = get();
  const { assembly: document, assemblyLibrary: library, assemblyView: view, assemblyUndoStack: history } = before;
  if (document === null || view === null || view.sourceDocument !== document || before.isComputing) {
    return { status: 'notReady' };
  }
  const request = beginDocumentRequest('assembly.contextReferenceCommit');
  const resolvePoint = contextPointResolverFromBodies((component) => contextBodiesOf(view, component), resolveSubShapeReference);
  const result = await commitContextReference(document, library, link, resolvePoint);
  if ('code' in result) return { status: 'rejected', rejection: result };
  const now = get();
  if (!request.isCurrent() || now.assembly !== document || now.assemblyLibrary !== library || now.assemblyView !== view
    || now.assemblyUndoStack !== history || now.isComputing) return { status: 'stale' };
  now.applyAssembly(result.document, result.library);
  return { status: 'committed' };
}
