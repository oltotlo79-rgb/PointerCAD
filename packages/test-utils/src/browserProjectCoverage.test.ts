import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const textSha256 = (text: string): string => createHash('sha256').update(text.replace(/\r\n/gu, '\n')).digest('hex');
const baseline = JSON.parse(read('packages/test-utils/src/browserProjectCoverage.json')) as {
  'firefox-project': string[]; 'firefox-explicit': string[]; 'chromium-explicit': string[];
  dedicated: string[]; release: string[]; 'firefox-added': string[]; configSha256: string; sourceListSha256: string;
  releaseClassifications: { file: string; category: string; reason: string; sha256: string }[];
  allClassifications: { file: string; category: string; reason: string | null; sha256: string }[];
};

function missingClassifications(current: readonly string[], classified: readonly { file: string; category: string; reason: string | null }[]): string[] {
  const allowed = new Set(['firefox-project', 'firefox-explicit', 'chromium-with-firefox-counterpart',
    'chromium-picker-with-firefox-counterpart', 'manual-capture', 'performance-project', 'dedicated',
    'desktop-renderer-contract', 'node-process-contract', 'numerical-worker-representative',
    'synthetic-helper-representative', 'electron']);
  const counts = new Map<string, number>();
  for (const row of classified) counts.set(row.file, (counts.get(row.file) ?? 0) + 1);
  return current.filter(file => counts.get(file) !== 1 || !classified.some(row => row.file === file
    && row.reason !== null && row.reason.trim().length > 0 && allowed.has(row.category)));
}

function browserOverride(text: string): string | null {
  const source = ts.createSourceFile('spec.ts', text, ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  for (const stmt of source.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) continue;
    const call = stmt.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(source) !== 'test'
      || call.expression.name.text !== 'use' || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) continue;
    for (const item of call.arguments[0].properties) {
      if (ts.isPropertyAssignment(item) && item.name.getText(source) === 'browserName' && ts.isStringLiteral(item.initializer)) {
        values.push(item.initializer.text);
      }
    }
  }
  if (values.length > 1) throw new Error('Multiple top-level browserName settings');
  return values[0] ?? null;
}

function firefoxPattern(text: string): RegExp {
  const source = ts.createSourceFile('e2e/playwright.config.ts', text, ts.ScriptTarget.Latest, true);
  let result: RegExp | undefined;
  let usesFirefoxDevice = false;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'FIREFOX_USE'
      && node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)) {
      usesFirefoxDevice = node.initializer.properties.some(property => ts.isSpreadAssignment(property)
        && ts.isElementAccessExpression(property.expression) && property.expression.expression.getText(source) === 'devices'
        && property.expression.argumentExpression !== undefined && ts.isStringLiteral(property.expression.argumentExpression)
        && property.expression.argumentExpression.text === 'Desktop Firefox');
    }
    if (ts.isObjectLiteralExpression(node)) {
      const name = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'name');
      if (name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer) && name.initializer.text === 'firefox') {
        const field = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'testMatch');
        const use = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'use');
        if (!field || !ts.isPropertyAssignment(field) || !ts.isRegularExpressionLiteral(field.initializer)) throw new Error('Firefox matcher missing');
        if (!use || !ts.isPropertyAssignment(use) || use.initializer.getText(source) !== 'FIREFOX_USE') throw new Error('Firefox use missing');
        const literal = field.initializer.text, slash = literal.lastIndexOf('/');
        result = new RegExp(literal.slice(1, slash), literal.slice(slash + 1));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (result === undefined || !usesFirefoxDevice) throw new Error('Firefox project or Firefox device missing');
  return result;
}

function dedicatedFiles(text: string): string[] {
  const source = ts.createSourceFile('e2e/playwright.config.ts', text, ts.ScriptTarget.Latest, true);
  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'MEASUREMENT_FILES' || decl.initializer === undefined
        || !ts.isAsExpression(decl.initializer) || !ts.isObjectLiteralExpression(decl.initializer.expression)) continue;
      return decl.initializer.expression.properties.flatMap(property => {
        if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) throw new Error('Invalid measurement group');
        return property.initializer.elements.map(element => {
          if (!ts.isStringLiteral(element)) throw new Error('Invalid measurement filename');
          return element.text;
        });
      });
    }
  }
  throw new Error('Dedicated measurement files missing');
}

function startupFirefoxPattern(text: string): RegExp {
  const source = ts.createSourceFile('e2e/playwright.config.ts', text, ts.ScriptTarget.Latest, true);
  let pattern: RegExp | undefined;
  let projectUsesStartup = false;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'WEB_STARTUP_TEST'
      && node.initializer !== undefined && ts.isRegularExpressionLiteral(node.initializer)) {
      const literal = node.initializer.text, slash = literal.lastIndexOf('/');
      pattern = new RegExp(literal.slice(1, slash), literal.slice(slash + 1));
    }
    if (ts.isObjectLiteralExpression(node)) {
      const fields = node.properties.filter(ts.isPropertyAssignment);
      const named = fields.find(field => field.name.getText(source) === 'name');
      if (named && ts.isStringLiteral(named.initializer) && named.initializer.text === 'startup-firefox') {
        const match = fields.find(field => field.name.getText(source) === 'testMatch');
        const use = fields.find(field => field.name.getText(source) === 'use');
        projectUsesStartup = match?.initializer.getText(source) === 'WEB_STARTUP_TEST'
          && use?.initializer.getText(source) === 'FIREFOX_USE';
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!pattern || !projectUsesStartup) throw new Error('Firefox startup project missing');
  return pattern;
}

describe('確認済みブラウザー検査の名簿', () => {
  it('全specに一意の根拠付き分類を求め、新規・未解決・重複を拒否する', () => {
    const names = readdirSync(resolve(root, 'e2e/tests')).filter(name => name.endsWith('.spec.ts')).sort();
    const rows = baseline.allClassifications;
    expect(new Set(rows.map(row => row.file)).size).toBe(rows.length);
    expect([...rows.map(row => row.file)].sort()).toEqual(names);
    expect(missingClassifications(names, rows)).toEqual([]);
    for (const category of ['firefox-project', 'firefox-explicit', 'dedicated'] as const) {
      expect(rows.filter(row => row.category === category).map(row => row.file).sort()).toEqual([...baseline[category]].sort());
    }
    expect(rows.filter(row => row.category === 'chromium-with-firefox-counterpart'
      || row.category === 'chromium-picker-with-firefox-counterpart').map(row => row.file).sort())
      .toEqual([...baseline['chromium-explicit']].sort());
    for (const row of rows) {
      const text = readFileSync(resolve(root, 'e2e/tests', row.file), 'utf8');
      expect(textSha256(text), row.file).toBe(row.sha256);
    }
    expect(textSha256('first\nsecond\n')).toBe(textSha256('first\r\nsecond\r\n'));
    expect(textSha256('first\nsecond\n')).not.toBe(textSha256('first\nchanged\n'));
    const known = [{ file: 'known.spec.ts', category: 'manual-capture', reason: 'manual screenshot' }];
    expect(missingClassifications(['known.spec.ts', 'new.spec.ts'], known)).toEqual(['new.spec.ts']);
    expect(missingClassifications(['known.spec.ts'], [{ ...known[0], reason: null }])).toEqual(['known.spec.ts']);
    expect(missingClassifications(['known.spec.ts'], [{ ...known[0], category: 'unreviewed' }])).toEqual(['known.spec.ts']);
    expect(missingClassifications(['known.spec.ts'], [...known, ...known])).toEqual(['known.spec.ts']);
  });
  it('functional内でもFirefoxを明示する4 specと、対応するChromium specを区別する', () => {
    expect(baseline['firefox-explicit']).toHaveLength(4);
    for (const name of baseline['firefox-explicit']) expect(browserOverride(read(`e2e/tests/${name}`)), name).toBe('firefox');
    expect(baseline['chromium-explicit']).toHaveLength(4);
    for (const name of baseline['chromium-explicit']) expect(browserOverride(read(`e2e/tests/${name}`)), name).toBe('chromium');
    expect(browserOverride("// test.use({ browserName: 'firefox' })\nconst x = 'firefox';")).toBeNull();
    expect(browserOverride("test.use({ browserName: 'firefox' });")).toBe('firefox');
  });
  it('Firefox対象の名簿は現行の正規表現か起動専用に含まれる', () => {
    const config = read('e2e/playwright.config.ts');
    const pattern = firefoxPattern(config);
    const startup = startupFirefoxPattern(config);
    expect(baseline['firefox-project']).toHaveLength(138);
    expect(baseline['firefox-added']).toHaveLength(49);
    expect(textSha256(config)).toBe(baseline.configSha256);
    for (const name of baseline['firefox-added']) {
      expect(baseline['firefox-project']).toContain(name);
      expect(browserOverride(read(`e2e/tests/${name}`)), name).toBeNull();
    }
    for (const name of baseline['firefox-project']) {
      expect(existsSync(resolve(root, 'e2e/tests', name)), name).toBe(true);
      expect(pattern.test(`e2e/tests/${name}`) || startup.test(`e2e/tests/${name}`), name).toBe(true);
    }
  });
  it('専用測定と配布設定の対象をそれぞれの正本に残す', () => {
    const current = dedicatedFiles(read('e2e/playwright.config.ts'));
    expect(baseline.dedicated).toHaveLength(6);
    expect([...current].sort()).toEqual([...baseline.dedicated].sort());
    for (const name of baseline.dedicated) {
      expect(existsSync(resolve(root, 'e2e/tests', name)), name).toBe(true);
    }
    expect(baseline.release).toHaveLength(3);
    const currentRelease = readdirSync(resolve(root, 'e2e/release')).filter(name => name.endsWith('.spec.ts')).sort();
    expect([...baseline.release].sort()).toEqual(currentRelease);
    expect(baseline.releaseClassifications).toHaveLength(3);
    expect(new Set(baseline.releaseClassifications.map(row => row.file)).size).toBe(3);
    expect(baseline.releaseClassifications.map(row => row.file.replace(/^e2e\/release\//u, '')).sort())
      .toEqual([...baseline.release].sort());
    for (const row of baseline.releaseClassifications) {
      expect(row.category).toBe('release-config');
      expect(row.reason.trim().length).toBeGreaterThan(0);
      expect(textSha256(readFileSync(resolve(root, row.file), 'utf8'))).toBe(row.sha256);
    }
    const releaseConfig = read('e2e/packaged-desktop.config.ts') + read('e2e/offline-candidate.config.ts');
    for (const name of baseline.release) {
      expect(existsSync(resolve(root, 'e2e/release', name)), name).toBe(true);
      expect(releaseConfig).toContain(`'${name}'`);
    }
  });
});
