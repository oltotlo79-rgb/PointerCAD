import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

function differences(actual: readonly string[], expected: readonly string[]): { missing: string[]; added: string[] } {
  const actualSet = new Set(actual), expectedSet = new Set(expected);
  return { missing: expected.filter(name => !actualSet.has(name)), added: actual.filter(name => !expectedSet.has(name)) };
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name: unknown) => typeof name === 'string');
}
describe('drawing public entry', () => {
  it('detects an unexpected export and a missing required name', () => {
    expect(differences(['keep', 'extra'], ['keep', 'required']))
      .toEqual({ missing: ['required'], added: ['extra'] });
  });
  it('keeps the reviewed public names, including named wildcard exports', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const index = resolve(root, 'packages/drawing/src/index.ts');
    const expected: unknown = JSON.parse(readFileSync(resolve(root, 'packages/test-utils/src/drawingPublicExports.json'), 'utf8'));
    if (!stringArray(expected)) throw new Error('Invalid drawing public export baseline');
    const program = ts.createProgram([index], { noEmit: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, skipLibCheck: true });
    const checker = program.getTypeChecker(), source = program.getSourceFile(index);
    if (source === undefined) throw new Error('Missing drawing entry');
    const symbol = checker.getSymbolAtLocation(source);
    if (symbol === undefined) throw new Error('Missing drawing exports');
    const actual = checker.getExportsOfModule(symbol).map(item => item.getName()).sort();
    expect(differences(actual, expected)).toEqual({ missing: [], added: [] });
  });
});
