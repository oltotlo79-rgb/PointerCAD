import { beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import { createMathBackend, createFunctionMathSource, executeMathWorkRequest, executeFunctionCurveWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { decodeMathWorkReply, CANDIDATE_MATH_BY_ID } from '@pointercad/expression/math/contracts';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { recomputePart } from '../part/recomputePart.js';
import { FUNCTION_DEFINITION_FORMAT } from '../functionGeometry/functionDefinitionTypes.js';
import type { SketchFunctionCurveFeature } from '../sketch/types.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { prepareScriptTransaction } from './scriptTransaction.js';
import { createScriptSnapshot } from './scriptSnapshot.js';
import type { ScriptCommand } from './scriptTypes.js';
import type { ScriptFunctionCompiler } from './scriptFunctionCommands.js';
let backend: MathExecutionBackend, bridge: AssemblyKernelBridge;
beforeAll(async () => {
  backend = createMathBackend();
  await loadOcctForNode();
  bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, 180000);
const calculate: typeof recomputePart = (document, kernel, options = {}) => recomputePart(document, kernel, {
  ...options,
  math: {
    identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => !options.shouldCancel?.(), client: {
      evaluate: request => Promise.resolve({
        status: 'result', identity: request.identity,
        result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() }).result
      })
    }
  },
  functions: {
    curves: {
      evaluate: request => Promise.resolve({
        status: 'result', identity: request.identity,
        result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result
      })
    }
  }
});
describe('自動作図と関数を同じ文書で再計算する', () => {
  it('新しい関数命令も実CADで範囲内の辺にし、中止や計算部の欠落では追加しない', async () => {
    const document = createEmptyPartDocument(), snapshot = createScriptSnapshot(document, 'new-curve', 'mm');
    const sketchAlias = [...snapshot.references].find(([, reference]) => reference.kind === 'sketch')?.[0];
    if (!sketchAlias)
      throw new Error('Missing sketch');
    const command: ScriptCommand = {
      kind: 'function.curve', resultId: 'commands:1', callStack: 'at <eval> (user-script.js:1:1)', fields: {
        sketch: sketchAlias,
        definition: {
          angleUnit: 'degree', bounds: { X: ['-1', '1'], Y: ['-1', '1'], Z: ['-1', '1'] }, tolerance: '0.001',
          formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: 'X', Z: '0' } }
        }
      }
    };
    const compile: ScriptFunctionCompiler = candidate => {
      const source = (text: string) => createFunctionMathSource(text, 'text', 'degree', { axes: ['X'], parameters: [], coefficients: [] }, backend);
      const range = { min: number(-1), max: number(1) };
      return Promise.resolve({
        document: candidate, definition: {
          format: FUNCTION_DEFINITION_FORMAT, bounds: { X: range, Y: range, Z: range }, tolerance: number(0.001),
          formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: source('X'), Z: source('0') } }
        }
      });
    };
    const input = {
      requestId: 'new-script-curve', document, commands: [command], references: snapshot.references, commandNamespace: 'commands', lengthUnit: 'mm' as const,
      sources: new Map([['user-script.js', 'cad.function.curve(sketch,definition);']]), importedShapes: new Map()
    };
    expect((await prepareScriptTransaction(input, bridge, () => false, undefined, calculate)).ok).toBe(false);
    const ready = await prepareScriptTransaction(input, bridge, () => false, undefined, calculate, compile);
    if (!ready.ok)
      throw new Error(ready.error.message);
    try {
      const curves = ready.prepared.result.sketches[0].resolved.splines;
      expect(curves).toHaveLength(1);
      expect(curves[0].points.length).toBeGreaterThanOrEqual(2);
      for (const [x, y, z] of curves[0].points) {
        expect(x).toBeGreaterThanOrEqual(-1);
        expect(x).toBeLessThanOrEqual(1);
        expect(y).toBeCloseTo(x, 7);
        expect(z).toBe(0);
      }
      expect(document.sketches[0].features).toEqual([]);
      expect(ready.prepared.result.errors).toEqual([]);
    }
    finally {
      await ready.prepared.release();
    }
    expect(await prepareScriptTransaction(input, bridge, () => true, undefined, calculate, compile)).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  }, 30000);
  it('係数のIDを保って関数を更新し、追加の箱とともに実CADで確認してから渡す', async () => {
    const initial = createEmptyPartDocument(), sketch = initial.sketches[0], coefficient = { id: 'coefficient:1', label: '幅' };
    const formula = (source: string) => createFunctionMathSource(source, 'text', 'degree', { axes: ['X'], parameters: [], coefficients: [coefficient] }, backend);
    const curve: SketchFunctionCurveFeature = {
      id: 'function-curve', name: '関数曲線', kind: 'functionCurve', construction: false, planeId: FREE_WORK_PLANE_ID,
      definition: {
        format: FUNCTION_DEFINITION_FORMAT, tolerance: number(0.001), bounds: { X: { min: number(-1), max: number(1) }, Y: { min: number(-3), max: number(3) }, Z: { min: number(-1), max: number(1) } },
        formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: formula('coef("幅")*X'), Z: formula('0') } }
      }
    };
    const document = { ...initial, parameters: [{ name: '幅', mathId: coefficient.id, unit: 'none' as const, value: number(1), description: '' }], sketches: [{ ...sketch, features: [curve] }] };
    const before = JSON.stringify(document), snapshot = createScriptSnapshot(document, 'source', 'mm');
    const commands: ScriptCommand[] = [{ kind: 'parameter.set', resultId: null, fields: { name: '幅', source: '2', unit: 'none' }, callStack: 'at <eval> (user-script.js:1:1)' },
    { kind: 'solid.box', resultId: 'commands:1', fields: { origin: ['0', '0', '0'], axis: 'z', x: '1', y: '1', z: '1' }, callStack: 'at <eval> (user-script.js:2:1)' }];
    const input = {
      requestId: 'script-functions', document, commands, references: snapshot.references, commandNamespace: 'commands', lengthUnit: 'mm' as const,
      sources: new Map([['user-script.js', 'cad.parameters.set("幅","2");\ncad.solid.box({x:"1",y:"1",z:"1"});']]), importedShapes: new Map()
    };
    const missing = await prepareScriptTransaction(input, bridge, () => false);
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(document)).toBe(before);
    const ready = await prepareScriptTransaction(input, bridge, () => false, undefined, calculate);
    expect(ready.ok, JSON.stringify(ready)).toBe(true);
    if (!ready.ok)
      throw new Error(ready.error.message);
    try {
      expect(ready.prepared.document.parameters[0]).toMatchObject({ mathId: coefficient.id, value: { source: '2', value: 2 } });
      expect(ready.prepared.result.errors).toEqual([]);
      expect(ready.prepared.result.bodies[0].volume).toBeCloseTo(1, 6);
      const curves = ready.prepared.result.sketches[0].resolved.splines;
      expect(curves).toHaveLength(1);
      for (const [x, y, z] of curves[0].points) {
        expect(y).toBeCloseTo(2 * x, 5);
        expect(z).toBeCloseTo(0, 6);
      }
      expect(JSON.stringify(document)).toBe(before);
    }
    finally {
      await ready.prepared.release();
    }
  }, 30000);
});
