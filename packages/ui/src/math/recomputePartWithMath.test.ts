import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyPartDocument, evaluateDocumentMath, type KernelBridge, type PartDocument } from '@pointercad/model';
import type { MathWorkerPort, MathWorkRequest } from '@pointercad/expression/math/client';
import { createMathBackend, executeMathWorkRequest, warmMathBackend } from '@pointercad/expression/math/worker';
import { createBrowserMathClient, createMathResultMemory, mathRequestMemoryKey } from './createBrowserMathClient.js';
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
    // As math.worker.ts does before any request: under load the first request's compilation exceeded the
    // backend's own time limit and returned a stopped value (2026-09-27, 2.9 s run of this file).
    warmMathBackend(backend);
    const worker: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, terminate,
      postMessage(value) { sent.push(value); queueMicrotask(() => { worker.onmessage?.({ data: executeMathWorkRequest(value, backend) }); }); } };
    created.push({ terminate, sent }); return worker;
  };
  const kernel = bridge(), compute = createMathPartRecomputer(factory => createBrowserMathClient(factory), createWorker);
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

describe('入力画面で計算済みの値を再計算で使い回す(同じ要求の中身だけ)', () => {
  const identity = { documentId: 'part', documentVersion: 1, editorId: 'editor', inputRevision: 1 };
  const request = (source: string, extra: Partial<MathWorkRequest> = {}): MathWorkRequest =>
    ({ identity, source, notation: 'text', angleUnit: 'degree', coefficients: [], ...extra });

  it('適用で計算した原式は再計算で計算部へ送らず、再計算の世代の識別で同じ値を返す', async () => {
    const { kernel, createWorker, created } = fixture(), memory = createMathResultMemory();
    const compute = createMathPartRecomputer(factory => createBrowserMathClient(factory, memory), createWorker);
    const editor = createBrowserMathClient(createWorker, memory);
    try {
      const applied = await evaluateDocumentMath(document('2'), { client: editor,
        identity: { documentId: 'part', documentVersion: 1 }, isCurrent: () => true });
      expect(applied.ok).toBe(true); expect(created).toHaveLength(1); expect(created[0].sent).toHaveLength(1);
      const result = await compute(document('2'), kernel, { generation: 2 });
      expect(result.errors).toEqual([]); expect(result.generation).toBe(2);
      expect(result.parameterAnalysis?.variables.get('a')).toBe(2); expect(created).toHaveLength(1);
      // 原式が変われば計算部で計算し、その世代の要求を送る。
      const changed = await compute(document('3'), kernel, { generation: 3 });
      expect(changed.parameterAnalysis?.variables.get('a')).toBe(3); expect(created).toHaveLength(2);
      expect(created[1].sent).toMatchObject([{ request: { identity: { documentVersion: 3 }, source: '3' } }]);
      const undone = await compute(document('2'), kernel, { generation: 4 });
      expect(undone.parameterAnalysis?.variables.get('a')).toBe(2); expect(created[1].sent).toHaveLength(1);
    } finally { editor.dispose(); compute.releaseOwner(kernel); }
  });

  it('覚えた値でも要求と識別・期限を検査し、取消と終了後は値を返さない', async () => {
    const { createWorker, created } = fixture(), memory = createMathResultMemory();
    const first = createBrowserMathClient(createWorker, memory);
    expect(await first.evaluate(request('2'), 5000)).toMatchObject({ status: 'result', identity });
    first.dispose();
    const client = createBrowserMathClient(createWorker, memory), next = { ...identity, documentVersion: 7, inputRevision: 3 };
    try {
      const reply = await client.evaluate(request('2', { identity: next }), 5000);
      expect(reply).toMatchObject({ status: 'result', identity: next }); expect(created).toHaveLength(1);
      if (reply.status !== 'result') throw new Error('覚えた値を返していません');
      const again = await client.evaluate(request('2'), 5000);
      if (again.status !== 'result') throw new Error('覚えた値を返していません');
      expect(again.result).toEqual(reply.result); expect(again.result).not.toBe(reply.result);
      expect(() => client.evaluate(request('2', { identity: { ...identity, documentId: '' } }), 5000)).toThrow();
      expect(() => client.evaluate(request('2'), 0)).toThrow(RangeError);
      const abort = new AbortController(); abort.abort();
      expect(await client.evaluate(request('2'), 5000, abort.signal)).toMatchObject({ status: 'cancelled', identity });
    } finally { client.dispose(); }
    expect(await client.evaluate(request('2'), 5000)).toMatchObject({ status: 'disposed', identity });
    expect(created).toHaveLength(1);
  });

  it('グループにまだ実Workerが無い間は覚えた値を使わず本物を計算部へ送って温め、温まれば使い回す', async () => {
    const { createWorker, created } = fixture(), memory = createMathResultMemory();
    let warm = false;
    const client = createBrowserMathClient(createWorker, memory, () => warm);
    try {
      expect(await client.evaluate(request('2'), 5000)).toMatchObject({ status: 'result', identity });
      expect(created).toHaveLength(1); expect(created[0].sent).toHaveLength(1);
      // まだ warm=false なので、同じ要求でも覚えた値を使わずまた計算部へ送る(コールドスタートを確実に払う)。
      expect(await client.evaluate(request('2'), 5000)).toMatchObject({ status: 'result', identity });
      expect(created[0].sent).toHaveLength(2);
      warm = true;
      // warm=true になれば覚えた値を使い、計算部へは送らない。
      expect(await client.evaluate(request('2'), 5000)).toMatchObject({ status: 'result', identity });
      expect(created[0].sent).toHaveLength(2);
    } finally { client.dispose(); }
  });

  it('再計算の枠にまだ実Workerが無い間は入力画面が覚えた値を使わず、枠自身のWorkerを温める', async () => {
    const { kernel, createWorker, created } = fixture(), memory = createMathResultMemory();
    const compute = createMathPartRecomputer((factory, hasWorker) => createBrowserMathClient(factory, memory, hasWorker), createWorker);
    const editor = createBrowserMathClient(createWorker, memory);
    try {
      const applied = await evaluateDocumentMath(document('2'), { client: editor,
        identity: { documentId: 'part', documentVersion: 1 }, isCurrent: () => true });
      expect(applied.ok).toBe(true); expect(created).toHaveLength(1); expect(created[0].sent).toHaveLength(1);
      // 再計算は別のグループ(別のWorker)を使い、そちらはまだ温まっていないので覚えた値に頼らず本物を送る。
      const result = await compute(document('2'), kernel, { generation: 2 });
      expect(result.errors).toEqual([]); expect(result.parameterAnalysis?.variables.get('a')).toBe(2);
      expect(created).toHaveLength(2); expect(created[1].sent).toHaveLength(1);
      // 同じ枠(同じグループ)が温まった後の再計算は覚えた値を使い、送らない。
      const again = await compute(document('2'), kernel, { generation: 3 });
      expect(again.parameterAnalysis?.variables.get('a')).toBe(2); expect(created[1].sent).toHaveLength(1);
    } finally { editor.dispose(); compute.releaseOwner(kernel); }
  });

  it('値でない結果を覚えず、上限を超えた古い値から捨てる', () => {
    const memory = createMathResultMemory(), key = (index: number) => mathRequestMemoryKey(request(String(index))) ?? '';
    const value = (decimal: string) => ({ definition: null, evaluation: { status: 'value' as const, kind: 'real' as const, exact: null,
      decimal, coordinate: Number(decimal), approximation: null } });
    memory.remember(key(0), { definition: null, evaluation: { status: 'stopped', reason: 'budget' } });
    expect(memory.get(key(0))).toBeUndefined();
    for (let index = 0; index <= 64; index++) memory.remember(key(index), value(String(index)));
    expect(memory.get(key(0))).toBeUndefined(); expect(memory.get(key(1))).toMatchObject({ evaluation: { decimal: '1' } });
    expect(memory.get(key(64))).toMatchObject({ evaluation: { decimal: '64' } });
  });

  it('識別以外の全ての項目で区別し、項目の順序には依らず、JSONで区別できない値は覚えない', () => {
    const key = mathRequestMemoryKey, base = request('2*a', { coefficients: [{ id: 'a', label: 'a', decimal: '1' }] });
    expect(key(base)).toBe(key({ ...base, identity: { ...identity, documentVersion: 9, editorId: 'document-math' } }));
    expect(key(base)).toBe(key({ coefficients: base.coefficients, angleUnit: 'degree', notation: 'text', source: '2*a', identity }));
    for (const changed of [request('3*a', { coefficients: base.coefficients }), { ...base, angleUnit: 'radian' as const },
      { ...base, notation: 'latex' as const }, { ...base, coefficients: [{ id: 'a', label: 'a', decimal: '2' }] },
      { ...base, presentationNotation: 'latex' as const }, { ...base, renameCoefficient: { id: 'a', label: 'b' } }]) {
      expect(key(changed)).not.toBe(key(base));
    }
    const unusual: unknown[] = [-0, Number.NaN, Number.POSITIVE_INFINITY, new Date(0), () => 1];
    for (const value of unusual) {
      expect(key({ ...base, coefficients: [{ id: 'a', label: 'a', decimal: '1', exactExpression: value }] })).toBeNull();
    }
  });
});
