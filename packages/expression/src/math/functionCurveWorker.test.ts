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

describe('滑らかな関数曲線の返答（証明付きC1、厳密な3次は別経路のまま）', () => {
  function curveRequest(y: string): FunctionCurveWorkRequest {
    const input = request();
    const source = (text: string) => createFunctionMathSource(text, 'text', 'radian', { axes: ['X'], parameters: [], coefficients }, backend);
    return { ...input, outputs: [source('X'), source(y), source('0')] };
  }
  function evaluateSpan(poles: readonly (readonly number[])[], knots: readonly number[], span: number, u: number): number[] {
    const junction = (node: number) => {
      if (node === 0) return poles[0];
      if (node === knots.length - 1) return poles[poles.length - 1];
      const share = (knots[node] - knots[node - 1]) / (knots[node + 1] - knots[node - 1]);
      return poles[2 * node].map((value, axis) => value + (poles[2 * node + 1][axis] - value) * share);
    };
    const b = [junction(span), poles[2 * span + 1], poles[2 * span + 2], junction(span + 1)];
    const w = [(1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3];
    return [0, 1, 2].map(axis => b.reduce((sum, pole, k) => sum + pole[axis] * w[k], 0));
  }

  it('sin(3X)は全標本を通る証明付きの滑らかな曲線を返し、弦の証明は従来の精度以内', () => {
    const input = curveRequest('sin(3*X)');
    const reply = decodeFunctionCurveWorkReply(executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(5, input), backend), input);
    if (reply.result.status !== 'ready' || reply.result.smooth === undefined) throw new Error(JSON.stringify(reply.result));
    const { smooth, components, maximumChordErrorBound } = reply.result;
    expect(maximumChordErrorBound).toBeLessThanOrEqual(input.tolerance);
    expect(smooth.errorBound).toBeLessThanOrEqual(input.tolerance);
    expect(smooth.splines.map(spline => spline.knots)).toEqual(components.map(samples => samples.map(sample => sample.parameter)));
    // Sampled check, not the proof: the vertical gap to y = sin(3x) is at most sqrt(1 + 3^2) times the distance.
    for (const spline of smooth.splines) for (let span = 0; span < spline.knots.length - 1; span++) {
      for (let step = 0; step <= 8; step++) {
        const [x, y] = evaluateSpan(spline.poles, spline.knots, span, step / 8);
        expect(Math.abs(y - Math.sin(3 * x))).toBeLessThanOrEqual(smooth.errorBound * Math.sqrt(10) + 1e-12);
      }
    }
  });

  it('返答の誤差上限は極から計算し直し、詐称・節点のずれ・Bezierとの混在を拒否する', () => {
    const input = curveRequest('sin(3*X)');
    const reply = executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(6, input), backend);
    const result = reply.result;
    if (result.status !== 'ready' || result.smooth === undefined) throw new Error('Expected smooth fixture');
    const smooth = result.smooth;
    const spline = smooth.splines[0], moved = spline.poles.map((pole, n) => n === 1 ? [pole[0], pole[1] + 0.5, pole[2]] : pole);
    // A tiny change of one inner pole moves the native junction at knot 1 off its certified sample.
    const forgedJunction = spline.poles.map((pole, n) => n === 3 ? [pole[0], pole[1] + 1e-9, pole[2]] : pole);
    const badResults = [
      { ...result, smooth: { ...smooth, errorBound: result.maximumChordErrorBound } },
      { ...result, smooth: { ...smooth, errorBound: input.tolerance * 2 } },
      { ...result, smooth: { ...smooth, splines: [{ ...spline, knots: spline.knots.map((knot, n) => n === 1 ? knot + 1e-9 : knot) }] } },
      { ...result, smooth: { ...smooth, splines: [{ ...spline, poles: moved }] } },
      { ...result, smooth: { ...smooth, splines: [{ ...spline, poles: forgedJunction }] } },
      { ...result, smooth: { ...smooth, splines: [{ ...spline, poles: spline.poles.slice(1) }] } },
      { ...result, smooth: { ...smooth, splines: [] } },
      { ...result, bezier: [[-1, 0, 0], [0, 0, 0], [0, 0, 0], [1, 0, 0]] },
    ];
    for (const bad of badResults) expect(() => decodeFunctionCurveWorkReply({ ...reply, result: bad }, input)).toThrow();
    expect(decodeFunctionCurveWorkReply(reply, input).result).toMatchObject({ status: 'ready' });
  });

  it('XYZ範囲に収まる厳密な3次式は従来どおりBezierだけを返し、滑らかな近似を添えない', () => {
    const input = curveRequest('X*X*X');
    const reply = decodeFunctionCurveWorkReply(executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(7, input), backend), input);
    if (reply.result.status !== 'ready') throw new Error(JSON.stringify(reply.result));
    expect(reply.result.bezier).toBeDefined(); expect(reply.result).not.toHaveProperty('smooth');
  });
});

describe('媒介変数の範囲の原式を任意の内部項目で運び、周期の判定を実行まで届ける', () => {
  const tSource = (text: string) => createFunctionMathSource(text, 'text', 'radian', { axes: [], parameters: ['T'], coefficients }, backend);
  const boundSource = (text: string) => createFunctionMathSource(text, 'text', 'radian', { axes: [], parameters: [], coefficients }, backend);
  function loop(z = '0'): FunctionCurveWorkRequest {
    return { ...request(), independent: 'T', outputs: [tSource('cos(T)'), tSource('sin(T)'), tSource(z)], lower: 0, upper: 2 * Math.PI,
      minimum: [-2, -2, -2], maximum: [2, 2, 2], parameterSources: { lower: boundSource('0'), upper: boundSource('2*pi') } };
  }
  function run(input: FunctionCurveWorkRequest, serial = 9) {
    return executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(serial, input), backend);
  }

  it('原式を持たない従来の依頼は同じ項目のまま往復し、周期の判定を持たない', () => {
    const input = decodeFunctionCurveWorkRequest(request());
    expect(input).not.toHaveProperty('parameterSources');
    const reply = decodeFunctionCurveWorkReply(run(input), input);
    expect(reply.result.status).toBe('ready'); expect(reply.result).not.toHaveProperty('periodicity');
  });

  it('原式は T の依頼だけに、lower・upper の2項目に固定して厳密に受け取る', () => {
    const decoded = decodeFunctionCurveWorkRequest(loop());
    expect(decoded.parameterSources?.upper.expression).toEqual(boundSource('2*pi').expression);
    expect(Object.isFrozen(decoded.parameterSources)).toBe(true);
    const sources = loop().parameterSources;
    expect(() => decodeFunctionCurveWorkRequest({ ...request(), parameterSources: sources })).toThrow();
    expect(() => decodeFunctionCurveWorkRequest({ ...loop(), parameterSources: { ...sources, extra: 1 } })).toThrow();
    expect(() => decodeFunctionCurveWorkRequest({ ...loop(), parameterSources: { lower: sources?.lower } })).toThrow();
    expect(() => decodeFunctionCurveWorkRequest({ ...loop(), parameterSources: null })).toThrow();
  });

  it('円は 2π の1周と証明されて終点が始点と同じ点になり、らせんは未証明のまま形も原式なしの依頼と同じ', () => {
    const circle = loop(), circleReply = decodeFunctionCurveWorkReply(run(circle), circle);
    if (circleReply.result.status !== 'ready') throw new Error(JSON.stringify(circleReply.result));
    expect(circleReply.result.periodicity).toEqual({ status: 'proved', turns: 1, period: { numerator: '2', denominator: '1', piPower: 1 } });
    const samples = circleReply.result.components[0];
    expect(samples[samples.length - 1].point).toEqual(samples[0].point);
    expect(circleReply.result.smooth?.seam).toBeDefined();
    const helix = loop('T/(2*pi)'), helixReply = decodeFunctionCurveWorkReply(run(helix), helix);
    expect(helixReply.result).toMatchObject({ status: 'ready', periodicity: { status: 'unproved', reason: 'nonperiodic-coordinate' } });
    const { parameterSources: helixSources, ...plain } = helix;
    expect(helixSources).toBeDefined();
    const plainReply = decodeFunctionCurveWorkReply(run(plain), plain);
    if (helixReply.result.status !== 'ready' || plainReply.result.status !== 'ready') throw new Error('Expected ready helix replies');
    // An unproved intent changes nothing: the samples and splines are byte-for-byte those of the request without sources.
    expect(helixReply.result.components).toEqual(plainReply.result.components);
    expect(helixReply.result.smooth).toEqual(plainReply.result.smooth);
  });

  it('作り物・欠落・原式なしの依頼への周期の判定を断る', () => {
    const circle = loop(), reply = run(circle), result = reply.result;
    if (result.status !== 'ready' || result.periodicity === undefined) throw new Error('Expected a periodicity fixture');
    const proof = result.periodicity;
    const { periodicity: dropped, ...withoutProof } = result;
    expect(dropped).toBe(proof);
    const bad = [
      { ...result, periodicity: { ...proof, turns: 2 } },
      { ...result, periodicity: { status: 'unproved', reason: 'not-whole-period' } },
      { ...result, periodicity: { ...proof, extra: true } },
      { ...result, periodicity: { status: 'proved', turns: 1, period: { numerator: '1', denominator: '1', piPower: 1 } } },
      withoutProof,
    ];
    for (const value of bad) expect(() => decodeFunctionCurveWorkReply({ ...reply, result: value }, circle)).toThrow();
    expect(decodeFunctionCurveWorkReply(reply, circle).result).toMatchObject({ status: 'ready' });
    const { parameterSources: removed, ...plain } = circle;
    expect(removed).toBeDefined();
    const plainReply = run(plain);
    if (plainReply.result.status !== 'ready') throw new Error('Expected a plain fixture');
    expect(() => decodeFunctionCurveWorkReply({ ...plainReply, result: { ...plainReply.result, periodicity: proof } }, plain)).toThrow();
  });
});
