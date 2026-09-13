import type { Page, TestInfo } from '@playwright/test';

/** Observe transport only: never replace an envelope, result, deadline or cancellation. */
function install(): void {
  const post = Worker.prototype.postMessage, terminate = Worker.prototype.terminate;
  const workers = new WeakMap<Worker, { id: number; pending: Map<number, { kind: string; at: number }> }>();
  let serial = 0;
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  const record = (value: object): void => console.debug('[pcad:math-transport]', JSON.stringify({ timeOrigin: performance.timeOrigin, ...value }));
  Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
    const value = object(args[0]);
    if (typeof value?.kind === 'string' && typeof value.serial === 'number') {
      let state = workers.get(this);
      if (state === undefined) {
        state = { id: ++serial, pending: new Map() }; workers.set(this, state);
        const current = state;
        this.addEventListener('message', event => {
          const reply = object(event.data), result = object(reply?.result ?? reply?.evaluation);
          const pending = typeof reply?.serial === 'number' ? current.pending.get(reply.serial) : undefined;
          record({ event: 'reply', worker: current.id, serial: reply?.serial, kind: reply?.kind,
            elapsedMs: pending === undefined ? null : performance.now() - pending.at,
            status: result?.status, reason: result?.reason, detail: result?.detail });
          if (typeof reply?.serial === 'number') current.pending.delete(reply.serial);
        }, { capture: true });
        this.addEventListener('error', event => record({ event: 'error', worker: current.id, message: event.message }));
        this.addEventListener('messageerror', () => record({ event: 'messageerror', worker: current.id }));
      }
      state.pending.set(value.serial, { kind: value.kind, at: performance.now() });
      record({ event: 'request', worker: state.id, serial: value.serial, kind: value.kind });
    }
    Reflect.apply(post, this, args);
  };
  Worker.prototype.terminate = function (this: Worker): void {
    const state = workers.get(this);
    if (state !== undefined) record({ event: 'terminate', worker: state.id,
      pending: [...state.pending].map(([serial, value]) => ({ serial, kind: value.kind, elapsedMs: performance.now() - value.at })) });
    Reflect.apply(terminate, this, []);
  };
}

export async function observeMathWorkers(page: Page): Promise<(info: TestInfo) => Promise<void>> {
  const records: { at: number; text: string }[] = [];
  const listen = (message: { text(): string }): void => {
    if (message.text().startsWith('[pcad:math-')) {
      records.push({ at: Date.now(), text: message.text() });
      if (records.length > 200) records.shift();
    }
  };
  page.on('console', listen);
  await page.addInitScript(install);
  await page.evaluate(install);
  return async info => {
    page.off('console', listen);
    await info.attach('math-worker-transport', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
    console.log(`[数学Worker診断] ${JSON.stringify(records)}`);
  };
}
