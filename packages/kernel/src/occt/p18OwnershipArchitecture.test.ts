import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// Deliberately limited to the original P18 inventory. This detects a direct local
// `new oc.Class(...)` followed by that local's `.delete()`, not calls on borrowed
// handles, returned handles, collections, aliases, or shadowed/ambiguous names.
const paths = [
  'occt/makeSketchEdges.ts', 'occt/sewSolid.ts', 'occt/analysisFreeformBound.ts',
  'occt/makePlanarFace.ts', 'occt/makeEllipseEdge.ts', 'occt/makeFunctionSurfaceBodies.ts',
  'occt/solidMesh.ts', 'occt/functionCurveSpline.ts', 'occt/makeBox.ts', 'occt/solidTopology.ts',
  'occt/xcafAssembly.ts', 'occt/loftSurface.testSupport.ts', 'worker/shapeCache.ts', 'worker/sheetBodyReuse.ts',
] as const;

function directManualNativeDeletes(source: string): string[] {
  const file = ts.createSourceFile('p18.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, number>();
  const natives = new Map<string, ts.Node>();
  const calls: { name: string; scope: ts.Node }[] = [];
  function scopeOf(node: ts.Node): ts.Node {
    let scope: ts.Node | undefined = node.parent;
    while (scope !== undefined && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    return scope ?? file;
  }
  function visit(node: ts.Node): void {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, (declarations.get(node.name.text) ?? 0) + 1);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      declarations.set(name, (declarations.get(name) ?? 0) + 1);
      const init = node.initializer;
      if (init !== undefined && ts.isNewExpression(init) && ts.isPropertyAccessExpression(init.expression)
        && ts.isIdentifier(init.expression.expression) && init.expression.expression.text === 'oc') natives.set(name, scopeOf(node));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'delete' && ts.isIdentifier(node.expression.expression)) {
      calls.push({ name: node.expression.expression.text, scope: scopeOf(node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls.filter(call => natives.get(call.name) === call.scope && declarations.get(call.name) === 1).map(call => call.name);
}

describe('original P18 native ownership guard', () => {
  it('detects direct local native deletion while accepting borrowed and ambiguous names', () => {
    expect(directManualNativeDeletes('const item = new oc.Thing(); item.delete();')).toEqual(['item']);
    expect(directManualNativeDeletes('const owner = createAllocations(); const item = new oc.Thing(); item.delete();'))
      .toEqual(['item']);
    expect(directManualNativeDeletes('function f(handle: Handle) { handle.delete(); }')).toEqual([]);
    expect(directManualNativeDeletes('function f() { const item = new oc.Thing(); } function g() { const item = borrowed; item.delete(); }')).toEqual([]);
    expect(directManualNativeDeletes('function f() { const item = new oc.Thing(); } function g(item: Handle) { item.delete(); }')).toEqual([]);
  });
  it.each(paths)('%s has no directly deleted local native constructor result', path => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    expect(directManualNativeDeletes(source)).toEqual([]);
  });
});
