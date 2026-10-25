import { beforeAll, describe, expect, it } from 'vitest';
import type { BRepBuilderAPI_MakeShape, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { CurrentOriginIndex, ShapeAddress, SubShapeOrigin } from '../subShapeOrigin.js';
import { createAllocations, type Allocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { edgeAt } from './subShapes.js';
import { isFilletShape } from './makeFillet.js';
import { makePrimitive } from './makePrimitive.js';
import { measureVolume } from './solidMesh.js';
import { boxSubShapeOrigins, rebindCopiedBoxOrigins } from './subShapeOrigins.js';
import { extractSubShapeHistory, type SubShapeHistoryEntry } from './subShapeHistory.js';
import { composeSubShapeOrigins, lookupSubShapeOrigin, withinOriginLimits } from './composeSubShapeOrigins.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

const address = (index: number): ShapeAddress => ({ kind: 'face', index });
const origin = (featureId: string, role: 'top' | 'bottom' = 'top'): SubShapeOrigin =>
  ({ version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId, role } });
const tracked = (...entries: readonly [SubShapeOrigin, number][]): CurrentOriginIndex => ({
  version: 1, state: 'tracked', bindings: entries.map(([identity, index]) =>
    ({ origin: identity, state: 'unique', current: address(index) })),
});
const history = (sourceId: string, input: number, modified: number[],
  generated: number[] = [], deleted = false, unchanged: number | null = null): SubShapeHistoryEntry => ({
  sourceId, input: address(input), modified: modified.map(address), generated: generated.map(address),
  deleted, unchanged: unchanged === null ? null : address(unchanged),
});

describe('native unnamed region composition', () => {
  const unnamed: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [],
    fingerprintFallback: [{ current: address(0), reason: 'imported' }] };
  it('continues Modified but refuses Generated, split and independent merged proofs', () => {
    const run = (rows: readonly SubShapeHistoryEntry[]) => composeSubShapeOrigins({ featureId: 'next',
      inputs: [{ sourceId: 'a', origins: unnamed }] }, rows);
    expect(run([history('a', 0, [7], [8])])).toMatchObject({ fingerprintFallback: [
      { current: address(7), reason: 'imported' },
    ] });
    expect(run([history('a', 0, [], [7], true)])).toMatchObject({ fingerprintFallback: [] });
    expect(run([history('a', 0, [7, 8])])).toMatchObject({ fingerprintFallback: [] });
    const inputs = [{ sourceId: 'a', origins: unnamed }, { sourceId: 'b', origins: unnamed }];
    expect(composeSubShapeOrigins({ featureId: 'next', inputs }, [history('a', 0, [7]), history('b', 0, [7])]))
      .toMatchObject({ fingerprintFallback: [] });
  });
  it.each([false, true])('keeps alias split conflict in either input order (%s)', reverse => {
    const inputs = [{ sourceId: 'a', origins: unnamed }, { sourceId: 'b', aliasOf: 'a', origins: unnamed }];
    const rows = [history('a', 0, [7, 8]), history('b', 0, [7])];
    expect(composeSubShapeOrigins({ featureId: 'next', inputs: reverse ? [...inputs].reverse() : inputs }, rows))
      .toEqual({ version: 1, state: 'tracked', bindings: [], fingerprintFallback: [] });
    expect(composeSubShapeOrigins({ featureId: 'next', inputs }, [history('a', 0, [7]), history('b', 0, [7])]))
      .toMatchObject({ fingerprintFallback: [{ current: address(7), reason: 'imported' }] });
  });
  it('excludes an address claimed by semantic history and never rescues a foreign origin', () => {
    const result = composeSubShapeOrigins({ featureId: 'next', inputs: [
      { sourceId: 'a', origins: unnamed }, { sourceId: 'b', origins: tracked([origin('box'), 0]) },
    ] }, [history('a', 0, [7]), history('b', 0, [7])]);
    expect(result).toMatchObject({ fingerprintFallback: [] });
    expect(lookupSubShapeOrigin(result, origin('box'))).toEqual({ status: 'matched', address: address(7), basis: 'semantic' });
    expect(lookupSubShapeOrigin(result, origin('foreign'))).toMatchObject({ status: 'missing' });
  });
});

describe('native履歴からの純合成', () => {
  it.each(['union', 'difference', 'intersection'] as const)(
    '実異径円筒%sの全16起点をnative履歴で合成しGeneratedを旧起点にしない', operation => {
      const owned = createAllocations();
      try {
        const target = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
          shape: { kind: 'cylinder', radius: 5, height: 20 }, originQuery: null, targetKey: null }, 'target-cylinder'));
        const tool = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 10], axis: [0, 0, 1],
          shape: { kind: 'cylinder', radius: 3, height: 20 }, originQuery: null, targetKey: null }, 'tool-cylinder'));
        if (target.origins?.state !== 'tracked' || tool.origins?.state !== 'tracked') {
          throw new Error('native cylinder origins required');
        }
        expect(target.origins.bindings).toHaveLength(8);
        expect(tool.origins.bindings).toHaveLength(8);
        const builder = operation === 'union' ? owned.keep(new oc.BRepAlgoAPI_Fuse_1())
          : operation === 'difference' ? owned.keep(new oc.BRepAlgoAPI_Cut_1())
            : owned.keep(new oc.BRepAlgoAPI_Common_1());
        const argumentsList = owned.keep(new oc.TopTools_ListOfShape_1());
        const tools = owned.keep(new oc.TopTools_ListOfShape_1());
        owned.keep(argumentsList.Append_1(target.shape)); owned.keep(tools.Append_1(tool.shape));
        builder.SetArguments(argumentsList); builder.SetTools(tools); builder.SetNonDestructive(true);
        builder.Build(owned.keep(new oc.Message_ProgressRange_1()));
        if (!builder.IsDone() || builder.HasErrors()) throw new Error('real cylinder Boolean failed');
        const output = owned.keep(builder.Shape());
        expect(measureVolume(oc, output)).toBeCloseTo(Math.PI * (operation === 'union' ? 590
          : operation === 'difference' ? 410 : 90), 6);
        const inputs = [{ sourceId: 'target', shape: target.shape, origins: target.origins },
          { sourceId: 'tool', shape: tool.shape, origins: tool.origins }];
        const raw = extractSubShapeHistory(oc, builder, inputs, output);
        expect(raw).toHaveLength(16);
        const composed = composeSubShapeOrigins({ featureId: 'cylinder-boolean', inputs: inputs.map(input =>
          ({ sourceId: input.sourceId, origins: input.origins })) }, raw);
        expect(composed.state).toBe('tracked');
        if (composed.state !== 'tracked') throw new Error('native cylinder composition required');
        expect(composed.bindings).toHaveLength(16);
        expect(composed.bindings.every(binding => binding.origin.identity.featureId !== 'cylinder-boolean')).toBe(true);
        for (const input of inputs) for (const binding of input.origins.bindings) {
          if (binding.state !== 'unique') throw new Error('native cylinder input must be unique');
          const entry = raw.find(row => row.sourceId === input.sourceId
            && row.input.kind === binding.current.kind && row.input.index === binding.current.index);
          if (entry === undefined) throw new Error('native source history missing');
          const looked = lookupSubShapeOrigin(composed, binding.origin);
          const candidates = new Set([...entry.modified,
            ...(entry.unchanged === null ? [] : [entry.unchanged])]
            .map(address => `${address.kind}:${address.index}`));
          const shared = raw.some(other => other !== entry && [...other.modified,
            ...(other.unchanged === null ? [] : [other.unchanged])]
            .some(address => candidates.has(`${address.kind}:${address.index}`)));
          if (candidates.size === 0) expect(looked.status).toBe('missing');
          else if (candidates.size > 1) expect(looked).toMatchObject({ status: 'ambiguous', reason: 'split' });
          else if (shared) expect(looked).toMatchObject({ status: 'ambiguous', reason: 'merged' });
          else expect(looked.status).toBe('matched');
          if (looked.status === 'matched') {
            expect(looked.address.kind).toBe(binding.current.kind);
            expect([...entry.modified, ...(entry.unchanged === null ? [] : [entry.unchanged])])
              .toContainEqual(looked.address);
          }
        }
        console.info('CYLINDER_NATIVE_COMPOSE', JSON.stringify({ operation, raw: raw.length,
          states: composed.bindings.map(binding => binding.state) }));
      } finally { owned.release(); }
    });

  it.each(['union', 'difference', 'intersection', 'fillet', 'chamfer'] as const)(
    '実%s履歴を各保存Box originから合成し、Generatedだけを旧originにしない', operation => {
      const owned: Allocations = createAllocations();
      try {
        const firstPoint = owned.keep(new oc.gp_Pnt_3(0, 0, 0));
        const firstMaker = owned.keep(new oc.BRepPrimAPI_MakeBox_3(firstPoint, 20, 20, 20));
        const firstBox = owned.keep(firstMaker.Shape());
        const firstOrigins = boxSubShapeOrigins(oc, firstMaker, firstBox, 'saved-target');
        expect(firstOrigins.state).toBe('tracked');
        let builder: BRepBuilderAPI_MakeShape;
        let inputs: { sourceId: string; shape: TopoDS_Shape; origins: CurrentOriginIndex }[];
        if (operation === 'fillet' || operation === 'chamfer') {
          const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(firstBox, true, true));
          const copied = owned.keep(copier.Shape());
          const copiedOrigins = rebindCopiedBoxOrigins(oc, firstOrigins, firstBox, copier, copied, 'saved-target');
          expect(copiedOrigins.state).toBe('tracked');
          const edge = edgeAt(oc, copied, 0);
          if (edge === null) throw new Error('real edge required');
          owned.keep(edge);
          const style = oc.ChFi3d_FilletShape.ChFi3d_Rational;
          if (!isFilletShape(style)) throw new Error('real fillet style required');
          const maker = operation === 'fillet' ? owned.keep(new oc.BRepFilletAPI_MakeFillet(copied, style))
            : owned.keep(new oc.BRepFilletAPI_MakeChamfer(copied));
          maker.Add_2(2, edge);
          builder = maker;
          inputs = [{ sourceId: 'target', shape: copied, origins: copiedOrigins }];
        } else {
          const toolPoint = owned.keep(new oc.gp_Pnt_3(10, 10, 10));
          const toolMaker = owned.keep(new oc.BRepPrimAPI_MakeBox_3(toolPoint, 20, 20, 20));
          const toolBox = owned.keep(toolMaker.Shape());
          const toolOrigins = boxSubShapeOrigins(oc, toolMaker, toolBox, 'saved-tool');
          const maker = operation === 'union' ? owned.keep(new oc.BRepAlgoAPI_Fuse_1())
            : operation === 'difference' ? owned.keep(new oc.BRepAlgoAPI_Cut_1())
              : owned.keep(new oc.BRepAlgoAPI_Common_1());
          const argumentsList = owned.keep(new oc.TopTools_ListOfShape_1());
          const tools = owned.keep(new oc.TopTools_ListOfShape_1());
          owned.keep(argumentsList.Append_1(firstBox)); owned.keep(tools.Append_1(toolBox));
          maker.SetArguments(argumentsList); maker.SetTools(tools); maker.SetNonDestructive(true);
          builder = maker;
          inputs = [{ sourceId: 'target', shape: firstBox, origins: firstOrigins },
            { sourceId: 'tool', shape: toolBox, origins: toolOrigins }];
        }
        const range = owned.keep(new oc.Message_ProgressRange_1());
        builder.Build(range);
        if (!builder.IsDone()) throw new Error('real operation failed');
        const output = owned.keep(builder.Shape());
        const expectedVolume = operation === 'union' ? 15000 : operation === 'difference' ? 7000
          : operation === 'intersection' ? 1000 : operation === 'chamfer' ? 7960 : 8000 - 20 * (4 - Math.PI);
        expect(measureVolume(oc, output)).toBeCloseTo(expectedVolume, 6);
        const raw = extractSubShapeHistory(oc, builder, inputs, output);
        const result = composeSubShapeOrigins({ featureId: 'operation', inputs: inputs.map(input =>
          ({ sourceId: input.sourceId, origins: input.origins })) }, raw);
        expect(result.state).toBe('tracked');
        if (result.state !== 'tracked') return;
        expect(result.bindings).toHaveLength(inputs.length * 26);
        expect(result.bindings.every(binding => binding.origin.identity.featureId !== 'operation')).toBe(true);
        expect(result.bindings.some(binding => binding.state === 'unique')).toBe(true);
        for (const input of inputs) {
          if (input.origins.state !== 'tracked') continue;
          for (const binding of input.origins.bindings) {
            if (binding.state !== 'unique') continue;
            const source = raw.find(entry => entry.sourceId === input.sourceId
              && entry.input.kind === binding.current.kind && entry.input.index === binding.current.index);
            if (source !== undefined && source.modified.length === 0 && source.unchanged === null) {
              expect(lookupSubShapeOrigin(result, binding.origin).status).not.toBe('matched');
            }
          }
        }
        console.info('OCCT_ORIGIN_COMPOSE_PROOF', JSON.stringify({ operation, volume: measureVolume(oc, output),
          bindings: result.bindings.length, states: result.bindings.reduce<Record<string, number>>((counts, binding) => {
            counts[binding.state] = (counts[binding.state] ?? 0) + 1; return counts;
          }, {}) }));
      } finally { owned.release(); }
    });

  it('Modifiedとunchangedを同kind和集合し、Generatedは継続としない', () => {
    const id = origin('saved');
    const inputs = [{ sourceId: 'source', origins: tracked([id, 0]) }];
    const unique = composeSubShapeOrigins({ featureId: 'operation', inputs },
      [history('source', 0, [3], [7], true, 3)]);
    expect(lookupSubShapeOrigin(unique, id)).toEqual({ status: 'matched', address: address(3), basis: 'semantic' });
    const split = composeSubShapeOrigins({ featureId: 'operation', inputs },
      [history('source', 0, [3, 4], [7])]);
    expect(lookupSubShapeOrigin(split, id)).toEqual({ status: 'ambiguous', reason: 'split',
      candidates: [address(3), address(4)] });
    const onlyGenerated = composeSubShapeOrigins({ featureId: 'operation', inputs },
      [history('source', 0, [], [7], true)]);
    expect(lookupSubShapeOrigin(onlyGenerated, id)).toEqual({ status: 'missing', reason: 'deleted' });
  });

  it('独立sourceの合流は全originを残し、明示aliasは二重計数しない', () => {
    const first = origin('first'), second = origin('second');
    const merged = composeSubShapeOrigins({ featureId: 'op', inputs: [
      { sourceId: 'left', origins: tracked([first, 0]) },
      { sourceId: 'right', origins: tracked([second, 0]) },
    ] }, [history('left', 0, [5]), history('right', 0, [5])]);
    expect(lookupSubShapeOrigin(merged, first)).toEqual({ status: 'ambiguous', reason: 'merged', candidates: [address(5)] });
    if (merged.state !== 'tracked') throw new Error('expected tracked merged table');
    expect(merged.bindings.every(binding => binding.state === 'merged'
      && binding.coOrigins.some(item => JSON.stringify(item) === JSON.stringify(second)))).toBe(true);
    const continuedMerge = composeSubShapeOrigins({ featureId: 'next', inputs: [
      { sourceId: 'merged', origins: merged },
    ] }, [history('merged', 5, [9])]);
    expect(lookupSubShapeOrigin(continuedMerge, first)).toEqual(
      { status: 'ambiguous', reason: 'merged', candidates: [address(9)] });
    const alias = composeSubShapeOrigins({ featureId: 'op', inputs: [
      { sourceId: 'left', aliasOf: 'same', origins: tracked([first, 0]) },
      { sourceId: 'right', aliasOf: 'same', origins: tracked([first, 0]) },
    ] }, [history('left', 0, [5]), history('right', 0, [5])]);
    expect(alias.state).toBe('tracked');
    if (alias.state === 'tracked') {
      expect(alias.bindings).toHaveLength(1);
      expect(alias.bindings.every(binding => binding.state === 'unique')).toBe(true);
    }
    expect(lookupSubShapeOrigin(alias, first)).toEqual({ status: 'matched', address: address(5), basis: 'semantic' });
    const reordered: SubShapeOrigin = { identity: { role: 'top', featureId: 'first', kind: 'box-face' },
      shapeKind: 'face', version: 1 };
    expect(lookupSubShapeOrigin(alias, reordered)).toEqual({ status: 'matched', address: address(5), basis: 'semantic' });
  });

  it('split後の再合流、元からのmissing、履歴欠落、上限をuniqueへ変えない', () => {
    const id = origin('saved');
    const first = composeSubShapeOrigins({ featureId: 'first', inputs: [
      { sourceId: 'input', origins: tracked([id, 0]) },
    ] }, [history('input', 0, [1, 2])]);
    const second = composeSubShapeOrigins({ featureId: 'second', inputs: [
      { sourceId: 'input', origins: first },
    ] }, [history('input', 1, [4]), history('input', 2, [4])]);
    expect(lookupSubShapeOrigin(second, id).status).toBe('ambiguous');
    const missing = composeSubShapeOrigins({ featureId: 'op', inputs: [
      { sourceId: 'input', origins: tracked([id, 0]) },
    ] }, []);
    expect(lookupSubShapeOrigin(missing, id)).toEqual({ status: 'missing', reason: 'history-missing' });
    const tooLong = origin('x'.repeat(257));
    expect(withinOriginLimits(tooLong)).toBe(false);
    expect(composeSubShapeOrigins({ featureId: 'op', inputs: [
      { sourceId: 'input', origins: tracked([id, 0], [tooLong, 1]) },
    ] }, [history('input', 0, [3]), history('input', 1, [4])])).toEqual(
      { version: 1, state: 'untracked', reason: 'limit' });
  });
});


describe('anonymous alias proof loss', () => {
  const unnamed: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [],
    fingerprintFallback: [{ current: address(0), reason: 'legacy' }] };
  it.each([false, true])('refuses a missing alias history row in either input order (%s)', reverse => {
    const inputs = [{ sourceId: 'a', origins: unnamed }, { sourceId: 'b', aliasOf: 'a', origins: unnamed }];
    expect(composeSubShapeOrigins({ featureId: 'next', inputs: reverse ? [...inputs].reverse() : inputs },
      [history('b', 0, [7])])).toEqual({ version: 1, state: 'tracked', bindings: [], fingerprintFallback: [] });
  });
  it.each([false, true])('refuses contradictory duplicate native history rows in either row order (%s)', reverse => {
    const rows = [history('a', 0, [7]), history('a', 0, [8])];
    expect(composeSubShapeOrigins({ featureId: 'next', inputs: [{ sourceId: 'a', origins: unnamed }] },
      reverse ? [...rows].reverse() : rows)).toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
  });
});
