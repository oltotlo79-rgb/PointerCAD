/** An attachment owns cleanup until every operation has returned successfully. */
export interface ViewportLifetime {
  readonly active: boolean;
  readonly pendingCount: number;
  readonly errors: readonly string[];
  register(label: string, release: () => void): void;
  dispose(): void;
}

interface Cleanup {
  readonly label: string;
  readonly release: () => void;
}

/** Only actual returned resources are carried across a failed factory call. */
export class ViewportResourceInitializationFailure extends Error {
  constructor(readonly originalError: unknown, readonly cleanup: ViewportLifetime) {
    super('Viewport resource initialization failed', { cause: originalError });
    this.name = 'ViewportResourceInitializationFailure';
  }
}

export function createViewportConstructionOwner() {
  const releases = new Map<object, Cleanup>();
  let handedOff = false;
  return {
    acquire<T extends object>(label: string, resource: T, release: () => void): T {
      if (handedOff) throw new Error('Construction ownership has already transferred');
      if (releases.has(resource)) throw new Error('Construction resource is already owned');
      releases.set(resource, { label, release });
      return resource;
    },
    handoff(receiver?: (resource: object, label: string, release: () => void) => void): void {
      if (receiver !== undefined) {
        for (const [resource, operation] of releases) receiver(resource, operation.label, operation.release);
      }
      releases.clear(); handedOff = true;
    },
    fail(error: unknown): ViewportResourceInitializationFailure {
      const cleanup = createViewportLifetime();
      for (const operation of releases.values()) cleanup.register(operation.label, operation.release);
      if (error instanceof ViewportResourceInitializationFailure && error.cleanup.pendingCount !== 0) {
        cleanup.register('nested initialization resources', () => {
          error.cleanup.dispose();
          if (error.cleanup.pendingCount !== 0) throw new Error(error.cleanup.errors.join('; '));
        });
      }
      releases.clear(); handedOff = true;
      cleanup.dispose();
      return new ViewportResourceInitializationFailure(error, cleanup);
    },
  };
}

function describeFailure(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return 'Unknown cleanup failure'; }
}

/**
 * Cleanup order is registration order. A failure retains only its operation for
 * the next disposal; every independent operation is still attempted. Callers
 * retain their resource reservations while pendingCount is nonzero.
 */
export function createViewportLifetime(): ViewportLifetime {
  let active = true;
  let releasing = false;
  let pending: Cleanup[] = [];
  let errors: readonly string[] = [];
  return {
    get active(): boolean { return active; },
    get pendingCount(): number { return pending.length; },
    get errors(): readonly string[] { return errors; },
    register(label, release): void {
      if (!active) throw new Error('Cannot register resources on a disposed viewport owner.');
      pending.push({ label, release });
    },
    dispose(): void {
      active = false;
      if (releasing) return;
      releasing = true;
      const failed: Cleanup[] = [];
      const nextErrors: string[] = [];
      try {
        for (const cleanup of pending) {
          try { cleanup.release(); }
          catch (error) {
            failed.push(cleanup);
            nextErrors.push(`${cleanup.label}: ${describeFailure(error)}`);
          }
        }
      } finally {
        pending = failed;
        errors = Object.freeze(nextErrors);
        releasing = false;
      }
    },
  };
}

/** Candidate only. Application-held ownership outlives one React cleanup call. */
export interface PendingViewportReading {
  readonly viewportOwnerId: string;
  readonly pendingCount: number;
  readonly errors: readonly string[];
  readonly hostDisplayCopyBytes: number | null;
  readonly hostGpuAttributeBytes: number | null;
  readonly unknown: readonly string[];
  readonly observationActive: boolean;
}

interface RetiredViewport {
  readonly retry: () => boolean;
  readonly read: () => PendingViewportReading;
}

export function createViewportCleanupQueue(
  schedule: (retry: () => void, delayMs: number) => () => void,
) {
  const retired = new Map<string, RetiredViewport>();
  const owners = new Set<string>();
  const waiting = new Map<string, () => void>();
  let cancelScheduled: (() => void) | null = null;
  let retrying = false;
  let delayMs = 250;

  function drainWaiters(): void {
    if (retrying || retired.size !== 0) return;
    cancelScheduled?.(); cancelScheduled = null; delayMs = 250;
    for (const [ownerId, callback] of [...waiting]) {
      if (retired.size !== 0 || owners.size >= 16) break;
      waiting.delete(ownerId); owners.add(ownerId);
      callback();
    }
  }

  function scheduleRetry(): void {
    if (retrying || retired.size === 0 || cancelScheduled !== null) return;
    cancelScheduled = schedule(retry, delayMs);
  }

  function retry(): void {
    cancelScheduled = null; retrying = true;
    try {
      for (const [ownerId, owner] of [...retired]) {
        try { if (owner.retry()) { retired.delete(ownerId); owners.delete(ownerId); } }
        catch { /* Preserve the owner and unknown reading until an actual successful retry. */ }
      }
    } finally {
      retrying = false;
      delayMs = Math.min(4000, delayMs * 2);
      drainWaiters(); scheduleRetry();
    }
  }

  return {
    retain(ownerId: string, owner: RetiredViewport): void {
      if (!owners.has(ownerId)) throw new Error('Viewport owner was not admitted');
      retired.set(ownerId, owner); scheduleRetry();
    },
    returned(ownerId: string): void {
      retired.delete(ownerId); owners.delete(ownerId); drainWaiters();
    },
    whenAvailable(ownerId: string, callback: () => void): () => void {
      if (retired.size === 0 && owners.size < 16) { owners.add(ownerId); callback(); }
      else if (waiting.size < 16) waiting.set(ownerId, callback);
      else throw new Error('Viewport cleanup wait capacity exceeded');
      return () => { waiting.delete(ownerId); };
    },
    get pendingCount(): number { return retired.size; },
    get ownerCount(): number { return owners.size; },
    get waitingCount(): number { return waiting.size; },
    get scheduled(): boolean { return cancelScheduled !== null; },
    retryNow(): void { cancelScheduled?.(); cancelScheduled = null; retry(); },
    snapshot(): readonly PendingViewportReading[] {
      return Object.freeze([...retired].map(([viewportOwnerId, owner]) => {
        try {
          const value = owner.read();
          return Object.freeze({ viewportOwnerId, pendingCount: value.pendingCount,
            errors: Object.freeze([...value.errors]), hostDisplayCopyBytes: value.hostDisplayCopyBytes,
            hostGpuAttributeBytes: value.hostGpuAttributeBytes, unknown: Object.freeze([...value.unknown]),
            observationActive: value.observationActive });
        } catch {
          return Object.freeze({ viewportOwnerId, pendingCount: 1,
            errors: Object.freeze(['Unknown cleanup reading']), hostDisplayCopyBytes: null,
            hostGpuAttributeBytes: null, unknown: Object.freeze(['retiredViewportResources']), observationActive: true });
        }
      }));
    },
  };
}
