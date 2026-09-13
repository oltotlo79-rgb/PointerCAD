import type { MathWorkerPort } from '@pointercad/expression/math/client';
import { createMathWorkerGroup } from './mathWorkerGroup.js';

type Group = ReturnType<typeof createMathWorkerGroup>;
interface Idle { readonly group: Group; readonly uses: number; readonly timer: ReturnType<typeof setTimeout> }

/** Retain at most one idle numerical Worker for the same document and kernel owner.
 * Requests still own their clients, immutable inputs, identities and termination deadlines.
 * No active group is ever lent twice, and an older document cannot repopulate the idle slot.
 */
export function createMathWorkerReuse(createWorker: () => MathWorkerPort): {
  acquire(documentId: string, owner: object): { readonly group: Group; readonly release: (reusable?: boolean) => void };
  clear(owner?: object): void;
} {
  let idle: Idle | null = null;
  let context: { readonly documentId: string; readonly owner: object } | null = null;
  function discardIdle(): void {
    const previous = idle; idle = null;
    if (previous !== null) { clearTimeout(previous.timer); previous.group.dispose(); }
  }
  return {
    acquire(documentId, owner) {
      if (context?.documentId !== documentId || context.owner !== owner) {
        discardIdle(); context = { documentId, owner };
      }
      const acquiredContext = context;
      const group = idle?.group ?? createMathWorkerGroup(createWorker);
      const uses = (idle?.uses ?? 0) + 1;
      if (idle !== null) { clearTimeout(idle.timer); idle = null; }
      let released = false;
      return { group, release(reusable = true) {
        if (released) return;
        released = true;
        // A continuous edit session must also release any internal engine caches.
        if (!reusable || uses >= 16 || context !== acquiredContext || idle !== null) { group.dispose(); return; }
        // This bounds retained resources; it never extends a calculation's deadline.
        const timer = setTimeout(() => {
          if (idle?.group === group) discardIdle();
        }, 30_000);
        idle = { group, uses, timer };
      } };
    },
    clear(owner) { if (owner === undefined || context?.owner === owner) { context = null; discardIdle(); } },
  };
}
