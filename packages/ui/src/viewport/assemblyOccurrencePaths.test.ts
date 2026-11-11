import {
  addComponent, createAssemblyDocument, createComponentFor,
  type AssemblyComponent, type AssemblyDocument, type ComponentSource, type ResolvedAssembly, type RigidPlacement,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { buildAssemblyGeometry, flattenAssemblyGeometry } from './createAssemblyLayer.js';

const AT_ORIGIN: RigidPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** id を名付けた部品を順に置いた文書(id は createComponentFor の番号ではなく、区切り文字や Unicode を含む名付け)。 */
function documentOf(name: string, entries: readonly (readonly [string, ComponentSource])[]): AssemblyDocument {
  let document = createAssemblyDocument(name);
  for (const [id, source] of entries) {
    const component: AssemblyComponent = { ...createComponentFor(document, source, {}), id };
    document = addComponent(document, component);
  }
  return document;
}

/** 葉の部品だけの解決結果(どれも原点、部品の鍵は partRef)。 */
function resolvedLeaves(document: AssemblyDocument, subAssemblies: ResolvedAssembly['subAssemblies'] = new Map()): ResolvedAssembly {
  const placements = new Map<string, RigidPlacement>(), partKeys = new Map<string, string>();
  for (const component of document.components) {
    placements.set(component.id, AT_ORIGIN);
    if (component.source.kind === 'part') partKeys.set(component.id, component.source.partRef);
  }
  return { parts: new Map(), placements, partKeys, errors: [], subAssemblies };
}

const CHILD_SOURCE: ComponentSource = { kind: 'subAssembly', assemblyRef: 'child' };

function nested(child: AssemblyDocument, ids: readonly string[]): ResolvedAssembly['subAssemblies'] {
  return new Map(ids.map((componentId) => [componentId,
    { componentId, assemblyRef: 'child', assembly: child, placement: AT_ORIGIN, resolved: resolvedLeaves(child) }]));
}

describe('入れ子の組の葉の部品の配置の経路', () => {
  it('同じ子の組を2か所に置くと、同じ葉の部品も根からの経路で別々になる', () => {
    const child = documentOf('子', [['plate', { kind: 'part', partRef: 'plate-part' }]]);
    const root = documentOf('根', [['A', CHILD_SOURCE], ['B', CHILD_SOURCE]]);
    const flat = flattenAssemblyGeometry(root, resolvedLeaves(root, nested(child, ['A', 'B'])));
    expect(flat.components.map((component) => component.id)).toEqual(['A/plate', 'B/plate']);
    expect([...(flat.occurrencePaths ?? new Map()).entries()]).toEqual([['A/plate', ['A', 'plate']], ['B/plate', ['B', 'plate']]]);
    expect(flat.partKeys.get('A/plate')).toBe('plate-part');
  });

  it('区切り文字・引用符・Unicode を含む id も分けずにそのまま運び、JSON で往復しても同じ並びに戻る', () => {
    const leaf = 'plate"x,1/2';
    const child = documentOf('子', [[leaf, { kind: 'part', partRef: 'plate-part' }]]);
    const root = documentOf('根', [['組,①', CHILD_SOURCE], ['root-leaf', { kind: 'part', partRef: 'base-part' }]]);
    const flat = flattenAssemblyGeometry(root, resolvedLeaves(root, nested(child, ['組,①'])));
    const paths = flat.occurrencePaths ?? new Map();
    expect(paths.get(`組,①/${leaf}`)).toEqual(['組,①', 'plate"x,1/2']);
    expect(paths.get('root-leaf')).toEqual(['root-leaf']);
    expect(JSON.parse(JSON.stringify(paths.get(`組,①/${leaf}`)))).toEqual(['組,①', 'plate"x,1/2']);
  });

  it('行 ID が別の配置と同じ文字列になれば、どちらの経路も渡さない(表示の文字列から推し量らない)', () => {
    // 根の葉 `a/b` と、子の組 `a` の中の葉 `b` は、どちらも行 ID が `a/b` になる。
    const child = documentOf('子', [['b', { kind: 'part', partRef: 'inner-part' }]]);
    const root = documentOf('根', [['a/b', { kind: 'part', partRef: 'outer-part' }], ['a', CHILD_SOURCE]]);
    const flat = flattenAssemblyGeometry(root, resolvedLeaves(root, nested(child, ['a'])));
    expect(flat.components.map((component) => component.id)).toEqual(['a/b', 'a/b']);
    expect(flat.occurrencePaths?.get('a/b')).toBeNull();
  });

  it('描く一式の配置へ経路を運び、行 ID の重なった配置には経路を持たせない', () => {
    const child = documentOf('子', [['b', { kind: 'part', partRef: 'inner-part' }]]);
    const root = documentOf('根', [['a/b', { kind: 'part', partRef: 'outer-part' }], ['a', CHILD_SOURCE], ['B', CHILD_SOURCE]]);
    const flat = flattenAssemblyGeometry(root, resolvedLeaves(root, nested(child, ['a', 'B'])));
    const bundle = buildAssemblyGeometry({ ...flat, hoveredComponentId: null, selectedComponentIds: [],
      bodies: new Map([['outer-part', []], ['inner-part', []]]) });
    expect(bundle.instances.map((instance) => [instance.componentId, instance.occurrencePath ?? null]))
      .toEqual([['a/b', null], ['a/b', null], ['B/b', ['B', 'b']]]);
  });

  it('入れ子の無い組の行 ID・配置・部品の鍵は今までと同じで、経路は1つの id だけ', () => {
    const root = documentOf('根', [['component-1', { kind: 'part', partRef: 'p1' }], ['component-2', { kind: 'part', partRef: 'p2' }]]);
    const flat = flattenAssemblyGeometry(root, resolvedLeaves(root));
    expect(flat.components.map((component) => component.id)).toEqual(['component-1', 'component-2']);
    expect([...flat.partKeys.entries()]).toEqual([['component-1', 'p1'], ['component-2', 'p2']]);
    expect([...(flat.occurrencePaths ?? new Map()).values()]).toEqual([['component-1'], ['component-2']]);
  });
});
