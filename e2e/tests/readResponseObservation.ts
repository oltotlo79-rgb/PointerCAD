/// <reference lib="dom" />
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';

export const READ_OBSERVATION_COST = 'Includes native Worker wrapper, prefixed start/end BroadcastChannel messages, trusted keydown/input listeners, delegating command value accessor for reset observation and requestAnimationFrame callbacks. Electron observes the original app protocol net.fetch of the Worker asset. No wait, synthetic load, reply replacement or clock substitution. requestAnimationFrame is the paint opportunity marker, not a compositor presentation timestamp.';

/** A real output file survives successful runs whose trace is discarded. */
export async function writeReadEvidence(info: TestInfo, name: string, record: unknown): Promise<void> {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(record, null, 2));
  await info.attach(name, { contentType: 'application/json', path });
}

export async function readObservationSnapshot(page: Page) {
  return page.evaluate(() => {
    const audit = window.pcadReadObservation;
    return audit === undefined ? null : { spans: audit.spans, inputs: audit.inputs, workerUrls: audit.workerUrls,
      resets: audit.resets, sent: audit.sent, replied: audit.replied, terminated: audit.terminated };
  }).catch((error: unknown) => ({ unavailable: String(error) }));
}

export interface ReadSpan {
  readonly id: string;
  readonly start: number;
  end: number | null;
}
export interface ReadInput {
  readonly at: number;
  paintedAt: number | null;
  readonly trusted: boolean;
}
export interface ReadObservation {
  spans: ReadSpan[];
  inputs: ReadInput[];
  resets: { readId: string; at: number; beforeValue: string; value: string; order?: number }[];
  source: Uint8Array | null;
  borrowed: Uint8Array | null;
  orphan: Uint8Array | null;
  workerUrls: string[];
  sent: number;
  replied: number;
  terminated: number;
}
declare global { interface Window { pcadReadObservation?: ReadObservation } }

/**
 * Observation only: native Worker, exact original reader, arguments and transfer lists.
 * A separate channel carries actual Worker-thread entry/exit times. No delay, clock,
 * reader replacement, reply suppression or replacement. Integrity mode retains bytes;
 * never use that mode to measure peak memory.
 * Electron reads the unchanged app-scheme asset with its real net.fetch API.
 */
export async function observeRead(page: Page, integrity: boolean, app?: ElectronApplication) {
  const channel = `pcad-read-audit-${randomUUID()}`;
  let routed = 0;
  const sourceAssets: { url: string; sha256: string; bytes: number }[] = [];
  const prefix = `
const __pcadAudit = new BroadcastChannel(${JSON.stringify(channel)});
let __pcadReadId = '';
self.addEventListener('message', event => {
  if (event.data && typeof event.data.id === 'string') {
    __pcadReadId = event.data.id;
    __pcadAudit.postMessage({ phase: 'start', id: __pcadReadId, at: performance.timeOrigin + performance.now() });
  }
});
const __pcadNativePost = self.postMessage.bind(self);
self.postMessage = (...args) => {
  __pcadAudit.postMessage({ phase: 'end', id: __pcadReadId, at: performance.timeOrigin + performance.now() });
  return __pcadNativePost(...args);
};
`;
  if (app !== undefined) {
    app.on('console', message => {
      if (!message.text().startsWith(channel)) return;
      const value: unknown = JSON.parse(message.text().slice(channel.length));
      if (typeof value === 'object' && value !== null && 'url' in value && typeof value.url === 'string'
        && 'sha256' in value && typeof value.sha256 === 'string' && 'bytes' in value && typeof value.bytes === 'number') {
        sourceAssets.push({ url: value.url, sha256: value.sha256, bytes: value.bytes }); routed += 1;
      }
    });
    // Keep the actual registered app handler, its checks, headers and native file fetch.
    // page.route does not see this custom-scheme request (recorded routed=0).
    await app.evaluate(({ net }, { prefix, channel }) => {
      const fetch = net.fetch.bind(net);
      net.fetch = async (...args: Parameters<typeof net.fetch>) => {
        const response = await fetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;
        const parsed = new URL(url);
        if (parsed.protocol !== 'file:' || !parsed.pathname.includes('/assets/pcadRead.worker-')) return response;
        if (!response.ok) throw new Error(`Actual Worker asset unavailable: ${response.status}`);
        const body = await response.text(), bytes = new TextEncoder().encode(body);
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        console.debug(channel + JSON.stringify({ url, sha256, bytes: bytes.byteLength }));
        const headers = new Headers(response.headers); headers.delete('Content-Length');
        return new Response(prefix + body, { status: response.status, headers });
      };
    }, { prefix, channel });
  }
  if (app === undefined) await page.route('**/assets/pcadRead.worker-*.js', async route => {
    const url = route.request().url();
    const response = await route.fetch(), body = await response.text();
    sourceAssets.push({ url, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) });
    routed += 1;
    await route.fulfill({ response, body: prefix + body });
  });
  await page.evaluate(({ channel, integrity }) => {
    const observation: ReadObservation = { spans: [], inputs: [], resets: [], source: null, borrowed: null, orphan: null, workerUrls: [], sent: 0, replied: 0, terminated: 0 };
    window.pcadReadObservation = observation;
    let currentReadId: string | null = null;
    let eventOrder = 0;
    let keyStart: { at: number; paintedAt: number | null; trusted: boolean; readId: string | null;
      keydownObservedAt: number; inputObservedAt: number | null;
      keydownOrder: number; inputOrder: number | null; paintOrder: number | null;
      inputAt: number | null; beforeValue: string; expectedValue: string; value: string | null; paintedValue: string | null } | null = null;
    if (!integrity) {
      const command = document.getElementById('pcad-command-line-input');
      if (!(command instanceof HTMLInputElement)) throw new Error('Command input unavailable for reset observation');
      // Delegate to React's existing own accessor (including its value tracker).
      // Observe the actual UI reset; Worker end precedes the documentVersion effect.
      const descriptor = Object.getOwnPropertyDescriptor(command, 'value')
        ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      const get = descriptor?.get, set = descriptor?.set;
      if (get === undefined || set === undefined) throw new Error('Command value accessor unavailable');
      Object.defineProperty(command, 'value', { configurable: true, enumerable: descriptor?.enumerable,
        get: () => Reflect.apply(get, command, []),
        set: (value: string) => {
          const beforeValue = command.value;
          Reflect.apply(set, command, [value]);
          if (currentReadId !== null && value === '' && beforeValue !== ''
            && !observation.resets.some(reset => reset.readId === currentReadId)) {
            observation.resets.push({ readId: currentReadId, at: performance.timeOrigin + performance.now(), beforeValue, value: command.value, order: ++eventOrder });
          }
        },
      });
    }
    if (integrity) {
      const subarray = Uint8Array.prototype.subarray;
      Uint8Array.prototype.subarray = function(start?: number, end?: number) {
        // Observe the borrowed UI ZIP at the existing bounded-copy entrance.
        // The real subarray and the source object are returned unchanged.
        if (start === 0 && end === 1024 * 1024 && this[0] === 0x50 && this[1] === 0x4b) observation.borrowed = this;
        return subarray.call(this, start, end);
      };
    }
    const audit = new BroadcastChannel(channel);
    audit.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (typeof value !== 'object' || value === null || !('phase' in value) || !('id' in value)
        || typeof value.id !== 'string' || !('at' in value) || typeof value.at !== 'number') return;
      if (value.phase === 'start') observation.spans.push({ id: value.id, start: value.at, end: null });
      if (value.phase === 'end') {
        const span = observation.spans.find(span => span.id === value.id);
        if (span !== undefined) span.end = value.at;
      }
    };
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args: ConstructorParameters<typeof Worker>) {
        const worker = new target(...args);
        const url = String(args[0]);
        if (!url.includes('pcadRead.worker')) return worker;
        observation.workerUrls.push(url);
        const post = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
        Object.defineProperty(worker, 'postMessage', { value: (...values: Parameters<Worker['postMessage']>) => {
          observation.sent += 1;
          const request: unknown = values[0];
          currentReadId = typeof request === 'object' && request !== null && 'id' in request && typeof request.id === 'string' ? request.id : null;
          if (integrity && typeof request === 'object' && request !== null && 'bytes' in request && request.bytes instanceof Uint8Array) {
            // A copy is necessary because native postMessage detaches the owned input.
            observation.source = request.bytes.slice();
          }
          return Reflect.apply(post, worker, values);
        } });
        Object.defineProperty(worker, 'terminate', { value: () => { observation.terminated += 1; return terminate(); } });
        worker.addEventListener('message', (event: MessageEvent<unknown>) => {
          observation.replied += 1;
          const reply = event.data;
          if (!integrity || typeof reply !== 'object' || reply === null || !('result' in reply)) return;
          const result: unknown = reply.result;
          if (typeof result !== 'object' || result === null || !('attachments' in result)) return;
          const attachments: unknown = result.attachments;
          if (typeof attachments === 'object' && attachments !== null && 'canvases' in attachments && attachments.canvases instanceof Map) {
            const orphan: unknown = attachments.canvases.get('orphan');
            if (orphan instanceof Uint8Array) observation.orphan = orphan;
          }
        });
        return worker;
      },
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') currentReadId = null;
      if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'pcad-command-line-input' || event.key !== 'a') return;
      const target = event.target, beforeValue = target.value;
      keyStart = { at: performance.timeOrigin + event.timeStamp, trusted: event.isTrusted, readId: currentReadId,
        keydownObservedAt: performance.timeOrigin + performance.now(), inputObservedAt: null,
        keydownOrder: ++eventOrder, inputOrder: null, paintOrder: null,
        paintedAt: null, inputAt: null, beforeValue,
        expectedValue: beforeValue.slice(0, target.selectionStart ?? beforeValue.length) + event.key
          + beforeValue.slice(target.selectionEnd ?? beforeValue.length), value: null, paintedValue: null };
      // Count the key start even if the browser never delivers its input event.
      observation.inputs.push(keyStart);
    }, true);
    document.addEventListener('input', event => {
      if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'pcad-command-line-input') return;
      const target = event.target, input = keyStart;
      keyStart = null;
      if (input === null) return;
      input.trusted = input.trusted && event.isTrusted;
      input.inputAt = performance.timeOrigin + event.timeStamp;
      input.inputObservedAt = performance.timeOrigin + performance.now();
      input.inputOrder = ++eventOrder;
      // Capture the real value now: CommandLine.tsx resets it on document replacement.
      input.value = target.value;
      requestAnimationFrame(() => {
        input.paintedValue = target.value;
        input.paintedAt = performance.timeOrigin + performance.now();
        input.paintOrder = ++eventOrder;
      });
    }, true);
  }, { channel, integrity });
  return { routed: () => routed, sourceAssets };
}

/** Separate from wrapper terminate calls: require native Playwright Worker close events. */
export function nativeReadWorkers(page: Page) {
  const workers: { url: string; closed: boolean; closedAt: number | null }[] = [];
  page.on('worker', worker => {
    if (!worker.url().includes('pcadRead.worker')) return;
    const row = { url: worker.url(), closed: false, closedAt: null as number | null };
    workers.push(row);
    worker.on('close', () => { row.closed = true; row.closedAt = performance.now(); });
  });
  return workers;
}

export async function assertReadWorkerClosed(workers: ReturnType<typeof nativeReadWorkers>): Promise<void> {
  await expect.poll(() => workers.length > 0 && workers.every(worker => worker.closed)).toBe(true);
}
