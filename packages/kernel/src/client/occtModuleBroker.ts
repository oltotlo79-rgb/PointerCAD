import { compileVerifiedOcctResponse, type VerifiedOcctResponse } from '../occt/compiledOcctModule.js';

type VerifiedLoader = (signal: AbortSignal) => Promise<VerifiedOcctResponse | undefined>;
type Compiler = (verified: VerifiedOcctResponse) => Promise<WebAssembly.Module>;

// Bound shared HTTP/verification, not the non-abortable verified compilation.
const SHARED_FETCH_TIMEOUT_MS = 150_000;

async function loadVerifiedInBrowser(signal: AbortSignal): Promise<VerifiedOcctResponse | undefined> {
  // This module is imported by Node's direct bridge tests too. Keep Vite's
  // browser-only ?url assets behind the first real parent request.
  const { fetchVerifiedOcctForBroker } = await import('../occt/loadOcct.browser.js');
  return fetchVerifiedOcctForBroker(signal);
}

export interface OcctBrokerObservation {
  readonly phase: string;
  readonly atEpochMs: number;
  readonly elapsedMs: number;
  readonly generation?: number;
  readonly sha256?: string;
  readonly byteLength?: number;
}

function observeBrowser(event: OcctBrokerObservation): void {
  if (import.meta.env?.VITE_PCAD_E2E === '1') console.debug('[pcad:occt-broker]', JSON.stringify(event));
}

interface Lease {
  readonly generation: number;
  readonly port: MessagePort;
  closed: boolean;
  requested: boolean;
  requestId: number;
}

/** Only this parent owns the HTTP verification and the resulting compile promise. */
export class OcctModuleBroker {
  private readonly leases = new Set<Lease>();
  private generation = 0;
  private shared: Promise<WebAssembly.Module | undefined> | undefined;
  private sharedReady = false;
  private controller: AbortController | undefined;
  private eviction: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly loadVerified: VerifiedLoader = loadVerifiedInBrowser,
    private readonly compile: Compiler = compileVerifiedOcctResponse,
    private readonly retentionMs = 30_000,
    private readonly observer: (event: OcctBrokerObservation) => void = observeBrowser,
  ) {}

  private readonly started = performance.now();

  private observe(phase: string, detail: Pick<OcctBrokerObservation, 'generation' | 'sha256' | 'byteLength'> = {}): void {
    try { this.observer({ phase, atEpochMs: Date.now(), elapsedMs: performance.now() - this.started, ...detail }); }
    catch { /* Diagnostics must not change lease ownership or initialization. */ }
  }

  attach(worker: Worker): () => void {
    if (typeof MessageChannel !== 'function') return () => undefined;
    if (this.eviction !== undefined) clearTimeout(this.eviction);
    this.eviction = undefined;
    const channel = new MessageChannel();
    const lease: Lease = {
      generation: ++this.generation,
      port: channel.port1,
      closed: false,
      requested: false,
      requestId: 0,
    };
    const close = (): void => {
      if (lease.closed) return;
      lease.closed = true;
      this.leases.delete(lease);
      this.observe('lease-close', { generation: lease.generation });
      try { lease.port.postMessage({ kind: 'occt-module-close', generation: lease.generation }); } catch { /* Worker already gone. */ }
      lease.port.close();
      if (this.leases.size === 0) {
        if (this.sharedReady) {
          this.eviction = setTimeout(() => this.dropShared(), this.retentionMs);
        } else {
          this.dropShared();
        }
      }
    };
    this.leases.add(lease);
    this.observe('lease-open', { generation: lease.generation });
    lease.port.onmessage = (event: MessageEvent<unknown>): void => {
      const message = event.data;
      if (lease.closed || typeof message !== 'object' || message === null ||
          !('kind' in message) || !('generation' in message) ||
          message.generation !== lease.generation) return;
      if (message.kind === 'occt-module-close') {
        close();
        return;
      }
      if (message.kind === 'occt-module-invalidate') {
        if (lease.requested && 'requestId' in message && message.requestId === lease.requestId) lease.requested = false;
        return;
      }
      if (lease.requested || message.kind !== 'occt-module-ready') return;
      if (!('requestId' in message) || typeof message.requestId !== 'number'
        || !Number.isSafeInteger(message.requestId) || message.requestId !== lease.requestId + 1) return;
      lease.requestId = message.requestId;
      lease.requested = true;
      void this.deliver(lease);
    };
    lease.port.onmessageerror = close;
    lease.port.start();
    try {
      worker.postMessage({ kind: 'occt-module-bootstrap', generation: lease.generation }, [channel.port2]);
    } catch {
      channel.port2.close();
      close();
    }
    return close;
  }

  private getShared(): Promise<WebAssembly.Module | undefined> {
    if (this.shared !== undefined) { this.observe('shared-hit'); return this.shared; }
    this.observe('fetch-verify-start');
    const controller = new AbortController();
    this.controller = controller;
    const promise: Promise<WebAssembly.Module | undefined> = this.loadBeforeDeadline(controller).then(async (verified) => {
      if (verified === undefined) { this.observe('fallback'); return undefined; }
      const identity = { sha256: verified.sha256, byteLength: verified.byteLength };
      this.observe('verified', identity);
      this.observe('compile-start', identity);
      const module = await this.compile(verified);
      this.observe('compile-end', identity);
      if (controller.signal.aborted) throw new DOMException('OCCT compile was closed', 'AbortError');
      if (this.shared === promise) this.sharedReady = true;
      return module;
    }).catch((error: unknown) => {
      if (this.shared === promise) {
        this.shared = undefined;
        this.controller = undefined;
        this.sharedReady = false;
      }
      throw error;
    });
    this.shared = promise;
    return promise;
  }

  private loadBeforeDeadline(controller: AbortController): Promise<VerifiedOcctResponse | undefined> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', aborted);
      };
      const aborted = (): void => {
        if (settled) return;
        cleanup();
        reject(new DOMException('OCCT shared fetch was aborted or exceeded 150 seconds', 'AbortError'));
      };
      const timer = setTimeout(() => controller.abort(), SHARED_FETCH_TIMEOUT_MS);
      controller.signal.addEventListener('abort', aborted, { once: true });
      if (controller.signal.aborted) { aborted(); return; }
      // Consume both late outcomes even when a loader ignores AbortSignal.
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new DOMException('OCCT shared fetch was closed', 'AbortError');
        return this.loadVerified(controller.signal);
      }).then(verified => {
        if (settled) return;
        cleanup();
        resolve(verified);
      }, (error: unknown) => {
        if (settled) return;
        cleanup();
        reject(error instanceof Error ? error : new Error('OCCT shared fetch failed', { cause: error }));
      });
    });
  }

  private async deliver(lease: Lease): Promise<void> {
    const requestId = lease.requestId;
    try {
      const module = await this.getShared();
      if (lease.closed || !lease.requested || lease.requestId !== requestId) return;
      if (module === undefined) {
        lease.port.postMessage({ kind: 'occt-module-fallback', generation: lease.generation, requestId });
        return;
      }
      try {
        lease.port.postMessage({ kind: 'occt-module-value', generation: lease.generation, requestId, module });
        this.observe('module-delivered', { generation: lease.generation });
      } catch {
        // Module structured cloning is optional. The Worker reuses its verified HTTP path.
        if (!lease.closed) lease.port.postMessage({ kind: 'occt-module-fallback', generation: lease.generation, requestId });
      }
    } catch (error) {
      if (lease.closed || !lease.requested || lease.requestId !== requestId) return;
      lease.requested = false;
      const message = error instanceof Error ? error.message : String(error);
      try { lease.port.postMessage({ kind: 'occt-module-failed', generation: lease.generation, requestId, message }); }
      catch { /* The connection is already broken. */ }
    }
  }

  private dropShared(): void {
    if (this.eviction !== undefined) clearTimeout(this.eviction);
    this.eviction = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.shared = undefined;
    this.sharedReady = false;
  }
}

const broker = new OcctModuleBroker();
const closes = new WeakMap<Worker, () => void>();

export function attachOcctModuleBroker(worker: Worker): void {
  if (closes.has(worker)) throw new Error('OCCT broker bootstrap is already attached.');
  closes.set(worker, broker.attach(worker));
}

export function closeOcctModuleBroker(worker: Worker): void {
  closes.get(worker)?.();
  closes.delete(worker);
}
