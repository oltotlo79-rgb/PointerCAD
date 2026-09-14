import type { MathWorkerPort } from '@pointercad/expression/math/client';

interface Work { readonly port: MathWorkerPort; readonly value: unknown }

/** One calculation owns one Worker; clients retain separate validation, identities and deadlines. */
export function createMathWorkerGroup(createWorker: () => MathWorkerPort): {
  readonly createPort: () => MathWorkerPort;
  readonly dispose: () => void;
} {
  const ports = new Set<MathWorkerPort>(), queue: Work[] = [];
  let worker: MathWorkerPort | null = null, active: Work | null = null;
  let disposed = false, dispatching = false;
  function stop(): void {
    const old = worker; worker = null;
    if (old !== null) { old.onmessage = null; old.onerror = null; old.onmessageerror = null; old.terminate(); }
  }
  function pump(): void {
    if (disposed || dispatching || active !== null) return;
    const work = queue.shift();
    if (work === undefined) return;
    active = work;
    try {
      if (worker === null) {
        const current = createWorker(); worker = current;
        current.onmessage = event => dispatch(current, port => port.onmessage?.(event));
        current.onerror = event => dispatch(current, port => port.onerror?.(event));
        current.onmessageerror = () => dispatch(current, port => port.onmessageerror?.());
      }
      worker.postMessage(work.value);
    } catch {
      stop();
      if (active === work) {
        dispatching = true;
        try { work.port.onerror?.({ preventDefault: () => undefined }); }
        finally { dispatching = false; if (active === work) active = null; }
      }
      pump();
    }
  }
  function dispatch(source: MathWorkerPort, deliver: (port: MathWorkerPort) => void): void {
    if (source !== worker || active === null) return;
    const work = active;
    // A decoder rejecting this reply terminates its still-active port, discarding the Worker.
    dispatching = true;
    try { deliver(work.port); }
    finally {
      dispatching = false;
      if (active === work) active = null;
      pump();
    }
  }
  function createPort(): MathWorkerPort {
    if (disposed) throw new Error('Calculation Worker is closed');
    if (ports.size >= 16) throw new RangeError('Too many recomputation Worker clients');
    const port: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
      get startupTimeoutMs() { return worker?.startupTimeoutMs ?? 0; },
      postMessage(value) {
        if (!ports.has(port)) throw new Error('Calculation Worker client is closed');
        if ((active?.port === port && !dispatching) || queue.some(work => work.port === port)) throw new Error('Client already has pending work');
        queue.push({ port, value }); pump();
      },
      terminate() {
        if (!ports.delete(port)) return;
        for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index].port === port) queue.splice(index, 1);
        if (active?.port === port) { active = null; stop(); }
        port.onmessage = null; port.onerror = null; port.onmessageerror = null;
        pump();
      },
    };
    ports.add(port); return port;
  }
  return { createPort, dispose() {
    if (disposed) return;
    disposed = true;
    for (const port of [...ports]) port.terminate();
    queue.length = 0; active = null; stop();
  } };
}
