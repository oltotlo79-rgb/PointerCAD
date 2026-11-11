import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseline: Record<string, Record<string, number>> = {};
const names = new Set(['epoch', 'op', 'param', 'expr', 'doc']);

function collect(file: string, text: string): Record<string, number> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const counts: Record<string, number> = {};
  const exported = new Set(source.statements.flatMap(statement => ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map(element => (element.propertyName ?? element.name).text) : []));
  function privateModuleBinding(node: ts.Node, name: string): boolean {
    let declaration: ts.Node | undefined = node;
    while (declaration !== undefined && declaration.parent !== source) declaration = declaration.parent;
    if (declaration === undefined || !(ts.isVariableStatement(declaration) || ts.isFunctionDeclaration(declaration))) return false;
    return !declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && !exported.has(name);
  }
  function visit(node: ts.Node): void {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name) && names.has(node.name.text)) {
      let parent: ts.Node | undefined = node.parent;
      while (parent !== undefined && !ts.isSourceFile(parent) && !(ts.isFunctionLike(parent) && 'body' in parent && parent.body !== undefined)) parent = parent.parent;
      if (parent !== undefined && (!ts.isSourceFile(parent) || privateModuleBinding(node, node.name.text))) counts[node.name.text + '@' + (source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1) + ':' + (source.getLineAndCharacterOfPosition(node.name.getStart(source)).character + 1)] = 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(source); return counts;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '__tests__', 'fixtures'].includes(entry.name)) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    const rel = relative(root, full).replaceAll('\\', '/');
    return /\/src\//u.test(rel) && /\.tsx?$/u.test(rel) && !/\.(test|spec|testSupport|selftest)\.[cm]?tsx?$/u.test(rel) ? [rel] : [];
  });
}

it('rejects new abbreviated local declarations above the reviewed baseline', () => {
  const issues: string[] = [];
  for (const file of [...files(resolve(root, 'packages')), ...files(resolve(root, 'apps'))]) {
    const counts = collect(file, readFileSync(resolve(root, file), 'utf8'));
    for (const [name, count] of Object.entries(counts)) if (count > (baseline[file]?.[name] ?? 0)) issues.push(file + ':' + name);
  }
  expect(issues).toEqual([]);
});

it('counts declarations rather than strings or property names', () => {
  expect(collect('fixture.ts', 'function f() { const doc = { op: "expr" }; return doc; }')).toEqual({ 'doc@1:22': 1 });
});

it('distinguishes private module names from exported API declarations', () => {
  expect(Object.keys(collect('fixture.ts', 'const op = 1; export const expr = 2; const doc = 3; export { doc };'))).toEqual(['op@1:7']);
});

it('rejects private module function and destructured binding abbreviations', () => {
  expect(Object.keys(collect('fixture.ts', 'function op() {}\nconst { doc } = source;'))).toEqual(['op@1:10', 'doc@2:9']);
  expect(collect('fixture.ts', 'export function op() {}\nexport const { doc } = source;\nfunction expr() {}\nexport { expr };')).toEqual({});
});
