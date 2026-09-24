import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend, type MathExecutionReply } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';

type Example = {
  readonly operation: 'gradient' | 'divergence' | 'curl' | 'laplacian';
  readonly body: string;
  readonly system: 0 | 1 | 2;
  readonly component?: number;
  readonly expected: number;
  readonly pointText: string;
  readonly point: readonly [number, number, number];
  readonly angleUnit?: 'degree' | 'radian';
};
const cylindrical = { system: 1, pointText: '[2,3,4]', point: [2, 3, 4] } as const;
const spherical = { system: 2, pointText: '[2,π/2,π/4]', point: [2, Math.PI / 2, Math.PI / 4] } as const;
const sphericalField = { system: 2, pointText: '[2,π/2,1]', point: [2, Math.PI / 2, 1] } as const;
const degree = { angleUnit: 'degree', pointText: '[2,60,30]', point: [2, 60, 30] } as const;

// Independent hand-derived values: cylindrical f=r²θ+z³ and A=(rθ+z²,r²z,θz+r²);
// spherical f=r*x has Δf=4*x/r, and z-axis rigid rotation has curl=2 e_z.
// These do not call either implementation to construct their expected values.
const examples: readonly Example[] = [
  ...([12, 2, 48] as const).map((expected, i): Example => ({ ...cylindrical,
    operation: 'gradient', body: 'r^2*t+p^3', component: i + 1, expected })),
  { ...cylindrical, operation: 'laplacian', body: 'r^2*t+p^3', expected: 36 },
  { ...cylindrical, operation: 'divergence', body: '[r*t+p^2,r^2*p,t*p+r^2]', expected: 17 },
  ...([-2, 4, 23] as const).map((expected, i): Example => ({ ...cylindrical,
    operation: 'curl', body: '[r*t+p^2,r^2*p,t*p+r^2]', component: i + 1, expected })),
  ...([2 * Math.SQRT2, 0, -Math.SQRT2] as const).map((expected, i): Example => ({ ...spherical,
    operation: 'gradient', body: 'r^2*sin(t)*cos(p)', component: i + 1, expected })),
  { ...spherical, operation: 'laplacian', body: 'r^2*sin(t)*cos(p)', expected: 2 * Math.SQRT2 },
  { ...sphericalField, operation: 'divergence', body: '[r*t+p,r*p,r*t^2]', expected: 3 * Math.PI / 2 + 1 },
  ...([Math.PI - 1, 0.5 - Math.PI ** 2 / 2, 1] as const).map((expected, i): Example => ({ ...sphericalField,
    operation: 'curl', body: '[r*t+p,r*p,r*t^2]', component: i + 1, expected })),
  ...([1, -Math.sqrt(3), 0] as const).map((expected, i): Example => ({ system: 2,
    pointText: '[2,π/3,π/6]', point: [2, Math.PI / 3, Math.PI / 6],
    operation: 'curl', body: '[0,0,r*sin(t)]', component: i + 1, expected })),
  { ...spherical, operation: 'divergence', body: '[0,0,r*sin(t)]', expected: 0 },
  ...([0.75, Math.sqrt(3) / 4, -0.5] as const).map((expected, i): Example => ({ system: 2,
    pointText: '[2,π/3,π/6]', point: [2, Math.PI / 3, Math.PI / 6],
    operation: 'gradient', body: 'r*sin(t)*cos(p)', component: i + 1, expected })),
  { ...degree, system: 1, operation: 'gradient', body: 't', component: 2, expected: 90 / Math.PI },
  { ...degree, system: 1, operation: 'divergence', body: '[0,t,0]', expected: 90 / Math.PI },
  { ...degree, system: 1, operation: 'curl', body: '[0,0,t]', component: 1, expected: 90 / Math.PI },
  { ...degree, system: 1, operation: 'laplacian', body: 'r^2*cos(t)', expected: 1.5 },
  { ...degree, system: 2, operation: 'gradient', body: 'r*cos(t)', component: 2, expected: -Math.sqrt(3) / 2 },
  { ...degree, system: 2, operation: 'laplacian', body: 'r^2*cos(t)', expected: 2 },
  { ...degree, system: 2, operation: 'curl', body: '[0,0,r*sin(t)]', component: 1, expected: 1 },
  { ...degree, system: 2, operation: 'divergence', body: '[r,0,0]', expected: 3 },
  { ...degree, system: 2, operation: 'gradient', body: 'p', component: 3, expected: 180 / (Math.sqrt(3) * Math.PI) },
  { ...degree, system: 2, operation: 'laplacian', body: 'p^2', expected: 2 / 3 * (180 / Math.PI) ** 2 },
  { ...degree, system: 2, operation: 'divergence', body: '[0,0,p]', expected: 180 / (Math.sqrt(3) * Math.PI) },
  { ...degree, system: 2, operation: 'curl', body: '[0,p,0]', component: 1, expected: -180 / (Math.sqrt(3) * Math.PI) },
  { ...cylindrical, system: 0, operation: 'laplacian', body: 'r^2+t^2+p^2', expected: 6 },
];
function source(example: Example, at: boolean): string {
  const body = at ? example.body : example.body.replace(/\br\b/gu, 'X').replace(/\bt\b/gu, 'Y').replace(/\bp\b/gu, 'Z');
  const input = at ? `${example.operation}at(${body},[r,t,p],[${example.pointText},${String(example.system)}])`
    : `${example.operation}(${body},[X,Y,Z],${String(example.system)})`;
  return example.component === undefined ? input : `component(${input},${String(example.component)})`;
}
function request(source: string, angleUnit: 'degree' | 'radian' = 'radian'): MathWorkRequest {
  return { source, notation: 'text', angleUnit, coefficients: [],
    identity: { documentId: 'curvilinear', documentVersion: 1, editorId: 'X', inputRevision: 1 } };
}
function exampleRequest(example: Example): MathWorkRequest {
  return { ...request(source(example, true), example.angleUnit), presentationNotation: 'latex' };
}
const refusals = [
  ['component(gradientat(1,[r,t,p],[[0,1,2],1]),1)', 'radian'],
  ['0*laplacianat(r^2,[r,t,p],[[0,1,2],1])', 'radian'],
  ['divergenceat([0,0,0],[r,t,p],[[-1,1,2],1])', 'radian'],
  ['component(curlat([0,0,0],[r,t,p],[[0,1,2],2]),3)', 'radian'],
  ['component(gradientat(1,[r,t,p],[[2,0,1],2]),1)', 'radian'],
  ['laplacianat(1,[r,t,p],[[2,π,1],2])', 'radian'],
  ['divergenceat([r,0,0],[r,t,p],[[2,180,1],2])', 'degree'],
  ['component(curlat([0,0,0],[r,t,p],[[2,-1,1],2]),1)', 'radian'],
  ['laplacianat(1,[r,t,p],[[2,2*π,1],2])', 'radian'],
  ['laplacianat(1,[r,t,p],[[2,181,1],2])', 'degree'],
  ['component(gradientat(r+p/p,[r,t,p],[[2,1,0],1]),1)', 'radian'],
  ['component(curlat([r,t,p/p],[r,t,p],[[2,1,0],2]),1)', 'radian'],
  ['component(gradientat(r,[r,t,p],[[i,1,1],1]),1)', 'radian'],
  ['laplacianat(1,[r,t,p],[[2,∞,1],2])', 'radian'],
] as const;
let backend: MathExecutionBackend;
let exact: readonly MathExecutionReply[], refused: readonly MathExecutionReply[], roundTrips: readonly MathExecutionReply[];
const script = fileURLToPath(new URL('./exactRuntime/cas_vector_calculus_test.py', import.meta.url));
const engine = sharedExactEngine(exactRuntimeBatch(script, 60_000));
const scope = { axes: ['X', 'Y', 'Z'] as const, parameters: [], coefficients: [] };
const context = () => ({ backend, shouldStop: () => undefined });
function tape(input: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return compileFunctionScalar(createFunctionMathSource(input, 'text', angleUnit, scope, backend), scope.axes, [], context());
}
function decode(raw: MathExecutionReply, input: MathWorkRequest) {
  return decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
beforeAll(async () => {
  backend = createMathBackend();
  const inputs = [...examples.map(exampleRequest),
    ...refusals.map(([input, unit]) => request(input, unit))];
  const results = await Promise.all(inputs.map(input => executeExactMathWorkRequest(createMathWorkEnvelope(1, input), { ...context(), engine })));
  exact = results.slice(0, examples.length);
  refused = results.slice(examples.length);
  // Reparse and run the saved structured input through the real engine again.
  // Both batches share one runtime each, rather than spawning one per component.
  roundTrips = await Promise.all(exact.map((reply, index) => {
    if (reply.presentation === undefined || reply.presentation === null) throw new Error(JSON.stringify(reply));
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...inputs[index],
      source: reply.presentation.source, notation: 'latex', definition: reply.presentation, presentationNotation: 'text' })));
    return executeExactMathWorkRequest(saved, { ...context(), engine });
  }));
}, 120_000);

describe('円柱・球座標の物理成分を独立な解析値と照合する', () => {
  it.each(examples)('$operation 座標系$system 成分$component $body（$angleUnit）の指定位置', example => {
    const index = examples.indexOf(example), input = exampleRequest(example);
    const result = decode(exact[index], input);
    expect(result.evaluation.status, JSON.stringify(result.evaluation)).toBe('value');
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(result.evaluation.coordinate).toBeCloseTo(example.expected, 11);
    expect(result.evaluation.exact).not.toBeNull();
    expect(result.definition).toMatchObject({ source: input.source, angleUnit: input.angleUnit, format: 'pointercad-math/1' });
    const restored = roundTrips[index];
    expect(restored.evaluation).toEqual(result.evaluation);
    if (restored.presentation === undefined || restored.presentation === null || exact[index].expression === null) {
      throw new Error(JSON.stringify(restored));
    }
    expect(sameMathMeaning(exact[index].expression, restored.presentation.expression)).toBe(true);
  });
  it.each(examples)('$operation 座標系$system 成分$component $body（$angleUnit）の作図・保存・表示', example => {
    const input = source(example, false), unit = example.angleUnit ?? 'radian';
    const original = createFunctionMathSource(input, 'text', unit, scope, backend);
    const restored: unknown = JSON.parse(JSON.stringify(original));
    const compiled = compileFunctionScalar(restored, scope.axes, [], context());
    expect(createScalarSampler(compiled)(example.point)).toBeCloseTo(example.expected, 10);
    const presentation = executeMathWorkRequest(createMathWorkEnvelope(3, { ...request(input, unit),
      functionScope: { axes: [...scope.axes], parameters: [] }, presentationNotation: 'latex' }), backend).presentation;
    if (presentation === undefined || presentation === null) throw new Error(`構造表記を保存できません: ${input}`);
    expect(sameMathMeaning(original.expression, presentation.expression)).toBe(true);
    expect(createScalarSampler(compileFunctionScalar(presentation, scope.axes, [], context()))(example.point))
      .toBeCloseTo(example.expected, 10);
  });
});

describe('座標軸と元の場の不成立を消さない', () => {
  it.each(refusals)('%s（%s）は座標値を返さず理由付きで拒否する', (input, unit) => {
    const index = refusals.findIndex(value => value[0] === input && value[1] === unit);
    const evaluation = decode(refused[index], request(input, unit)).evaluation;
    expect(evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    expect(evaluation).not.toHaveProperty('coordinate');
    if (evaluation.status !== 'invalid') throw new Error(JSON.stringify(evaluation));
    expect(evaluation.detail.length).toBeGreaterThan(0);
  });
  it.each([
    ['component(gradient(1,[X,Y,Z],1),1)', [0, 1, 2], 'radian'],
    ['0*laplacian(X^2,[X,Y,Z],1)', [-1, 1, 2], 'radian'],
    ['divergence([0,0,0],[X,Y,Z],2)', [0, 1, 2], 'radian'],
    ['component(curl([0,0,0],[X,Y,Z],2),3)', [2, 0, 2], 'radian'],
    ['component(gradient(1,[X,Y,Z],2),1)', [2, Math.PI, 2], 'radian'],
    ['laplacian(X^2,[X,Y,Z],2)', [2, 180, 2], 'degree'],
    ['0*divergence([X,0,0],[X,Y,Z],2)', [2, 181, 2], 'degree'],
    ['component(gradient(X+Z/Z,[X,Y,Z],1),1)', [2, 1, 0], 'radian'],
  ] as const)('%sの特異点を作図でも補わない', (input, point, unit) => {
    const compiled = tape(input, unit);
    expect(Number.isNaN(createScalarSampler(compiled)(point))).toBe(true);
    expect(createScalarIntervalSampler(compiled)(point.map(value => ({ lower: value - 0.01, upper: value + 0.01 }))).continuous).toBe(false);
  });
  it.each([
    'component(gradient(X,[X,Y,Z],3),1)', 'laplacian(X,[X,Y,Z],1/2)',
    'component(curl([X,Y],[X,Y],1),1)', 'laplacian(X,[X,Y,Z,X],2)',
    'divergence([X,Y],[X,Y,Z],2)', 'laplacian(X,[X,X,Z],1)',
    'component(hessian(X,[X,Y,Z],1),1,1)', 'component(gradient([X,Y,Z],[X,Y,Z],2),1)',
  ])('%sの不正な座標系・形を拒否する', input => { expect(() => tape(input)).toThrow(); });
  it.each([
    'gradientat(r,[r,t,p],[[1,1,1],3])', 'gradientat(r,[r,t],[[1,1],1])',
    'gradientat(r,[r,t,p],[[1,1],2])', 'curlat([r,t],[r,t,p],[[1,1,1],1])',
    'hessianat(r,[r,t,p],[[1,1,1],2])', 'laplacianat(r,[r,t,p],[[1,1,1],1/2])',
  ])('%sの指定位置の不正な指定を拒否する', input => {
    expect(executeMathWorkRequest(createMathWorkEnvelope(4, request(input)), backend).evaluation.status).toBe('invalid');
  });
  it('円柱と球の座標順序を変数名から推測しない', async () => {
    const inputs = [
      ['component(gradientat(z^2,[z,r,t],[[3,1,2],2]),1)', 6],
      ['laplacianat(r^2,[r,θ,z],[[2,1,0],1])', 4],
      ['laplacianat(r^2,[r,θ,φ],[[2,1,0],2])', 6],
      ['component(curlat([0,r,0],[r,θ,z],[[2,1,0],1]),3)', 2],
      ['component(gradientat(r^2,[r,θ,φ],[[2,1,0],2]),1)', 4],
    ] as const;
    const results = await Promise.all(inputs.map(([input]) =>
      executeExactMathWorkRequest(createMathWorkEnvelope(5, request(input)), { ...context(), engine })));
    inputs.forEach(([input, coordinate], index) => {
      expect(decode(results[index], request(input)).evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate });
    });
    expect(createScalarSampler(tape('component(gradient(Z^2,[Z,X,Y],2),1)'))([1, 2, 3])).toBeCloseTo(6, 12);
  });
  it('内側の座標系の特異点は外側の微分でも残る', () => {
    const compiled = tape('diff(component(gradient(X^2,[X,Y,Z],2),1),X)');
    expect(createScalarSampler(compiled)([2, 1, 0])).toBe(2);
    expect(Number.isNaN(createScalarSampler(compiled)([2, 0, 0]))).toBe(true);
  });
  it.each([1, 2])('座標系%sの小さい正の半径を特異点へ丸めない', system => {
    const compiled = tape(`component(gradient(1,[X,Y,Z],${String(system)}),1)`);
    expect(createScalarSampler(compiled)([1e-310, 1, 0])).toBe(0);
    expect(Number.isNaN(createScalarSampler(compiled)([0, 1, 0]))).toBe(true);
  });
});
