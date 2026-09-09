import { deleteNamedView, renameNamedView, saveNamedView, type NamedView, type NamedViewRefusal } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';

export type NamedViewAction =
  | { readonly kind: 'save'; readonly name: string }
  | { readonly kind: 'restore'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string }
  | { readonly kind: 'rename'; readonly id: string; readonly name: string };
export type NamedViewActionResult = { readonly ok: true }
  | { readonly ok: false; readonly reason: NamedViewRefusal | 'unavailable' };

/** 保存・改名・削除は文書のUndoに入り、視点へ戻る操作は表示だけを変える。 */
export function runNamedViewAction(action: NamedViewAction): NamedViewActionResult {
  const state = useAppStore.getState();
  if (state.drawing !== null) return { ok: false, reason: 'unavailable' };
  const document = state.assembly ?? state.document;
  const views = document.namedViews;
  let next: readonly NamedView[];
  if (action.kind === 'restore') {
    const view = views.find((entry) => entry.id === action.id);
    if (view === undefined) return { ok: false, reason: 'notFound' };
    return state.viewCameraController?.restore(view) === true ? { ok: true } : { ok: false, reason: 'unavailable' };
  }
  if (action.kind === 'delete') {
    next = deleteNamedView(views, action.id);
    if (next === views) return { ok: false, reason: 'notFound' };
  } else {
    const result = action.kind === 'rename' ? renameNamedView(views, action.id, action.name)
      : state.viewCameraController === null ? null : saveNamedView(views, action.name, state.viewCameraController.capture());
    if (result === null) return { ok: false, reason: 'unavailable' };
    if (!result.ok) return result;
    next = result.views;
  }
  if (next !== views) {
    if (state.assembly !== null) state.applyAssembly({ ...state.assembly, namedViews: next });
    else state.applyDocument({ ...state.document, namedViews: next });
  }
  return { ok: true };
}
