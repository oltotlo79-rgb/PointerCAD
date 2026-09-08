import { describe, expect, it, vi } from 'vitest';
import {
  appendSolid, createAssemblyDocument, createEmptyPartDocument, createPrimitiveFeature,
  resolveAssembly, resolvePart, type AssemblyInterferenceInput, type InterferenceKernelBridge,
  type MeasureOutcome,
} from '@pointercad/model';
import { measureAssemblyGap } from './interferenceActions.js';

function input(): AssemblyInterferenceInput {
  const empty = createEmptyPartDocument();
  const partDocument = appendSolid(
    empty,
    createPrimitiveFeature(empty, 'box'),
  );
  const part = resolvePart(partDocument);
  const document = createAssemblyDocument('組');
  return {
    requestId: 'gap-1',
    components: [],
    resolved: {
      ...resolveAssembly(document),
      parts: new Map([['part-a', part], ['part-b', part]]),
      partKeys: new Map([['a', 'part-a'], ['b', 'part-b']]),
      placements: new Map([
        ['a', { position: [0, 0, 0], rotation: [0, 0, 0, 1] }],
        ['b', { position: [50, 0, 0], rotation: [0, 0, 0, 1] }],
      ]),
    },
    bodies: new Map(),
    placements: new Map([
      ['a', { position: [0, 0, 0], rotation: [0, 0, 0, 1] }],
      ['b', { position: [50, 0, 0], rotation: [0, 0, 0, 1] }],
    ]),
  };
}

function bridgeWith(results: readonly MeasureOutcome[]) {
  let index = 0;
  const measure = vi.fn<InterferenceKernelBridge['measure']>(() => {
    const result = results[index++] ?? results.at(-1);
    return Promise.resolve(result ?? { kind: 'failed', message: '検査データが足りません。' });
  });
  return { measure };
}

describe('P7-26 アセンブリの隙間', () => {
  it('明示したbody keyと表示中の2配置を既存measureへ渡す', async () => {
    const bridge = bridgeWith([{ kind: 'distance', distance: 30,
      pointA: [20, 0, 0], pointB: [50, 0, 0], inner: false }]);
    const measured = await measureAssemblyGap(bridge, input(), 'a', 'b', 'mm');
    expect(measured?.result.value).toBe(30);
    expect(measured?.text).toContain('30');
    expect(bridge.measure).toHaveBeenCalledOnce();
    const call = bridge.measure.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    const [, targets, kind] = call;
    expect(kind).toBe('distance');
    expect(targets).toHaveLength(2);
    expect(typeof targets[0]?.bodyKey).toBe('string');
    expect(targets[0]?.placement?.position).toEqual([0, 0, 0]);
    expect(typeof targets[1]?.bodyKey).toBe('string');
    expect(targets[1]?.placement?.position).toEqual([50, 0, 0]);
  });

  it('食い込んだ組は0を返す', async () => {
    const bridge = bridgeWith([{ kind: 'distance', distance: 0,
      pointA: [15, 0, 0], pointB: [15, 0, 0], inner: true }]);
    expect((await measureAssemblyGap(bridge, input(), 'a', 'b', 'mm'))?.result.value).toBe(0);
  });

  it('一方でも測れなければ過大な隙間を表示しない', async () => {
    const bridge = bridgeWith([{ kind: 'failed', message: '測れない' }]);
    expect(await measureAssemblyGap(bridge, input(), 'a', 'b', 'mm')).toBeNull();
  });

  it('同じ部品または解決できない部品はkernelを呼ばない', async () => {
    const bridge = bridgeWith([{ kind: 'distance', distance: 1,
      pointA: [0, 0, 0], pointB: [1, 0, 0], inner: false }]);
    expect(await measureAssemblyGap(bridge, input(), 'a', 'a', 'mm')).toBeNull();
    expect(await measureAssemblyGap(bridge, input(), 'a', 'missing', 'mm')).toBeNull();
    expect(bridge.measure).not.toHaveBeenCalled();
  });
});
