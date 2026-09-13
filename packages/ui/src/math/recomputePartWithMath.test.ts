import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyPartDocument, type KernelBridge, type PartDocument } from '@pointercad/model';
import type { MathWorkerPort } from '@pointercad/expression/math/client';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { createBrowserMathClient } from './createBrowserMathClient.js';
import { createMathPartRecomputer } from './recomputePartWithMath.js';

function unused(): never { throw new Error('Scalar-only recomputation must not call geometry'); }
function bridge(): KernelBridge {
  return { tessellateSketchFaces: unused, recomputeSolids: unused, offsetSketchCurves: unused,
    projectSketchCurves: unused, sectionSketchCurves: unused, measure: unused, exportShapes: unused,
    importShape: unused, inspectPrintability: unused, dispose() {} };
}
function document(source: string, id = 'part'): PartDocument {
  return { ...createEmptyPartDocument(), id, parameters: [{ name: 'a', mathId: 'a', unit: 'none', description: '',
    value: { source, value: 999, display: '999', mathDefinition: { format: 'pointercad-math/1', source,
      inputNotation: 'text', angleUnit: 'degree', expression: { kind: 'number', decimal: source } } } }] };
}
function fixture() {
  const created: { readonly terminate: ReturnType<typeof vi.fn>; readonly sent: unknown[] }[] = [];
  const createWorker = (): MathWorkerPort => {
    const backend = createMathBackend(), terminate = vi.fn(), sent: unknown[] = [];
    const worker: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, terminate,
      postMessage(value) { sent.push(value); queueMicrotask(() => { worker.onmessage?.({ data: executeMathWorkRequest(value, backend) }); }); } };
    created.push({ terminate, sent }); return worker;
  };
  const kernel = bridge(), compute = createMathPartRecomputer(createBrowserMathClient, createWorker);
  return { kernel, compute, created, createWorker };
}
afterEach(() => { vi.useRealTimers(); });

describe('実数式クライアントとモデル再計算を通して準備の再利用を確認する', () => {
  it('試し描きから確定と値の変更へ進んでも再読込せず、次の原式と世代を評価する', async () => {
    const { kernel, compute, created } = fixture();
    try {
      for (const [generation, source] of [[1, '2'], [2, '2'], [3, '3']] as const) {
        const input = document(source), before = JSON.stringify(input);
        const result = await compute(input, kernel, { generation });
        expect(result.errors).toEqual([]); expect(result.generation).toBe(generation);
        expect(result.parameterAnalysis?.variables.get('a')).toBe(Number(source));
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(created).toHaveLength(1);
      expect(created[0].sent[0]).toMatchObject({ request: { identity: { documentVersion: 1 }, source: '2' } });
      expect(created[0].sent.at(-1)).toMatchObject({ request: { identity: { documentVersion: 3 }, source: '3' } });
      expect(created[0].terminate).not.toHaveBeenCalled();
    } finally { compute.releaseOwner(kernel); }
    expect(created[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('文書と計算所有者の変更、数学のない新規文書で古い準備を解放する', async () => {
    const { kernel, compute, created } = fixture(), other = bridge();
    try {
      await compute(document('2'), kernel);
      await compute(document('3', 'other'), kernel);
      expect(created[0].terminate).toHaveBeenCalledTimes(1);
      await compute(document('4', 'other'), other);
      expect(created[1].terminate).toHaveBeenCalledTimes(1);
      compute.releaseOwner(kernel);
      expect(created[2].terminate).not.toHaveBeenCalled();
      await compute(createEmptyPartDocument(), other);
      expect(created[2].terminate).toHaveBeenCalledTimes(1);
    } finally { compute.releaseOwner(kernel); compute.releaseOwner(other); }
  });

  it('クライアント構築の例外でも開始済みのWorkerと監視を解放する', async () => {
    vi.useFakeTimers();
    const { kernel, createWorker, created } = fixture();
    const compute = createMathPartRecomputer(factory => {
      const port = factory(); port.postMessage('constructor failed'); throw new Error('client construction');
    }, createWorker);
    try {
      await expect(compute(document('2'), kernel)).rejects.toThrow('client construction');
      expect(created).toHaveLength(1); expect(created[0].terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { compute.releaseOwner(kernel); }
  });
});
