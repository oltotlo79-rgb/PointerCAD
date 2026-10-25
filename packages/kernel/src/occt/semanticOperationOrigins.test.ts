import { beforeAll, describe, expect, it } from 'vitest';
import type { CurrentOriginIndex } from '../subShapeOrigin.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePrimitive } from './makePrimitive.js';
import { measureVolume } from './solidMesh.js';
import { extractSubShapeHistory, type SubShapeHistoryEntry } from './subShapeHistory.js';
import { semanticOperationOrigins } from './semanticOperationOrigins.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

const source: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [{
  origin: { version: 1, shapeKind: 'edge', identity: {
    kind: 'box-edge', featureId: 'box', role: 'front-left',
  } }, state: 'unique', current: { kind: 'edge', index: 0 },
}] };
const history: readonly SubShapeHistoryEntry[] = [{ sourceId: 'target', input: { kind: 'edge', index: 0 },
  modified: [], generated: [{ kind: 'face', index: 2 }], deleted: true, unchanged: null }];

describe('semanticOperationOrigins', () => {
  it.each(['union', 'difference', 'intersection'] as const)(
    '実異径円筒%sのGeneratedを旧8起点やblend新面へ昇格しない', operation => {
      const owned = createAllocations();
      try {
        const target = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
          shape: { kind: 'cylinder', radius: 5, height: 20 }, originQuery: null, targetKey: null }, 'target-cylinder'));
        const tool = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 10], axis: [0, 0, 1],
          shape: { kind: 'cylinder', radius: 3, height: 20 }, originQuery: null, targetKey: null }, 'tool-cylinder'));
        if (target.origins?.state !== 'tracked' || tool.origins?.state !== 'tracked') {
          throw new Error('native cylinder origins required');
        }
        const maker = operation === 'union' ? owned.keep(new oc.BRepAlgoAPI_Fuse_1())
          : operation === 'difference' ? owned.keep(new oc.BRepAlgoAPI_Cut_1())
            : owned.keep(new oc.BRepAlgoAPI_Common_1());
        const argumentsList = owned.keep(new oc.TopTools_ListOfShape_1());
        const tools = owned.keep(new oc.TopTools_ListOfShape_1());
        owned.keep(argumentsList.Append_1(target.shape)); owned.keep(tools.Append_1(tool.shape));
        maker.SetArguments(argumentsList); maker.SetTools(tools); maker.SetNonDestructive(true);
        maker.Build(owned.keep(new oc.Message_ProgressRange_1()));
        if (!maker.IsDone() || maker.HasErrors()) throw new Error('real cylinder Boolean failed');
        const output = owned.keep(maker.Shape());
        expect(measureVolume(oc, output)).toBeCloseTo(Math.PI * (operation === 'union' ? 590
          : operation === 'difference' ? 410 : 90), 6);
        const sources = [{ sourceId: 'target', shape: target.shape, origins: target.origins },
          { sourceId: 'tool', shape: tool.shape, origins: tool.origins }];
        const raw = extractSubShapeHistory(oc, maker, sources, output);
        expect(raw).toHaveLength(16);
        expect(raw.some(entry => entry.generated.length > 0)).toBe(true);
        const result = semanticOperationOrigins('cylinder-boolean', sources.map(input =>
          ({ sourceId: input.sourceId, origins: input.origins })), raw);
        expect(result.state).toBe('tracked');
        if (result.state !== 'tracked') throw new Error('native semantic table required');
        expect(result.bindings).toHaveLength(16);
        expect(result.bindings.every(binding => binding.origin.identity.featureId !== 'cylinder-boolean')).toBe(true);
        const carried = new Set(raw.flatMap(entry => [...entry.modified,
          ...(entry.unchanged === null ? [] : [entry.unchanged])].map(address => `${address.kind}:${address.index}`)));
        const generatedOnly = new Set(raw.flatMap(entry => entry.generated.map(address => `${address.kind}:${address.index}`))
          .filter(address => !carried.has(address)));
        for (const binding of result.bindings) {
          const addresses = binding.state === 'split' ? binding.candidates
            : binding.state === 'unique' || binding.state === 'merged' ? [binding.current] : [];
          expect(addresses.every(address => !generatedOnly.has(`${address.kind}:${address.index}`))).toBe(true);
        }
        console.info('CYLINDER_NATIVE_SEMANTIC', JSON.stringify({ operation, raw: raw.length,
          generatedOnly: generatedOnly.size, states: result.bindings.map(binding => binding.state) }));
      } finally { owned.release(); }
    });

  it('names a new face from Generated without treating Generated as the old edge continuation', () => {
    const result = semanticOperationOrigins('fillet', [{ sourceId: 'target', origins: source }], history,
      { operation: 'fillet', selectedEdgeIndices: [0] });
    expect(result.state).toBe('tracked');
    if (result.state !== 'tracked') return;
    expect(result.bindings[0]).toMatchObject({ state: 'missing', reason: 'deleted' });
    expect(result.bindings[1]).toMatchObject({ state: 'unique', current: { kind: 'face', index: 2 },
      origin: { identity: { kind: 'blend-face', featureId: 'fillet', operation: 'fillet',
        source: { kind: 'box-edge', featureId: 'box', role: 'front-left' } } } });
  });

  it('does not name a face when the selected input edge is already ambiguous', () => {
    if (source.state !== 'tracked') throw new Error('fixture');
    const split: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [{
      ...source.bindings[0], state: 'split', candidates: [
        { kind: 'edge', index: 0 }, { kind: 'edge', index: 1 },
      ],
    }] };
    const result = semanticOperationOrigins('chamfer', [{ sourceId: 'target', origins: split }], history,
      { operation: 'chamfer', selectedEdgeIndices: [0] });
    expect(result.state).toBe('tracked');
    if (result.state === 'tracked') expect(result.bindings.some((binding) =>
      binding.origin.identity.kind === 'blend-face')).toBe(false);
  });
});


describe('blend new claims and native unnamed boundary', () => {
  it('refuses two selected semantic producers that Generate the same face', () => {
    if (source.state !== 'tracked') throw new Error('fixture');
    const second = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'other', role: 'front-left' } } as const;
    const inputs: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [...source.bindings,
      { origin: second, state: 'unique', current: { kind: 'edge', index: 1 } }] };
    const result = semanticOperationOrigins('blend', [{ sourceId: 'target', origins: inputs }], [...history,
      { sourceId: 'target', input: { kind: 'edge', index: 1 }, modified: [],
        generated: [{ kind: 'face', index: 2 }], deleted: true, unchanged: null }],
    { operation: 'fillet', selectedEdgeIndices: [0, 1] });
    if (result.state !== 'tracked') throw new Error('tracked fixture');
    const faces = result.bindings.filter(binding => binding.origin.identity.kind === 'blend-face');
    expect(faces).toHaveLength(2);
    expect(faces.every(binding => binding.state === 'untracked' && binding.reason === 'missing-native-map')).toBe(true);
  });
  it('proves a single new face from an eligible unnamed selected edge without inventing semantic origin', () => {
    const input: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [], fingerprintFallback: [
      { current: { kind: 'edge', index: 0 }, reason: 'imported' },
    ] };
    const result = semanticOperationOrigins('blend', [{ sourceId: 'target', origins: input }], history,
      { operation: 'chamfer', selectedEdgeIndices: [0] });
    expect(result).toEqual({ version: 1, state: 'tracked', bindings: [], fingerprintFallback: [
      { current: { kind: 'face', index: 2 }, reason: 'imported' },
    ] });
    const splitHistory: SubShapeHistoryEntry[] = [{ sourceId: 'target', input: { kind: 'edge', index: 0 },
      modified: [], generated: [{ kind: 'face', index: 2 }, { kind: 'face', index: 3 }], deleted: true, unchanged: null }];
    expect(semanticOperationOrigins('blend', [{ sourceId: 'target', origins: input }], splitHistory,
      { operation: 'chamfer', selectedEdgeIndices: [0] })).toEqual({ version: 1, state: 'tracked', bindings: [], fingerprintFallback: [] });
  });
});
