import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { resolvePart } from '../part/resolvePart.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { collectMateVariables } from './constraints/mateVariables.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { resolveAssembly, SUB_ASSEMBLY_CYCLE_MESSAGE, SUB_ASSEMBLY_DEPTH_MESSAGE } from './resolveAssembly.js';
import { detectCycle, detectSubAssemblyProblem, resolveSubAssembly } from './subAssembly.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Placement } from './types.js';

function placementAt(x: number): Placement {
  return {
    position: [expressionValueFromNumber(x), expressionValueFromNumber(0), expressionValueFromNumber(0)],
    rotation: [0, 0, 0, 1],
  };
}

function component(id: string, source: ComponentSource, placement = DEFAULT_COMPONENT_PLACEMENT): AssemblyComponent {
  return { id, name: id, source, placement, fixed: false, visible: true, suppressed: false };
}

function assembly(components: readonly AssemblyComponent[]): AssemblyDocument {
  return { ...createAssemblyDocument('組立'), components };
}

function sub(ref: string, x = 0): AssemblyComponent {
  return component('component-1', { kind: 'subAssembly', assemblyRef: ref }, placementAt(x));
}

function chain(length: number): {
  readonly root: AssemblyDocument;
  readonly documents: ReadonlyMap<string, AssemblyDocument>;
} {
  const documents = new Map<string, AssemblyDocument>();
  for (let index = 1; index <= length; index += 1) {
    const next = index === length
      ? component('component-1', { kind: 'part', partRef: 'part-1' })
      : sub(`assembly-${index + 1}`);
    documents.set(`assembly-${index}`, assembly([next]));
  }
  return { root: assembly([sub('assembly-1')]), documents };
}

describe('サブアセンブリの検査', () => {
  it('参照が無ければ循環は無い', () => {
    expect(detectCycle(assembly([]), new Map())).toBeNull();
  });

  it('自分自身を含む参照経路を返す', () => {
    const self = assembly([sub('assembly-a')]);
    expect(detectCycle(self, new Map([['assembly-a', self]]))).toEqual(['assembly-a', 'assembly-a']);
  });

  it('A→B→Aの循環を返す', () => {
    const a = assembly([sub('assembly-b')]);
    const b = assembly([sub('assembly-a')]);
    const documents = new Map([['assembly-a', a], ['assembly-b', b]]);
    expect(detectCycle(assembly([sub('assembly-a')]), documents)).toEqual([
      'assembly-a', 'assembly-b', 'assembly-a',
    ]);
  });

  it('同じ組を兄弟として2回置くことは循環にしない', () => {
    const leaf = assembly([]);
    const root = assembly([
      component('component-1', { kind: 'subAssembly', assemblyRef: 'assembly-a' }),
      component('component-2', { kind: 'subAssembly', assemblyRef: 'assembly-a' }),
    ]);
    expect(detectCycle(root, new Map([['assembly-a', leaf]]))).toBeNull();
  });

  it('深さ8は通る', () => {
    const fixture = chain(8);
    expect(detectSubAssemblyProblem(fixture.root, fixture.documents)).toBeNull();
  });

  it('深さ9は固定文言で断る', () => {
    const fixture = chain(9);
    expect(detectSubAssemblyProblem(fixture.root, fixture.documents)).toMatchObject({
      kind: 'depth', message: SUB_ASSEMBLY_DEPTH_MESSAGE,
    });
  });

  it('抑制した循環参照は無いものとして扱う', () => {
    const root = assembly([{ ...sub('assembly-a'), suppressed: true }]);
    expect(detectCycle(root, new Map([['assembly-a', root]]))).toBeNull();
  });
});

describe('サブアセンブリの再帰解決', () => {
  const emptyPart = resolvePart(createEmptyPartDocument());

  it('1段の中の部品を解決する', () => {
    const nested = assembly([component('component-1', { kind: 'part', partRef: 'part-1' })]);
    const root = assembly([sub('assembly-a')]);
    const result = resolveAssembly(root, {
      subAssemblies: new Map([['assembly-a', nested]]),
      resolvedParts: new Map([['part-1', emptyPart]]),
    });
    expect(result.subAssemblies?.get('component-1')?.resolved.parts.get('part-1')).toBe(emptyPart);
    expect(result.errors).toEqual([]);
  });

  it('親と子の配置を外から内の順で合成する', () => {
    const nested = assembly([component('component-1', { kind: 'part', partRef: 'part-1' }, placementAt(3))]);
    const result = resolveAssembly(assembly([sub('assembly-a', 7)]), {
      subAssemblies: new Map([['assembly-a', nested]]), resolvedParts: new Map([['part-1', emptyPart]]),
    });
    expect(result.subAssemblies?.get('component-1')?.resolved.placements.get('component-1')?.position).toEqual([10, 0, 0]);
  });

  it('外からはサブアセンブリ1個の配置として残る', () => {
    const nested = assembly([
      component('component-1', { kind: 'part', partRef: 'part-1' }),
      component('component-2', { kind: 'part', partRef: 'part-1' }),
      component('component-3', { kind: 'part', partRef: 'part-1' }),
    ]);
    const result = resolveAssembly(assembly([sub('assembly-a')]), {
      subAssemblies: new Map([['assembly-a', nested]]), resolvedParts: new Map([['part-1', emptyPart]]),
    });
    expect([...result.placements.keys()]).toEqual(['component-1']);
    expect(result.subAssemblies?.size).toBe(1);
  });

  it('サブ1個と通常部品1個は外の変数を12個だけ持つ', () => {
    const root = assembly([
      sub('assembly-a'),
      component('component-2', { kind: 'part', partRef: 'part-1' }),
    ]);
    expect(collectMateVariables(root).variables).toHaveLength(12);
  });

  it('片方を固定すると外の変数は6個になる', () => {
    const root = assembly([
      { ...sub('assembly-a'), fixed: true },
      component('component-2', { kind: 'part', partRef: 'part-1' }),
    ]);
    expect(collectMateVariables(root).variables).toHaveLength(6);
  });

  it('再帰中の循環を固定文言のエラーとして返す', () => {
    const self = assembly([sub('assembly-a')]);
    const result = resolveAssembly(self, { subAssemblies: new Map([['assembly-a', self]]) });
    expect(result.errors.some((error) => error.message === SUB_ASSEMBLY_CYCLE_MESSAGE)).toBe(true);
  });

  it('深さ9を固定文言のエラーとして返す', () => {
    const fixture = chain(9);
    const result = resolveAssembly(fixture.root, {
      subAssemblies: fixture.documents, resolvedParts: new Map([['part-1', emptyPart]]),
    });
    expect(result.errors.some((error) => error.message === SUB_ASSEMBLY_DEPTH_MESSAGE)).toBe(true);
  });

  it('同じ入力を2回解くと同じ結果になる', () => {
    const fixture = chain(3);
    const options = { subAssemblies: fixture.documents, resolvedParts: new Map([['part-1', emptyPart]]) };
    expect(resolveSubAssembly(fixture.root, 0, options)).toEqual(resolveSubAssembly(fixture.root, 0, options));
  });
});
