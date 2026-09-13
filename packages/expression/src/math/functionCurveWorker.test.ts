import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionCurveWorkEnvelope, decodeFunctionCurveWorkRequest, type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import { executeFunctionCurveWorkRequest } from './functionCurveWorkExecution.js';
import { decodeFunctionCurveWorkReply } from './functionCurveWorkReply.js';
import { FunctionCurveWorkerClient } from './functionCurveWorkerClient.js';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'scale', label: 'pi', decimal: '3' }];
function request(): FunctionCurveWorkRequest {
  const source = (source: string) => createFunctionMathSource(source, 'text', 'radian', { axes: ['X'], parameters: [], coefficients }, backend);
  return { identity: { documentId: 'part', documentVersion: 7, editorId: 'function', inputRevision: 2 }, independent: 'X',
    outputs: [source('X'), source('coef("pi")*X'), source('0')], lower: -1, upper: 1,
    minimum: [-1,-2,-1], maximum: [1,2,1], tolerance: 0.01, coefficients };
}
class Port implements CalculationWorkerPort {
  onmessage: CalculationWorkerPort['onmessage'] = null;
  onerror: CalculationWorkerPort['onerror'] = null;
  onmessageerror: CalculationWorkerPort['onmessageerror'] = null;
  readonly requests: unknown[] = [];
  terminated = false;
  postMessage(value: unknown): void { this.requests.push(value); }
  terminate(): void { this.terminated = true; }
  complete(index = 0): void {
    this.onmessage?.({ data: executeFunctionCurveWorkRequest(this.requests[index], backend) });
  }
}
const clients: FunctionCurveWorkerClient[] = [];
function client() {
  const ports: Port[] = [];
  const instance = new FunctionCurveWorkerClient({ createWorker: () => { const port = new Port(); ports.push(port); return port; } });
  clients.push(instance); return { client: instance, ports };
}
afterEach(() => { for (const value of clients.splice(0)) value.dispose(); vi.useRealTimers(); });

describe('関数のXYZ依頼と応答を往復で検査する', () => {
  it('原式を照合した曲線結果を返し、元の依頼・返答を変更しても受領値を変えない', () => {
    const input = request(), decoded = decodeFunctionCurveWorkRequest(input);
    expect(decoded).toEqual(input); expect(decoded).not.toBe(input); expect(Object.isFrozen(decoded.outputs[0].expression)).toBe(true);
    const reply = executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(4, decoded), backend);
    const result = decodeFunctionCurveWorkReply(reply, decoded);
    expect(result.result.status).toBe('ready'); expect(result.serial).toBe(4);
    if (result.result.status !== 'ready') throw new Error('Expected samples');
    expect(result.result.components[0][0].point).toEqual([-1,-3,0]); // Actual clipping follows in the CAD Worker.
    expect(Object.isFrozen(result.result.components[0][0].point)).toBe(true);
  });

  it.each([0,1,2])('軸%sの欠落・非有限・逆転・同値を拒否し、TでもXYZを省略できない', axis => {
    const input = request();
    for (const bad of [undefined, NaN, Infinity, -Infinity, input.minimum[axis], input.minimum[axis]-1]) {
      const maximum: unknown[] = [...input.maximum]; maximum[axis] = bad;
      expect(() => decodeFunctionCurveWorkRequest({ ...input, maximum })).toThrow();
      expect(() => decodeFunctionCurveWorkRequest({ ...input, independent: 'T', maximum })).toThrow();
    }
    expect(() => decodeFunctionCurveWorkRequest({ ...input, maximum: [1,2] })).toThrow();
    expect(() => decodeFunctionCurveWorkRequest({ ...input, lower: -0.5 })).toThrow();
  });

  it('保存ASTだけを差し替えた式をWorkerで失敗とし、部分の形を添えない', () => {
    const input = request();
    const modified = { ...input, outputs: [{ ...input.outputs[0], expression: input.outputs[2].expression }, input.outputs[1], input.outputs[2]] };
    const reply = executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request: modified }, backend);
    expect(reply.result.status).toBe('invalid'); expect(reply.result).not.toHaveProperty('components');
  });

  it('別世代、非有限座標、精度超過、逆順、未完了に添えた部分形状を拒否する', () => {
    const input = request(), reply = executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(2, input), backend);
    if (reply.result.status !== 'ready') throw new Error('Expected sample fixture');
    const result = reply.result;
    const badResults = [
      { ...result, maximumChordErrorBound: input.tolerance*2 },
      { ...result, components: [[{ parameter: -1, point: [NaN,0,0] }, { parameter: 1, point: [1,3,0] }]] },
      { ...result, components: [[{ parameter: 1, point: [1,3,0] }, { parameter: -1, point: [-1,-3,0] }]] },
      { ...result, status: 'stopped', reason: 'deadline' },
      { ...result, stats: { samples: 200001, cells: 1 } },
    ];
    for (const result of badResults) expect(() => decodeFunctionCurveWorkReply({ ...reply, result }, input)).toThrow();
    expect(() => decodeFunctionCurveWorkReply({ ...reply, identity: { ...reply.identity, documentVersion: 8 } }, input)).toThrow();
  });
});

describe('数式入力と共有する取消・世代・待機上限', () => {
  it('不正XYZを送る前に拒否し、Workerを起動しない', () => {
    const { client: worker, ports } = client();
    expect(() => worker.evaluate({ ...request(), maximum: [1,2,NaN] }, 5000)).toThrow(); expect(ports).toHaveLength(0);
  });

  it('待機中に呼出元の係数が変わっても依頼を差し替えず、原式と現在値の組を保つ', async () => {
    const { client: worker, ports } = client(), input = request();
    const first = worker.evaluate(input, 5000), values = coefficients.map(value => ({ ...value }));
    const second = worker.evaluate({ ...input, identity: { ...input.identity, inputRevision: 3 }, coefficients: values }, 5000);
    values[0].decimal = '100'; values[0].label = 'changed';
    ports[0].complete(); expect((await first).status).toBe('result');
    ports[0].complete(1);
    const completion = await second;
    if (completion.status !== 'result' || completion.result.status !== 'ready') throw new Error(JSON.stringify(completion));
    expect(completion.result.components[0][0].point[1]).toBe(-3);
  });

  it('実行中の取消はWorkerを交換し、旧Workerの遅れた成功を次の依頼へ混ぜない', async () => {
    const { client: worker, ports } = client(), abort = new AbortController();
    const first = worker.evaluate(request(), 5000, abort.signal), oldReply = ports[0].onmessage;
    const second = worker.evaluate({ ...request(), identity: { ...request().identity, documentVersion: 8 } }, 5000);
    abort.abort(); expect(await first).toMatchObject({ status: 'cancelled' }); expect(ports[0].terminated).toBe(true);
    expect(ports).toHaveLength(2);
    oldReply?.({ data: executeFunctionCurveWorkRequest(ports[0].requests[0], backend) });
    ports[1].complete(); expect(await second).toMatchObject({ status: 'result', identity: { documentVersion: 8 } });
  });

  it('時間超過でWorkerを交換し、取消済み待機依頼を実行せず、その後は成功する', async () => {
    vi.useFakeTimers();
    const { client: worker, ports } = client(), abort = new AbortController();
    const first = worker.evaluate(request(), 100), cancelled = worker.evaluate(request(), 100, abort.signal);
    abort.abort(); expect(await cancelled).toMatchObject({ status: 'cancelled' });
    await vi.advanceTimersByTimeAsync(100); expect(await first).toMatchObject({ status: 'deadline' });
    expect(ports[0].terminated).toBe(true); expect(ports[0].requests).toHaveLength(1);
    const retry = worker.evaluate(request(), 100); ports[1].complete(); expect((await retry).status).toBe('result');
  });

  it('待機32件の上限を守り、破棄時は実行中と待機中をすべて終了する', async () => {
    const { client: worker, ports } = client();
    const work = Array.from({ length: 33 }, () => worker.evaluate(request(), 5000));
    expect(await worker.evaluate(request(), 5000)).toMatchObject({ status: 'queue-full' });
    worker.dispose(); expect((await Promise.all(work)).every(result => result.status === 'disposed')).toBe(true);
    expect(ports[0].terminated).toBe(true); expect(ports[0].requests).toHaveLength(1);
    expect(await worker.evaluate(request(), 5000)).toMatchObject({ status: 'disposed' });
  });
});
