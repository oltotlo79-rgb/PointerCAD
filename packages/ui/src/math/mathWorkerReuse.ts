import type { MathWorkerPort } from '@pointercad/expression/math/client';
import { createMathWorkerGroup } from './mathWorkerGroup.js';

type Group = ReturnType<typeof createMathWorkerGroup>;
interface Idle { readonly group: Group; readonly uses: number; readonly timer: ReturnType<typeof setTimeout> | null }
/** Idle time after which a retained Worker is released while no math editor holds it. */
export const MATH_WORKER_IDLE_MS = 30_000;

/** Retain at most one idle numerical Worker for the same document and kernel owner.
 * Requests still own their clients, immutable inputs, identities and termination deadlines.
 * No active group is ever lent twice, and an older document cannot repopulate the idle slot.
 * While a math editor is open (`hold`), the idle Worker is not released by time: applying the edit
 * recomputes next, and the editor's own preparation can outlast the idle time (Firefox 65 s,
 * 2026-09-27), which made that recomputation prepare the exact runtime again. The idle time restarts
 * when the last editor closes; document or owner changes and the 16-use limit still release it.
 */
export function createMathWorkerReuse(createWorker: () => MathWorkerPort): {
  acquire(documentId: string, owner: object): { readonly group: Group; readonly release: (reusable?: boolean) => void };
  clear(owner?: object): void;
  hold(): () => void;
} {
  let idle: Idle | null = null, holds = 0;
  let context: { readonly documentId: string; readonly owner: object } | null = null;
  function discardIdle(): void {
    const previous = idle; idle = null;
    if (previous !== null) { if (previous.timer !== null) clearTimeout(previous.timer); previous.group.dispose(); }
  }
  // This bounds retained resources; it never extends a calculation's deadline.
  function expire(group: Group): ReturnType<typeof setTimeout> {
    return setTimeout(() => { if (idle?.group === group) discardIdle(); }, MATH_WORKER_IDLE_MS);
  }
  return {
    acquire(documentId, owner) {
      if (context?.documentId !== documentId || context.owner !== owner) {
        discardIdle(); context = { documentId, owner };
      }
      const acquiredContext = context;
      const group = idle?.group ?? createMathWorkerGroup(createWorker);
      const uses = (idle?.uses ?? 0) + 1;
      if (idle !== null) { if (idle.timer !== null) clearTimeout(idle.timer); idle = null; }
      let released = false;
      return { group, release(reusable = true) {
        if (released) return;
        released = true;
        // A continuous edit session must also release any internal engine caches.
        if (!reusable || uses >= 16 || context !== acquiredContext || idle !== null) { group.dispose(); return; }
        idle = { group, uses, timer: holds > 0 ? null : expire(group) };
      } };
    },
    clear(owner) { if (owner === undefined || context?.owner === owner) { context = null; discardIdle(); } },
    hold() {
      holds += 1;
      if (idle !== null && idle.timer !== null) { clearTimeout(idle.timer); idle = { ...idle, timer: null }; }
      let held = true;
      return () => {
        if (!held) return;
        held = false; holds -= 1;
        if (holds === 0 && idle !== null && idle.timer === null) idle = { ...idle, timer: expire(idle.group) };
      };
    },
  };
}
