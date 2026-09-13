import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import { createMathBackend, createFunctionMathSource, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { FUNCTION_DEFINITION_FORMAT } from '../functionGeometry/functionDefinitionTypes.js';
import { prepareScriptCommands } from './scriptCommands.js';
import { createScriptSnapshot } from './scriptSnapshot.js';
import type { ScriptFunctionCompiler } from './scriptFunctionCommands.js';
import type { ScriptFunctionDefinition } from './scriptFunctionInput.js';
import type { ScriptCommand } from './scriptTypes.js';
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const definition: ScriptFunctionDefinition = {
  angleUnit: 'degree', bounds: { X: ['-2', '2'], Y: ['-2', '2'], Z: ['-2', '2'] },
  tolerance: '0.01', formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: 'X', Z: '0' } }
};
const callStack = 'at <eval> (user-script.js:1:1)', sources = new Map([['user-script.js', 'cad.sketch.create("関数");']]);
const commands: ScriptCommand[] = [
  { kind: 'parameter.set', resultId: null, callStack, fields: { name: '係数', source: '2', unit: 'none' } },
  { kind: 'sketch.create', resultId: 'run:1', callStack, fields: { name: '関数', plane: 'xy' } },
  { kind: 'function.curve', resultId: 'run:2', callStack, fields: { sketch: 'run:1', definition } },
];
const compile: ScriptFunctionCompiler = document => {
  const source = (text: string) => createFunctionMathSource(text, 'text', 'degree', { axes: ['X'], parameters: [], coefficients: [] }, backend);
  const range = { min: number(-2), max: number(2) };
  return Promise.resolve({
    document, definition: {
      format: FUNCTION_DEFINITION_FORMAT, bounds: { X: range, Y: range, Z: range }, tolerance: number(0.01),
      formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: source('X'), Z: source('0') } }
    }
  });
};
describe('関数の非同期計算を自動作図の文書順序と中止へつなぐ', () => {
  it('直前の係数変更・新規スケッチを渡し、元文書を変更しない', async () => {
    const document = createEmptyPartDocument(), before = JSON.stringify(document), seen = vi.fn(compile);
    const result = await prepareScriptCommands([document, commands, new Map(), 'run', 'mm', sources], seen, () => false);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(result.error.message);
    const prepared = seen.mock.calls[0][0];
    expect(prepared.parameters[0]).toMatchObject({ name: '係数', value: { value: 2 } });
    expect(prepared.sketches.at(-1)).toMatchObject({ id: 'run:1', name: '関数' });
    expect(result.document.sketches.at(-1)?.features[0]).toMatchObject({ kind: 'functionCurve', id: 'run:2' });
    const snapshot = createScriptSnapshot(result.document, 'next-execution', 'mm');
    expect([...snapshot.references.values()]).toContainEqual(expect.objectContaining({ kind: 'edge', featureId: 'run:2', sketchId: 'run:1' }));
    expect(result.locations.get('run:2')).toBe(callStack);
    expect(JSON.stringify(document)).toBe(before);
  });
  it('未来のスケッチ参照は数学計算開始前に拒否する', async () => {
    const seen = vi.fn(compile), curve: ScriptCommand = { kind: 'function.curve', resultId: 'run:1', callStack, fields: { sketch: 'run:2', definition } };
    const result = await prepareScriptCommands([createEmptyPartDocument(), [curve], new Map(), 'run', 'mm', sources], seen, () => false);
    expect(result.ok).toBe(false);
    expect(seen).not.toHaveBeenCalled();
    expect('document' in result).toBe(false);
  });
  it('数学計算中の中止では、先に用意した係数やスケッチも返さない', async () => {
    const document = createEmptyPartDocument(), before = JSON.stringify(document);
    let cancelled = false;
    const result = await prepareScriptCommands([document, commands, new Map(), 'run', 'mm', sources], async (...args) => {
      const ready = await compile(...args);
      cancelled = true;
      return ready;
    }, () => cancelled);
    expect(result).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect('document' in result).toBe(false);
    expect(JSON.stringify(document)).toBe(before);
  });
  it('数式の不成立や別文書の返却でも部分的な結果を渡さない', async () => {
    const document = createEmptyPartDocument();
    for (const compiler of [
      () => Promise.reject(new Error('Zの範囲を指定してください。')),
      async (...args: Parameters<ScriptFunctionCompiler>) => ({ ...await compile(...args), document: createEmptyPartDocument() }),
    ]) {
      const result = await prepareScriptCommands([document, commands, new Map(), 'run', 'mm', sources], compiler, () => false);
      expect(result.ok).toBe(false);
      expect('document' in result).toBe(false);
    }
    expect(document.parameters).toEqual([]);
  });
});
