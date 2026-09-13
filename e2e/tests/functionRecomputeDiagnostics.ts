import type { Page, TestInfo } from '@playwright/test';

interface FunctionKernelDiagnostic {
  readonly event: 'request' | 'reply';
  readonly elapsedMs: number;
  readonly details: unknown;
}

declare global {
  interface Window {
    pcadFunctionKernelDiagnostics?: FunctionKernelDiagnostic[];
  }
}

/** Observe real Worker traffic without replacing requests, responses, or application state. */
function install(): void {
  if (window.pcadFunctionKernelDiagnostics !== undefined) return;
  const records: FunctionKernelDiagnostic[] = [];
  window.pcadFunctionKernelDiagnostics = records;
  const original = Worker.prototype.postMessage;
  const pending = new WeakMap<Worker, Map<string, number>>();
  const previousKeys = new WeakMap<Worker, readonly string[]>();
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const record = (value: FunctionKernelDiagnostic): void => {
    records.push(value);
    if (records.length > 30) records.shift();
  };
  Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
    const message = object(args[0]);
    if (message?.type === 'APPLY' && Array.isArray(message.path) && message.path.includes('recomputeSolids')
      && Array.isArray(message.argumentList) && typeof message.id === 'string') {
      let calls = pending.get(this);
      if (calls === undefined) {
        calls = new Map();
        pending.set(this, calls);
        const currentCalls = calls;
        this.addEventListener('message', event => {
          const response = object(event.data);
          if (typeof response?.id !== 'string') return;
          const started = currentCalls.get(response.id);
          if (started === undefined) return;
          currentCalls.delete(response.id);
          const value = object(response.value);
          record({ event: 'reply', elapsedMs: performance.now() - started,
            details: { cacheHits: value?.cacheHits, cancelled: value?.cancelled, type: response.type,
              bodyCount: Array.isArray(value?.bodies) ? value.bodies.length : undefined } });
        });
      }
      calls.set(message.id, performance.now());
      const request = object(object(message.argumentList[0])?.value);
      const steps = Array.isArray(request?.steps) ? request.steps.map(object) : [];
      const keys = steps.map(step => typeof step?.key === 'string' ? step.key : '');
      const previous = previousKeys.get(this);
      record({ event: 'request', elapsedMs: 0, details: {
        generation: request?.generation, partId: request?.partId, stepCount: steps.length,
        sameKeys: previous !== undefined && previous.length === keys.length && keys.every((key, index) => key === previous[index]),
        steps: steps.map(step => {
          const geometry = object(object(step?.step)?.geometry);
          return { kind: object(step?.step)?.kind,
            vertices: Array.isArray(geometry?.vertices) ? geometry.vertices.length : undefined,
            triangles: Array.isArray(geometry?.triangles) ? geometry.triangles.length : undefined };
        }),
      } });
      previousKeys.set(this, keys);
    }
    Reflect.apply(original, this, args);
  };
}

const phaseRecords = new WeakMap<Page, string[]>();

export async function observeFunctionRecompute(page: Page): Promise<void> {
  const phases: string[] = []; phaseRecords.set(page, phases);
  page.on('console', message => {
    if (message.text().startsWith('[pcad:function-phase]')) {
      phases.push(message.text()); if (phases.length > 100) phases.shift();
    }
  });
  await page.addInitScript(install);
  await page.evaluate(install);
}

export async function attachFunctionRecomputeDiagnostics(page: Page, info: TestInfo): Promise<void> {
  const records = await page.evaluate(() => window.pcadFunctionKernelDiagnostics ?? []);
  await info.attach('function-kernel-requests', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
  console.log(`[関数再計算診断] ${JSON.stringify(records)}`);
  const phases = phaseRecords.get(page) ?? [];
  await info.attach('function-kernel-phases', { body: JSON.stringify(phases, null, 2), contentType: 'application/json' });
  console.log(`[関数計算段階] ${JSON.stringify(phases)}`);
}
