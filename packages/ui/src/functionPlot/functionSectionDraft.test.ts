import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, createFunctionSurface, FUNCTION_DEFINITION_FORMAT, type FunctionDefinition } from '@pointercad/model';
import { createFunctionMathSource, createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { commitFunctionSection, prepareFunctionSection } from './functionSectionDraft.js';
import { readFunctionSection } from './functionSectionEdit.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const client: Pick<MathWorkerClient, 'evaluate'> = { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
  result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() }).result }) };
function fixture() {
  const base = createEmptyPartDocument(), definition: FunctionDefinition = { format: FUNCTION_DEFINITION_FORMAT,
    bounds: { X: { min: number(-2), max: number(2) }, Y: { min: number(-2), max: number(2) }, Z: { min: number(-2), max: number(2) } },
    tolerance: number(0.01), formula: { kind: 'coordinate-surface', output: 'Z',
      expression: createFunctionMathSource('X+Y', 'text', 'degree', { axes: ['X', 'Y'], parameters: [], coefficients: [] }, backend) } };
  const feature = createFunctionSurface(base, definition);
  return { document: appendSolid(base, feature), parentId: feature.id };
}

describe('関数曲面を座標で切る断面線', () => {
  it('Y座標の再編集も正の座標で読み取り、同じ平面と断面を更新する', () => {
    const input = fixture(), first = commitFunctionSection(input.document, input.parentId, 'Y', number(0.25));
    const address = { sketchId: first.document.activeSketchId, featureId: first.sectionId };
    expect(readFunctionSection(first.document, address)).toMatchObject({ axis: 'Y', coordinate: { source: '0.25', value: 0.25 } });
    const edited = commitFunctionSection(first.document, input.parentId, 'Y', number(-0.25), address);
    expect(edited.planeId).toBe(first.planeId); expect(edited.sectionId).toBe(first.sectionId);
    expect(edited.document.sketches).toEqual(first.document.sketches);
    expect(edited.document.references).toHaveLength(first.document.references.length);
    expect(readFunctionSection(edited.document, address)).toMatchObject({ axis: 'Y', coordinate: { value: -0.25 } });
    expect(readFunctionSection(first.document, address)).toMatchObject({ coordinate: { value: 0.25 } });
    expect(() => commitFunctionSection(first.document, input.parentId, 'X', number(0), { ...address, sketchId: 'missing' })).toThrow('断面');
  });
  it.each(['X', 'Y', 'Z'] as const)('%s=1の平面を正しい向きで作り、親への参照を保つ', axis => {
    const input = fixture(), before = JSON.stringify(input.document);
    const outcome = commitFunctionSection(input.document, input.parentId, axis, number(1));
    const plane = outcome.document.references.find(feature => feature.id === outcome.planeId);
    expect(plane).toMatchObject({ kind: 'referencePlane', visible: false, plane: { kind: 'workPlane',
      planeId: axis === 'X' ? 'yz' : axis === 'Y' ? 'xz' : 'xy', offset: { value: axis === 'Y' ? -1 : 1 } } });
    const sketch = outcome.document.sketches.find(item => item.id === outcome.document.activeSketchId);
    expect(sketch?.features).toEqual([expect.objectContaining({ id: outcome.sectionId, kind: 'planeSection',
      targetFeatureId: input.parentId, planeId: outcome.planeId })]);
    expect(JSON.stringify(input.document)).toBe(before);
    expect(outcome.document.solids).toEqual(input.document.solids);
    const again = commitFunctionSection(outcome.document, input.parentId, axis, number(0));
    expect(again.planeId).not.toBe(outcome.planeId);
    expect(again.document.activeSketchId).not.toBe(outcome.document.activeSketchId);
  });

  it('範囲外・非有限値・抑制された親は形状を追加せず断る', () => {
    const input = fixture();
    expect(() => commitFunctionSection(input.document, input.parentId, 'X', number(3))).toThrow('範囲');
    expect(() => commitFunctionSection(input.document, input.parentId, 'X', { ...number(0), value: Infinity })).toThrow('範囲');
    const suppressed = { ...input.document, solids: input.document.solids.map(feature => ({ ...feature, suppressed: true })) };
    expect(() => commitFunctionSection(suppressed, input.parentId, 'X', number(0))).toThrow();
  });

  it('度を既定として計算し、Y座標の符号を反転しても係数の構造を失わない', async () => {
    const input = fixture(), document = { ...input.document,
      parameters: [{ name: '位置', mathId: 'coefficient:1', unit: 'none' as const, description: '', value: number(1) }] };
    const result = await prepareFunctionSection(document, 1, input.parentId, 'Y', { source: 'coef("位置")*sin(30)', angleUnit: 'degree' },
      client, new AbortController().signal, () => true);
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    const plane = result.result.document.references.find(feature => feature.id === result.result.planeId);
    if (plane?.kind !== 'referencePlane' || plane.plane.kind !== 'workPlane') throw new Error('座標平面がありません');
    expect(plane.plane.offset.value).toBeCloseTo(-0.5, 12);
    expect(plane.plane.offset.mathDefinition).toBeDefined();
    expect(JSON.stringify(plane.plane.offset.mathDefinition)).toContain('coefficient:1');
    const restored = readFunctionSection(result.result.document, {
      sketchId: result.result.document.activeSketchId, featureId: result.result.sectionId,
    });
    expect(restored?.coordinate.value).toBeCloseTo(0.5, 12);
    expect(restored?.coordinate.mathDefinition?.angleUnit).toBe('degree');
    expect(restored?.coordinate.source).not.toContain('Multiply(Multiply');
  });

  it('選択した軸以外も含むXYZの全境界を再評価し、不正な範囲を受け入れない', async () => {
    const input = fixture(), document = { ...input.document, solids: input.document.solids.map(feature => feature.kind === 'functionSurface'
      ? { ...feature, definition: { ...feature.definition, bounds: { ...feature.definition.bounds, Y: { min: number(1), max: number(1) } } } } : feature) };
    expect(await prepareFunctionSection(document, 1, input.parentId, 'Z', { source: '0', angleUnit: 'degree' },
      client, new AbortController().signal, () => true)).toMatchObject({ status: 'failed' });
  });

  it('中止・文書変更後は非同期の結果を確定しない', async () => {
    const input = fixture(), abort = new AbortController(), evaluate = vi.fn(client.evaluate);
    abort.abort();
    expect(await prepareFunctionSection(input.document, 1, input.parentId, 'Z', { source: '0', angleUnit: 'degree' },
      { evaluate }, abort.signal, () => true)).toEqual({ status: 'cancelled' });
    expect(evaluate).not.toHaveBeenCalled();
    let current = true;
    const changing: Pick<MathWorkerClient, 'evaluate'> = { evaluate: async request => {
      const result = await client.evaluate(request, 5_000); current = false; return result;
    } };
    expect(await prepareFunctionSection(input.document, 1, input.parentId, 'Z', { source: '0', angleUnit: 'degree' },
      changing, new AbortController().signal, () => current)).toEqual({ status: 'cancelled' });
  });
});
