import { afterEach, describe, expect, it, vi } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, type FemRequest } from './protocol.js';
import { analyzeCadSolidContact } from './cadSolidContact.js';
import { contactFixture, zeroContactReply } from './solidContactBinding.testSupport.js';
import type { SolidContactResult } from './solidContactBinding.js';

function port() {
  const requests: FemRequest[] = [];
  const worker: FemWorkerPort & { terminations: number } = { terminations: 0,
    postMessage(request) { requests.push(request); }, terminate() { this.terminations++; }, onmessage: null, onerror: null, onmessageerror: null };
  return { worker, requests };
}
function reply(worker: FemWorkerPort, request: FemRequest, result: SolidContactResult): void {
  worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
}
afterEach(() => { vi.restoreAllMocks(); });

describe('solid contact uses the existing one-shot Worker lifetime', () => {
  it('returns an owned current input result and terminates exactly once', async () => {
    const { input } = await contactFixture(), { worker, requests } = port(), client = new FemClient(() => worker);
    try {
      const pending = client.analyzeSolidContact(input), request = requests[0];
      if (request.kind !== 'analyze-solid-contact') throw new Error('Missing contact request');
      expect(request.input).not.toBe(input); expect(request.input.nodes).not.toBe(input.nodes);
      const result = zeroContactReply(request.input);
      Reflect.set(input.material, 'youngMPa', 1);
      reply(worker, request, result);
      await expect(pending).resolves.toMatchObject({ kind: 'result', result });
      expect(worker.terminations).toBe(1); expect(worker.onmessage).toBeNull();
    } finally { client.dispose(); }
  });
  it.each(['abort', 'superseded', 'disposed'] as const)('never publishes a delayed old reply after %s', async reason => {
    const { input } = await contactFixture(), ports: ReturnType<typeof port>[] = [];
    const client = new FemClient(() => { const item = port(); ports.push(item); return item.worker; });
    const controller = new AbortController();
    try {
      const pending = client.analyzeSolidContact(input, { signal: controller.signal }), old = ports[0];
      const delayed = old.worker.onmessage;
      let second: ReturnType<FemClient['analyzeSolidContact']> | undefined;
      if (reason === 'abort') controller.abort();
      else if (reason === 'superseded') second = client.analyzeSolidContact(input);
      else client.dispose();
      delayed?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: old.requests[0].identity,
        result: zeroContactReply(input) } }));
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason });
      expect(old.worker.terminations).toBe(1);
      if (second !== undefined) { client.dispose(); await expect(second).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' }); expect(ports[1].worker.terminations).toBe(1); }
    } finally { client.dispose(); }
  });
  it('rejects another reply identity and terminates its owned Worker', async () => {
    const { input } = await contactFixture(), { worker, requests } = port(), client = new FemClient(() => worker);
    try {
      const pending = client.analyzeSolidContact(input), request = requests[0];
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
        identity: { ...request.identity, generation: request.identity.generation - 1 }, result: zeroContactReply(input) } }));
      await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
  it('returns no result when aborted during asynchronous result hash verification', async () => {
    const { input } = await contactFixture(), result = zeroContactReply(input), { worker, requests } = port();
    const client = new FemClient(() => worker), controller = new AbortController();
    const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let release: (() => void) | undefined;
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
      enteredResolve?.(); await gate; return original(algorithm, bytes);
    });
    try {
      const pending = client.analyzeSolidContact(input, { signal: controller.signal });
      reply(worker, requests[0], result);
      await entered;
      controller.abort(); release?.();
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      expect(worker.terminations).toBe(1); expect(worker.onmessage).toBeNull();
    } finally { release?.(); client.dispose(); }
  });
  it('refuses invalid input and supersedes a live prior request', async () => {
    const { input } = await contactFixture(), { worker } = port(), client = new FemClient(() => worker);
    try {
      const pending = client.analyzeSolidContact(input);
      await expect(client.analyzeSolidContact({})).rejects.toThrow();
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
  it('does not create a Worker for a pre-aborted valid request', async () => {
    const { input } = await contactFixture(), create = vi.fn(() => port().worker), client = new FemClient(create), controller = new AbortController();
    controller.abort();
    await expect(client.analyzeSolidContact(input, { signal: controller.signal })).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(create).not.toHaveBeenCalled(); client.dispose();
  });
  it('keeps valid bounded native failure detail separate from result', async () => {
    const { input } = await contactFixture(), { worker, requests } = port(), client = new FemClient(() => worker);
    const result = zeroContactReply(input);
    try {
      const pending = client.analyzeSolidContact(input);
      const contactDiagnostics = { schema: input.schema, source: input.source, inputSha256: result.inputSha256,
        preparationSha256: input.preparationSha256, step: 1, reason: 'native force check failed', iterationLimit: 50,
        nativeIterationCount: null, nativeCallbacks: { tangent: 2, residual: 3, evaluations: 5 }, rawBeforeFailure: '{"accepted":[]}', rawTruncated: false };
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'failure', identity: requests[0].identity,
        failure: { code: 'solver-failed', message: contactDiagnostics.reason, contactDiagnostics } } }));
      await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'solver-failed', contactDiagnostics } });
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
});

function publicationClient(solve: (input: unknown) => Promise<SolidContactResult>) {
  return new FemClient(() => {
    const { worker } = port();
    worker.postMessage = request => {
      if (request.kind !== 'analyze-solid-contact') throw new Error('Expected contact request');
      void solve(request.input).then(result => reply(worker, request, result));
    };
    return worker;
  });
}

describe('CAD publication rechecks current geometry after the solve', () => {
  it('publishes only the same current preparation after the client reply', async () => {
    const fixture = await contactFixture();
    const client = publicationClient((input: unknown) => new Promise<SolidContactResult>(resolve => {
      if (typeof input !== 'object' || input === null) throw new Error('Expected captured input');
      resolve(zeroContactReply(fixture.input));
    }));
    const outcome = await analyzeCadSolidContact(client, fixture.saved, () => fixture.bodies, fixture.settings, .01);
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') expect(outcome.prepared.preparationSha256).toBe(fixture.prepared.preparationSha256);
  });
  it.each(['revision', 'bodyKey', 'mesh'] as const)('refuses changed %s even if the client replied successfully', async change => {
    const fixture = await contactFixture();
    const client = publicationClient(() => new Promise<SolidContactResult>(resolve => {
      if (change === 'revision') Reflect.set(fixture.bodies[0].context, 'revision', 2);
      else if (change === 'bodyKey') Reflect.set(fixture.bodies[0].context.steps[0], 'key', 'changed');
      else Reflect.set(fixture.bodies[0].mesh.coordinates, 0, -1);
      resolve(zeroContactReply(fixture.input));
    }));
    const outcome = await analyzeCadSolidContact(client, fixture.saved, () => fixture.bodies, fixture.settings, .01);
    expect(outcome.kind).toBe('failed');
  });
  it('discards a CAD result cancelled by the caller while the solve is pending', async () => {
    const fixture = await contactFixture(), controller = new AbortController();
    const client = publicationClient(() => new Promise<SolidContactResult>(resolve => {
      controller.abort();
      resolve(zeroContactReply(fixture.input));
    }));
    await expect(analyzeCadSolidContact(client, fixture.saved, () => fixture.bodies, fixture.settings, .01, { signal: controller.signal }))
      .resolves.toEqual({ kind: 'cancelled', reason: 'abort' });
  });
});
