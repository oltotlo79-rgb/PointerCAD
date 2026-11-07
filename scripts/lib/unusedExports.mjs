// P04: unused-export inventory. Ported from the consistency audit (cl-v103-code-consistency-audit/tools/collect.mjs
// for per-file facts and analyze.py for resolution and the dead / file-internal-only / test-only classification).
// Syntax trees only, no type checking. The rules below keep the audit's choices: re-exports and `export *` are not
// uses, comments are not uses, an unanalysable dynamic import or `import * as` without member access uses the whole
// module, and an unresolved relative import is reported instead of being ignored. collect.mjs recorded no
// `typeof import(spec)`, so that reference rewritten as `import type * as ns` uses only the members it names.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const CODE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/u;
// A relative `new URL(spec, import.meta.url)` that names a directory ('./dir/', '..', '../../') is a base for later
// path arithmetic, not a module or asset reference. Build and scratch directories may be absent in a clean checkout,
// so such a base is resolved as a directory of the workspace and only one that leaves the workspace is unresolved.
const DIRECTORY_BASE = /(?:^|\/)\.{0,2}$/u;
const isDirectoryBase = record => record.kind === 'url' && record.spec.startsWith('.') && DIRECTORY_BASE.test(record.spec.split('?')[0]);
const leavesWorkspace = (from, spec) => {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec.split('?')[0]));
  return target === '..' || target.startsWith('../');
};
const EXCLUDED = [/^packages\/fem\/runtime\/assets\//u, /(?:^|\/)dist\//u, /(?:^|\/)node_modules\//u, /\.d\.(?:ts|mts|cts)$/u];
// The audit listed `git ls-files -co --exclude-standard`; these are the .gitignore directory rules for the walked roots.
const SKIP_DIRECTORIES = new Set(['dist', 'dist-types', 'out', 'build', '.vite', 'coverage', 'node_modules', '.git',
  'playwright-report', 'test-results', '__pycache__', 'shots', '.pnpm-store', 'scratchpad']);
// .gitignore keeps only the direct TypeScript files of apps/web/build.
const keptBuildFile = name => /^apps\/web\/build\/[^/]+\.ts$/u.test(name);
const PRODUCT_ROOTS = ['packages', 'apps'];
const CONSUMER_ROOTS = ['packages', 'apps', 'e2e', 'scripts', '.github'];
const ENTRY_PATTERNS = [
  /\.test\.(?:ts|tsx|mts|mjs)$/u, /\.spec\.ts$/u, /\.config\.(?:ts|mts|mjs|js)$/u,
  /^apps\/web\/src\/main\.tsx$/u, /^apps\/web\/src\/bootstrap\.ts$/u, /^apps\/desktop\/src\/main\/main\.ts$/u,
  /^apps\/desktop\/src\/preload\//u, /^apps\/desktop\/src\/renderer\/main\.tsx$/u, /^apps\/web\/service-worker\//u,
  /\.worker\.ts$/u, /^packages\/ui\/integration\//u, /^apps\/web\/build\//u, /^apps\/desktop\/build\//u,
  /^e2e\/(?:release|fixtures)\//u, /^e2e\/[^/]+\.ts$/u,
];

export function isInventorySource(name) {
  return CODE.test(name) && !EXCLUDED.some(pattern => pattern.test(name));
}

/** collect.mjs classify(): tool files are consumers only and never counted. */
export function classifyInventoryFile(file) {
  const base = path.posix.basename(file);
  if (file.startsWith('scripts/') || file.startsWith('.github/') || !file.includes('/')) return 'tool';
  if (file.startsWith('e2e/')) {
    if (base.endsWith('.spec.ts')) return 'e2e-spec';
    return /\.config\.ts$/u.test(base) ? 'config' : 'e2e-support';
  }
  if (/\.test\.(?:ts|tsx|mts|mjs)$/u.test(base) || /\.selftest\./u.test(base)) return 'test';
  if (file.includes('/integration/')) return 'test';
  if (/\.config\.(?:ts|mts|mjs|js)$/u.test(base) || /vitest\./u.test(base)) return 'config';
  return 'product';
}

const packageOf = file => {
  const parts = file.split('/');
  return parts[0] === 'packages' || parts[0] === 'apps' ? `${parts[0]}/${parts[1]}` : parts[0];
};

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return /\.(?:ts|mts|cts)$/u.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function hasModifier(node, kind) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some(modifier => modifier.kind === kind));
}

function declarationKind(node) {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  return 'other';
}

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
  return out;
}

function importRecord(statement, sf, fact) {
  const clause = statement.importClause;
  const record = { spec: statement.moduleSpecifier.text, line: lineOf(sf, statement), kind: 'import',
    typeOnly: Boolean(clause?.isTypeOnly), names: [], ns: null, def: null };
  if (clause?.name) { record.def = clause.name.text; fact.importBindings[clause.name.text] = { spec: record.spec, name: 'default' }; }
  const bindings = clause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    record.ns = bindings.name.text; fact.importBindings[record.ns] = { spec: record.spec, name: '*', typeOnly: record.typeOnly };
  } else if (bindings) {
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      record.names.push({ imported, local: element.name.text, typeOnly: record.typeOnly || element.isTypeOnly });
      fact.importBindings[element.name.text] = { spec: record.spec, name: imported };
    }
  }
  fact.imports.push(record);
}

function exportDeclarationRecords(statement, sf, fact, exportedLocal) {
  const spec = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
  const line = lineOf(sf, statement), typeOnly = statement.isTypeOnly;
  if (!statement.exportClause) fact.exports.push({ name: '*', kind: 'exportAll', from: spec, line, typeOnly });
  else if (ts.isNamespaceExport(statement.exportClause)) {
    fact.exports.push({ name: statement.exportClause.name.text, kind: 'exportNs', from: spec, line, typeOnly });
  } else {
    for (const element of statement.exportClause.elements) {
      const local = (element.propertyName ?? element.name).text;
      fact.exports.push({ name: element.name.text, local, kind: spec ? 'reexport' : 'exportLocal', from: spec, line,
        typeOnly: typeOnly || element.isTypeOnly });
      if (!spec) exportedLocal.add(local);
    }
  }
  if (spec) fact.imports.push({ spec, line, kind: 'reexport', typeOnly, names: [], ns: null, def: null });
}

function exportedDeclarationRecords(statement, sf, fact, exportedLocal) {
  const line = lineOf(sf, statement);
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
    fact.exports.push({ name: 'default', kind: declarationKind(statement), from: null, line, typeOnly: false });
    if (statement.name) exportedLocal.add(statement.name.text);
    return;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      const callable = declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer));
      for (const name of bindingNames(declaration.name, [])) {
        fact.exports.push({ name, kind: callable ? 'function' : 'const', from: null, line: lineOf(sf, declaration), typeOnly: false });
        exportedLocal.add(name);
      }
    }
    return;
  }
  if (statement.name && ts.isIdentifier(statement.name)) {
    const kind = declarationKind(statement);
    fact.exports.push({ name: statement.name.text, kind, from: null, line, typeOnly: kind === 'interface' || kind === 'type' });
    exportedLocal.add(statement.name.text);
  }
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const literalText = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/** `const { a } = await import(x)`, `const ns = await import(x)` and `(await import(x)).a` keep names; others use all. */
function dynamicImportRecord(node, sf, fact, spec) {
  const record = { spec, line: lineOf(sf, node), kind: 'dynamic', typeOnly: false, names: [], ns: null, def: null, dynamicAll: true };
  const holder = node.parent && ts.isAwaitExpression(node.parent) ? node.parent.parent : undefined;
  if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
    record.ns = holder.name.text; record.dynamicAll = false; fact.importBindings[record.ns] = { spec, name: '*' };
  } else if (holder && ts.isVariableDeclaration(holder) && ts.isObjectBindingPattern(holder.name)
    && !holder.name.elements.some(element => element.dotDotDotToken)) {
    record.names = holder.name.elements.map(element => ({ imported: (element.propertyName ?? element.name).getText(sf), local: element.name.getText(sf) }));
    record.dynamicAll = false;
  } else if (holder && ts.isParenthesizedExpression(holder) && holder.parent && ts.isPropertyAccessExpression(holder.parent)) {
    record.names = [{ imported: holder.parent.name.text, local: holder.parent.name.text }];
    record.dynamicAll = false;
  }
  fact.imports.push(record);
}

function callRecord(node, sf, fact) {
  const callee = node.expression, spec = literalText(node.arguments[0]);
  if (!spec) return;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) dynamicImportRecord(node, sf, fact, spec);
  else if (ts.isIdentifier(callee) && callee.text === 'require') {
    fact.imports.push({ spec, line: lineOf(sf, node), kind: 'require', typeOnly: false, names: [], ns: null, def: null });
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi'
    && /^(?:mock|doMock|importActual|importMock)$/u.test(callee.name.text)) {
    fact.imports.push({ spec, line: lineOf(sf, node), kind: `vi.${callee.name.text}`, typeOnly: false, names: [], ns: null, def: null });
  }
}

function walkFacts(sf, fact, identifiers) {
  const visit = node => {
    if (ts.isIdentifier(node)) identifiers.set(node.text, (identifiers.get(node.text) ?? 0) + 1);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && fact.importBindings[node.expression.text]?.name === '*') {
      (fact.nsAccess[node.expression.text] ??= Object.create(null))[node.name.text] = true;
    }
    // `ns.Name` in a type of a type-only namespace import names that member.
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && fact.importBindings[node.left.text]?.name === '*'
      && fact.importBindings[node.left.text].typeOnly === true) {
      (fact.nsAccess[node.left.text] ??= Object.create(null))[node.right.text] = true;
    }
    if (ts.isCallExpression(node)) callRecord(node, sf, fact);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length >= 2) {
      const spec = literalText(node.arguments[0]);
      if (spec && node.arguments[1].getText(sf).includes('import.meta.url')) {
        fact.imports.push({ spec, line: lineOf(sf, node), kind: 'url', typeOnly: false, names: [], ns: null, def: null });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** collect.mjs analyzeFile(), reduced to the facts used by the dead-code view. */
export function collectExportFacts(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const fact = { path: file, pkg: packageOf(file), cls: classifyInventoryFile(file), imports: [], exports: [],
    importBindings: Object.create(null), nsAccess: Object.create(null), idRefs: Object.create(null) };
  const exportedLocal = new Set(), identifiers = new Map();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) importRecord(statement, sf, fact);
    else if (ts.isExportDeclaration(statement)) exportDeclarationRecords(statement, sf, fact, exportedLocal);
    else if (ts.isExportAssignment(statement)) fact.exports.push({ name: 'default', kind: 'default', from: null, line: lineOf(sf, statement), typeOnly: false });
    else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) exportedDeclarationRecords(statement, sf, fact, exportedLocal);
  }
  walkFacts(sf, fact, identifiers);
  for (const name of exportedLocal) {
    // The declaration itself and an `export { x }` clause are not uses (same-name shadows still count: audit approximation).
    const clause = fact.exports.some(entry => entry.kind === 'exportLocal' && entry.local === name) ? 1 : 0;
    fact.idRefs[name] = Math.max(0, (identifiers.get(name) ?? 0) - 1 - clause);
  }
  return fact;
}

function walkFiles(root, directory, out) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return;
  const entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (name === 'apps/web/build') walkFiles(root, name, out);
      else if (!SKIP_DIRECTORIES.has(entry.name) && !name.startsWith('apps/web/build/') && name !== 'packages/fem/runtime/assets') walkFiles(root, name, out);
    } else if (entry.isFile() && (!name.startsWith('apps/web/build/') || keptBuildFile(name))) out.push(name);
  }
}

function filesystemSources(root) {
  const names = [];
  for (const directory of CONSUMER_ROOTS) walkFiles(root, directory, names);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isFile()) names.push(entry.name);
  return names;
}

function readPackageExports(names, read) {
  const directories = new Map(), exportsByName = new Map();
  for (const file of names.filter(name => /^(?:packages|apps)\/[^/]+\/package\.json$/u.test(name)).sort()) {
    const manifest = JSON.parse(read(file)), directory = path.posix.dirname(file);
    if (typeof manifest.name !== 'string') continue;
    directories.set(manifest.name, directory);
    const table = new Map();
    if (manifest.exports && typeof manifest.exports === 'object') {
      for (const [key, value] of Object.entries(manifest.exports)) {
        const target = typeof value === 'string' ? value : value && typeof value === 'object' ? (value.default ?? value.import ?? value.types) : undefined;
        if (typeof target === 'string') table.set(key, path.posix.normalize(path.posix.join(directory, target)));
      }
    }
    if (table.size === 0 && typeof manifest.main === 'string') table.set('.', path.posix.normalize(path.posix.join(directory, manifest.main)));
    exportsByName.set(manifest.name, table);
  }
  return { directories, exportsByName };
}

function createResolver(byPath, fileExists, packages) {
  const candidates = base => {
    const js = /\.(js|jsx|mjs|cjs)$/u.exec(base);
    if (js) return [base.slice(0, -js[0].length) + '.ts', base.slice(0, -js[0].length) + '.tsx',
      ...(js[1] === 'mjs' ? [base.slice(0, -js[0].length) + '.mts'] : []), base];
    if (/\.(?:ts|tsx|mts|cts)$/u.test(base)) return [base];
    return [base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx', base + '.js', base + '.mjs', base];
  };
  const pick = base => candidates(base).find(name => byPath.has(name)) ?? candidates(base).find(fileExists) ?? null;
  const cache = new Map();
  return (from, spec) => {
    const key = `${from}\n${spec}`;
    if (cache.has(key)) return cache.get(key);
    const clean = spec.split('?')[0];
    let result = { target: null, kind: 'external' };
    if (clean.startsWith('.')) {
      const target = pick(path.posix.normalize(path.posix.join(path.posix.dirname(from), clean)));
      result = { target, kind: target ? 'rel' : 'unresolved' };
    } else {
      const match = /^(@pointercad\/[^/]+)(\/.*)?$/u.exec(clean);
      if (match && packages.directories.has(match[1])) {
        const mapped = packages.exportsByName.get(match[1]).get('.' + (match[2] ?? ''));
        const target = mapped ? (byPath.has(mapped) || fileExists(mapped) ? mapped : pick(mapped))
          : pick(path.posix.normalize(path.posix.join(packages.directories.get(match[1]), (match[2] ?? '').replace(/^\//u, ''))));
        result = { target, kind: mapped ? (target ? 'pkg' : 'unresolved') : 'pkg-unexported' };
      }
    }
    cache.set(key, result);
    return result;
  };
}

function exportTables(byPath, resolve) {
  const local = new Map(), tables = new Map();
  for (const fact of byPath.values()) {
    const table = new Map();
    for (const entry of fact.exports) {
      if (['reexport', 'exportAll', 'exportNs'].includes(entry.kind)) continue;
      if (entry.kind === 'exportLocal' && fact.importBindings[entry.local]) continue;
      table.set(entry.name, entry);
    }
    local.set(fact.path, table);
  }
  const target = (module, spec) => { const found = resolve(module, spec).target; return found && byPath.has(found) ? found : null; };
  function tableOf(module, stack = []) {
    if (tables.has(module)) return tables.get(module);
    if (stack.includes(module) || !byPath.has(module)) return new Map();
    const fact = byPath.get(module), table = new Map([...local.get(module).keys()].map(name => [name, [module, name]]));
    for (const entry of fact.exports) {
      const binding = entry.kind === 'exportLocal' ? fact.importBindings[entry.local] : undefined;
      const next = binding ? target(module, binding.spec) : entry.from ? (entry.kind === 'exportNs' ? resolve(module, entry.from).target : target(module, entry.from)) : null;
      if (!next) continue;
      if (binding) table.set(entry.name, binding.name === '*' ? [next, '*'] : tableOf(next, [...stack, module]).get(binding.name) ?? [next, binding.name]);
      else if (entry.kind === 'reexport') table.set(entry.name, tableOf(next, [...stack, module]).get(entry.local) ?? [next, entry.local]);
      else if (entry.kind === 'exportNs') table.set(entry.name, [next, '*']);
      else if (entry.kind === 'exportAll') {
        for (const [name, origin] of tableOf(next, [...stack, module])) if (name !== 'default' && !table.has(name)) table.set(name, origin);
      }
    }
    tables.set(module, table);
    return table;
  }
  return { local, tableOf };
}

function markUses(facts, byPath, resolve, tables) {
  const usedOrigin = new Map(), wholeModule = new Map(), referenced = new Map(), wholeModuleUses = [], unresolved = [];
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  const mark = (target, name, importer) => {
    const origin = tables.tableOf(target).get(name);
    if (origin?.[1] === '*') add(wholeModule, origin[0], importer);
    const [module, exported] = origin ?? [target, name];
    add(usedOrigin, `${module}#${exported}`, importer);
  };
  for (const fact of facts) {
    for (const record of fact.imports) {
      if (isDirectoryBase(record)) {
        if (leavesWorkspace(fact.path, record.spec) && fact.cls !== 'tool') unresolved.push({ path: fact.path, line: record.line, spec: record.spec, kind: record.kind });
        continue;
      }
      const { target, kind } = resolve(fact.path, record.spec);
      if (kind === 'unresolved' && fact.cls !== 'tool') unresolved.push({ path: fact.path, line: record.line, spec: record.spec, kind: record.kind });
      if (!target) continue;
      add(referenced, target, fact.path);
      if (!byPath.has(target)) continue;
      const accessed = record.ns ? Object.keys(fact.nsAccess[record.ns] ?? {}) : [];
      if (record.kind === 'import' || (record.kind === 'dynamic' && !record.dynamicAll)) {
        for (const name of record.names) mark(target, name.imported, fact.path);
        if (record.def) mark(target, 'default', fact.path);
        if (record.ns && accessed.length > 0) for (const name of accessed) mark(target, name, fact.path);
        // A type-only namespace without named members (`typeof ns`) is the audit's `typeof import(spec)`: a reference.
        else if (record.ns && !record.typeOnly) {
          add(wholeModule, target, fact.path);
          // analyze.py also lists `const ns = await import(x)` without member access in dynamicAllImports.
          if (record.kind === 'dynamic') wholeModuleUses.push({ path: fact.path, line: record.line, spec: record.spec, target });
        }
      } else if (record.kind === 'dynamic' || record.kind === 'require') {
        add(wholeModule, target, fact.path);
        wholeModuleUses.push({ path: fact.path, line: record.line, spec: record.spec, target });
      }
      // reexport / export * / vi.mock / new URL / side-effect imports are references, not uses.
    }
  }
  for (const [module, importers] of wholeModule) {
    for (const [, origin] of tables.tableOf(module)) for (const importer of importers) add(usedOrigin, `${origin[0]}#${origin[1]}`, importer);
  }
  return { usedOrigin, referenced, wholeModuleUses, unresolved };
}

function isTestLike(fact) {
  if (!fact) return false;
  if (fact.cls === 'config') return path.posix.basename(fact.path).includes('vitest') || fact.path.startsWith('e2e/');
  return ['test', 'e2e-spec', 'e2e-support'].includes(fact.cls) || fact.path.includes('/integration/');
}

/** Read source text only. An optional complete virtual filesystem supports pure fixtures. */
export function inspectUnusedExports(rootDir, virtualFiles) {
  const root = path.resolve(rootDir);
  const names = virtualFiles ? [...virtualFiles.keys()].sort() : filesystemSources(root);
  const read = name => virtualFiles ? virtualFiles.get(name) : fs.readFileSync(path.join(root, name), 'utf8');
  const all = new Set(names);
  // Assets (docs/*.json, *.md, *.wasm under node_modules, runtime/assets/*.py read with ?raw) live outside the walked
  // source roots. On the real filesystem an asset resolves when the file exists inside the workspace. A code module must
  // still be part of the inventory, so a missing or build-output-only module stays unresolved.
  // The real path must also stay inside the real workspace, so a symlink or junction cannot admit a file from elsewhere
  // (pnpm links node_modules packages into the workspace's own node_modules/.pnpm, which stays accepted).
  const assets = new Map();
  let realRoot;
  const assetExists = name => {
    if (virtualFiles || CODE.test(name) || name === '..' || name.startsWith('../') || path.posix.isAbsolute(name)) return false;
    if (!assets.has(name)) {
      const absolute = path.join(root, name);
      let inside = false;
      if (fs.statSync(absolute, { throwIfNoEntry: false })?.isFile() === true) {
        realRoot ??= fs.realpathSync.native(root);
        const relative = path.relative(realRoot, fs.realpathSync.native(absolute));
        inside = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      }
      assets.set(name, inside);
    }
    return assets.get(name);
  };
  const fileExists = name => all.has(name) || assetExists(name);
  const facts = names.filter(isInventorySource).map(name => collectExportFacts(name, read(name)));
  const byPath = new Map(facts.map(fact => [fact.path, fact]));
  const packages = readPackageExports(names, read);
  const resolve = createResolver(byPath, fileExists, packages);
  const tables = exportTables(byPath, resolve);
  const uses = markUses(facts, byPath, resolve, tables);
  const urlTargets = new Set(facts.flatMap(fact => fact.imports.filter(record => (record.kind === 'url' && !isDirectoryBase(record)) || record.spec.includes('?worker'))
    .map(record => resolve(fact.path, record.spec).target).filter(Boolean)));
  const dead = [], internalOnly = [], testOnly = [], orphanModules = [];
  const publicEntries = new Set([...packages.exportsByName.values()].flatMap(table => [...table.values()]));
  for (const fact of facts) {
    if (fact.cls !== 'product' || !PRODUCT_ROOTS.includes(fact.path.split('/')[0]) || urlTargets.has(fact.path)) continue;
    for (const [name, entry] of tables.local.get(fact.path)) {
      const users = [...(uses.usedOrigin.get(`${fact.path}#${name}`) ?? [])].filter(user => user !== fact.path);
      const row = { key: `${fact.path}#${name}`, path: fact.path, line: entry.line, name, kind: entry.kind, typeOnly: entry.typeOnly };
      if (users.length === 0) ((name !== 'default' && fact.idRefs[entry.local ?? name] > 0) ? internalOnly : dead).push(row);
      else if (users.every(user => isTestLike(byPath.get(user)))) testOnly.push({ ...row, users: users.length });
    }
    const referenced = [...(uses.referenced.get(fact.path) ?? [])].some(user => user !== fact.path);
    if (!referenced && !publicEntries.has(fact.path) && !ENTRY_PATTERNS.some(pattern => pattern.test(fact.path))) orphanModules.push(fact.path);
  }
  const byKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  return { files: facts.length, dead: dead.sort(byKey), internalOnly: internalOnly.sort(byKey), testOnly: testOnly.sort(byKey),
    orphanModules: orphanModules.sort(), unresolved: uses.unresolved, wholeModuleUses: uses.wholeModuleUses };
}

/** Rows whose key is not in the accepted baseline list. */
export function newUnusedExports(rows, baselineKeys) {
  const accepted = new Set(baselineKeys);
  return rows.filter(row => !accepted.has(row.key));
}
