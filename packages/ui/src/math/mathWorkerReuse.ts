import type { MathWorkerPort } from '@pointercad/expression/math/client';
import { createMathWorkerGroup } from './mathWorkerGroup.js';

type Group = ReturnType<typeof createMathWorkerGroup>;
interface Idle { readonly group: Group; readonly uses: number; readonly timer: ReturnType<typeof setTimeout> | null }
interface EditorIdle extends Idle { readonly documentId: string }
/** One exclusive loan of a Worker group; `release` returns it to its idle slot when it may be reused. */
export interface MathWorkerLease { readonly group: Group; readonly release: (reusable?: boolean) => void }
/** Idle time after which a retained Worker is released while no math editor holds it. */
export const MATH_WORKER_IDLE_MS = 30_000;
/** Loans of one retained group before it is released with its internal caches. */
const MAXIMUM_USES = 16;

/** Retain at most one idle numerical Worker for the same document and kernel owner.
 * Requests still own their clients, immutable inputs, identities and termination deadlines.
 * No active group is ever lent twice, and an older document cannot repopulate the idle slot.
 * While a math editor is open (`hold`), the idle Worker is not released by time: applying the edit
 * recomputes next, and the editor's own preparation can outlast the idle time (Firefox 65 s,
 * 2026-09-27), which made that recomputation prepare the exact runtime again. The idle time restarts
 * when the last editor closes; document or owner changes and the 16-use limit still release it.
 *
 * Math editors have a separate slot (`acquireEditor`). Every opening of an editor used to create and
 * prepare its own Worker (Chromium 16.7 s, Firefox 65 s, 2026-09-27) and to terminate it on closing.
 * The Worker of a closed editor is now kept for the next editor of the same document under the same
 * limits (document change, idle time, use limit, full clear). A Worker whose request was cancelled,
 * timed out or retired has already been terminated by its group and is never returned. The
 * recomputation slot is never lent to an editor, so the recomputation that follows an applied edit
 * keeps its own prepared Worker. A recomputation without a prepared Worker of its own takes over a
 * closed editor's prepared one (2026-09-27: after an edit whose values were remembered, the next
 * recomputation prepared the exact runtime again while the editor's Worker waited unused).
 */
export function createMathWorkerReuse(createWorker: () => MathWorkerPort): {
  acquire(documentId: string, owner: object): MathWorkerLease;
  acquireEditor(documentId: string): MathWorkerLease;
  clear(owner?: object): void;
  hold(): () => void;
} {
  let idle: Idle | null = null, editor: EditorIdle | null = null, holds = 0;
  let context: { readonly documentId: string; readonly owner: object } | null = null;
  function discardIdle(): void {
    const previous = idle; idle = null;
    if (previous !== null) { if (previous.timer !== null) clearTimeout(previous.timer); previous.group.dispose(); }
  }
  function discardEditor(): void {
    const previous = editor; editor = null;
    if (previous !== null) { if (previous.timer !== null) clearTimeout(previous.timer); previous.group.dispose(); }
  }
  // This bounds retained resources; it never extends a calculation's deadline.
  function expire(group: Group): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (idle?.group === group) discardIdle();
      if (editor?.group === group) discardEditor();
    }, MATH_WORKER_IDLE_MS);
  }
  return {
    acquire(documentId, owner) {
      if (context?.documentId !== documentId || context.owner !== owner) {
        discardIdle(); context = { documentId, owner };
      }
      if (editor !== null && editor.documentId !== documentId) discardEditor();
      const acquiredContext = context;
      // Without a prepared Worker of its own, a recomputation takes over a closed editor's prepared one.
      if ((idle === null || !idle.group.hasWorker) && editor !== null && editor.group.hasWorker) {
        discardIdle(); idle = editor; editor = null;
      }
      const group = idle?.group ?? createMathWorkerGroup(createWorker);
      const uses = (idle?.uses ?? 0) + 1;
      if (idle !== null) { if (idle.timer !== null) clearTimeout(idle.timer); idle = null; }
      let released = false;
      return { group, release(reusable = true) {
        if (released) return;
        released = true;
        // A continuous edit session must also release any internal engine caches.
        if (!reusable || uses >= MAXIMUM_USES || context !== acquiredContext) { group.dispose(); return; }
        // Keep the prepared one of two idle groups; a group that never started a Worker costs nothing.
        if (idle !== null) {
          if (!group.hasWorker || idle.group.hasWorker) { group.dispose(); return; }
          discardIdle();
        }
        idle = { group, uses, timer: holds > 0 ? null : expire(group) };
      } };
    },
    acquireEditor(documentId) {
      if (editor !== null && editor.documentId !== documentId) discardEditor();
      const retained = editor; editor = null;
      if (retained !== null && retained.timer !== null) clearTimeout(retained.timer);
      const group = retained?.group ?? createMathWorkerGroup(createWorker);
      const uses = (retained?.uses ?? 0) + 1;
      let released = false;
      return { group, release(reusable = true) {
        if (released) return;
        released = true;
        // Only a live Worker is worth keeping; a cancelled, timed-out or retired one is already terminated.
        if (!reusable || uses >= MAXIMUM_USES || !group.hasWorker || editor !== null
          || (context !== null && context.documentId !== documentId)) { group.dispose(); return; }
        editor = { group, uses, documentId, timer: holds > 0 ? null : expire(group) };
      } };
    },
    // An owner's end or a recomputation without mathematics releases the recomputation slot only; the
    // editor slot has no kernel owner and is bounded by its document, idle time and use limit.
    clear(owner) {
      if (owner === undefined || context?.owner === owner) { context = null; discardIdle(); }
      if (owner === undefined) discardEditor();
    },
    hold() {
      holds += 1;
      if (idle !== null && idle.timer !== null) { clearTimeout(idle.timer); idle = { ...idle, timer: null }; }
      if (editor !== null && editor.timer !== null) { clearTimeout(editor.timer); editor = { ...editor, timer: null }; }
      let held = true;
      return () => {
        if (!held) return;
        held = false; holds -= 1;
        if (holds > 0) return;
        if (idle !== null && idle.timer === null) idle = { ...idle, timer: expire(idle.group) };
        if (editor !== null && editor.timer === null) editor = { ...editor, timer: expire(editor.group) };
      };
    },
  };
}
