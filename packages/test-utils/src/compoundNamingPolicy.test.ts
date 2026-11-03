import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseline: Record<string, Record<string, number>> = {
  "apps/desktop/src/main/occtHttpTransport.ts": {
    "createTransportTrace|VariableDeclaration|startedAtEpochMs": 1
  },
  "packages/ui/src/viewport/viewportMeshObservation.ts": {
    "createViewportMeshObservation|Parameter|epochClock": 1,
    "createViewportMeshObservation|VariableDeclaration|epochAnchorMs": 1
  },
  "packages/model/src/kernelBridge.ts": {
    "createMainPhaseObserver/record|VariableDeclaration|epochMs": 1
  }
};

function collectCompound(file: string, text: string): Record<string, number> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const counts: Record<string, number> = {};
  const banned = new Set(['epoch', 'op', 'param', 'expr', 'doc']);
  const exported = new Set(source.statements.flatMap(statement => ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map(element => (element.propertyName ?? element.name).text) : []));
  function visit(node: ts.Node): void {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || (ts.isPropertyDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword))) && node.name !== undefined && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const words = (name.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/gu) ?? []).map(part => {
        let word = part.toLowerCase();
        if (word.length > 3 && word.endsWith('ies')) word = word.slice(0, -3) + 'y';
        else if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) word = word.slice(0, -1);
        return word;
      });
      if ((ts.isPropertyDeclaration(node) || !banned.has(name)) && words.some(word => banned.has(word))) {
        let outer: ts.Node | undefined = node.parent;
        const scopes: string[] = [];
        while (outer !== undefined && !ts.isSourceFile(outer)) {
          if (ts.isFunctionLike(outer) && 'body' in outer && outer.body !== undefined) {
            if ((ts.isFunctionDeclaration(outer) || ts.isMethodDeclaration(outer) || ts.isGetAccessorDeclaration(outer) || ts.isSetAccessorDeclaration(outer)) && outer.name !== undefined && ts.isIdentifier(outer.name)) scopes.push(outer.name.text);
            else if (ts.isVariableDeclaration(outer.parent) && ts.isIdentifier(outer.parent.name)) scopes.push(outer.parent.name.text);
            else if (ts.isPropertyAssignment(outer.parent) && ts.isIdentifier(outer.parent.name)) scopes.push(outer.parent.name.text);
            else scopes.push('<callback>');
          } else if (ts.isClassDeclaration(outer) && outer.name !== undefined) scopes.push(outer.name.text);
          outer = outer.parent;
        }
        let top: ts.Node | undefined = node;
        while (top !== undefined && top.parent !== source) top = top.parent;
        const isPublicTop = top !== undefined && (ts.isVariableStatement(top) || ts.isFunctionDeclaration(top)) && (top.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) || exported.has(name));
        if ((!isPublicTop || scopes.length > 0) && (!ts.isParameter(node) || scopes.length > 0)) {
          const key = scopes.reverse().join('/') + '|' + ts.SyntaxKind[node.kind] + '|' + name;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
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

it('rejects new compound abbreviations in local declarations', () => {
  const issues: string[] = [];
  for (const file of [...files(resolve(root, 'packages')), ...files(resolve(root, 'apps'))]) {
    const found = collectCompound(file, readFileSync(resolve(root, file), 'utf8'));
    for (const [key, count] of Object.entries(found)) if (count > (baseline[file]?.[key] ?? 0)) issues.push(file + ':' + key);
  }
  expect(issues).toEqual([]);
});

it('distinguishes declared compound names from protocol keys and exports', () => {
  expect(Object.keys(collectCompound('fixture.ts', 'function f() { const nextEpoch = 1; return { epoch: nextEpoch }; } export const hostEpoch = 2;'))).toEqual(['f|VariableDeclaration|nextEpoch']);
});

it('rejects abbreviated private fields and preserves public keys', () => {
  const source = 'class Ledger { private epoch = 1; private hostEpoch = 2; epoch = 3; private hostGeneration = 4; snapshot() { return { epoch: this.epoch }; } }';
  expect(Object.keys(collectCompound('fixture.ts', source))).toEqual([
    'Ledger|PropertyDeclaration|epoch',
    'Ledger|PropertyDeclaration|hostEpoch',
  ]);
});
