import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const slash = (value) => value.replaceAll('\\', '/');
const code = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/u;
// The audit's product classification and generated/declaration exclusions.
export function isRuntimeProductSource(name) {
  return /^(?:packages|apps)\//u.test(name) && code.test(name)
    && !/^packages\/fem\/runtime\/assets\//u.test(name)
    && !/(?:^|\/)(?:dist|node_modules)\//u.test(name) && !/\.d\.(?:ts|mts|cts)$/u.test(name)
    && !/\.test\.(?:ts|tsx|mts|mjs)$/u.test(name) && !/\.spec\.ts$/u.test(name)
    && !/\.selftest\./u.test(name) && !/\.config\.(?:ts|mts|mjs|js)$/u.test(name)
    && !/(?:^|\/)integration\//u.test(name) && !/vitest\./u.test(name);
}

function collect(root) {
  const files = new Map();
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'dist' && entry.name !== 'node_modules' && name !== 'packages/fem/runtime/assets') walk(name);
      } else if (entry.isFile() && isRuntimeProductSource(name)) files.set(name, fs.readFileSync(path.join(root, name), 'utf8'));
    }
  }
  for (const parent of ['packages', 'apps']) if (fs.existsSync(path.join(root, parent))) walk(parent);
  return files;
}

function runtimeTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(runtimeTarget).find(Boolean);
  if (value && typeof value === 'object') {
    for (const [condition, target] of Object.entries(value)) {
      if (['import', 'node', 'default'].includes(condition)) {
        const result = runtimeTarget(target); if (result) return result;
      }
    }
  }
  return undefined;
}

/** Read source text only. An optional complete virtual filesystem supports pure fixtures. */
export function inspectRuntimeCycles(rootDir, virtualFiles) {
  const root = path.resolve(rootDir), sources = virtualFiles ?? collect(root);
  const absolute = (name) => path.resolve(root, name);
  const identity = (name) => ts.sys.useCaseSensitiveFileNames ? slash(absolute(name)) : slash(absolute(name)).toLowerCase();
  const virtual = virtualFiles && new Map([...virtualFiles].map(([name, text]) => [identity(name), text]));
  const readFile = (name) => virtual ? virtual.get(identity(name)) : ts.sys.readFile(name);
  const fileExists = (name) => virtual ? virtual.has(identity(name)) : ts.sys.fileExists(name);
  const directoryExists = (name) => virtual ? [...virtual.keys()].some(key => key.startsWith(`${identity(name)}/`)) : ts.sys.directoryExists(name);
  const host = { readFile, fileExists, directoryExists, getCurrentDirectory: () => root };
  const packageFiles = virtualFiles ? [...virtualFiles.keys()].filter(name => /^(?:packages|apps)\/[^/]+\/package\.json$/u.test(name))
    : ['packages', 'apps'].flatMap(parent => fs.existsSync(absolute(parent)) ? fs.readdirSync(absolute(parent)).map(name => `${parent}/${name}/package.json`).filter(fileExists) : []);
  const runtimePaths = {};
  for (const file of packageFiles.sort()) {
    const pkg = JSON.parse(readFile(absolute(file))), directory = path.dirname(absolute(file));
    if (typeof pkg.name !== 'string') continue;
    const entries = pkg.exports && typeof pkg.exports === 'object' && Object.keys(pkg.exports).some(key => key.startsWith('.'))
      ? Object.entries(pkg.exports) : [['.', pkg.exports ?? pkg.main]];
    for (const [subpath, entry] of entries) {
      const target = runtimeTarget(entry);
      if (target) runtimePaths[pkg.name + (subpath === '.' ? '' : subpath.slice(1))] = [path.resolve(directory, target)];
    }
  }
  const configs = new Map(), diagnostics = [], graph = new Map(), sourceHashes = {};
  const names = [...sources.keys()].filter(isRuntimeProductSource).sort();
  const byIdentity = new Map(names.map(name => [identity(name), name]));
  function optionsFor(name) {
    const config = ts.findConfigFile(path.dirname(absolute(name)), fileExists);
    const key = config ?? root;
    if (!configs.has(key)) {
      let options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
      if (config) {
        const loaded = ts.readConfigFile(config, readFile);
        if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
        const parsed = ts.parseJsonConfigFileContent({ ...loaded.config, files: [absolute(name)], include: [], exclude: [] },
          { ...host, readDirectory: () => [], useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames }, path.dirname(config), {}, config);
        if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
        options = parsed.options;
      }
      configs.set(key, { ...options, baseUrl: options.baseUrl ?? root, paths: { ...options.paths, ...runtimePaths } });
    }
    return configs.get(key);
  }
  for (const name of names) {
    const text = sources.get(name), source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true), targets = new Set();
    sourceHashes[name] = createHash('sha256').update(text).digest('hex');
    graph.set(name, targets);
    for (const statement of source.statements) {
      let specifier;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        const bindings = clause?.namedBindings;
        if (clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)) continue;
        specifier = statement.moduleSpecifier;
      } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference)) {
        specifier = statement.moduleReference.expression;
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly || statement.exportClause && ts.isNamedExports(statement.exportClause)
          && statement.exportClause.elements.length > 0 && statement.exportClause.elements.every(element => element.isTypeOnly)) continue;
        specifier = statement.moduleSpecifier;
      }
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const spec = specifier.text.split('?')[0], internal = spec.startsWith('.') || spec.startsWith('@pointercad/');
      const exported = Object.keys(runtimePaths).some(key => key === spec || key.includes('*')
        && spec.startsWith(key.split('*')[0]) && spec.endsWith(key.split('*')[1]));
      if (spec.startsWith('@pointercad/') && !exported) {
        diagnostics.push(`${name}:${source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1}: unresolved internal runtime export ${specifier.text}`);
        continue;
      }
      const result = ts.resolveModuleName(spec, absolute(name), optionsFor(name), host).resolvedModule;
      if (!result) {
        const exportedAsset = (runtimePaths[spec] ?? []).some(target => !code.test(target) && fileExists(target));
        if (internal && !exportedAsset && !fileExists(path.resolve(path.dirname(absolute(name)), spec))) diagnostics.push(`${name}:${source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1}: unresolved internal runtime import ${specifier.text}`);
        continue;
      }
      if (/\.d\.(?:ts|mts|cts)$/u.test(result.resolvedFileName) || slash(result.resolvedFileName).includes('/node_modules/')) continue;
      const target = byIdentity.get(identity(result.resolvedFileName));
      if (target) targets.add(target);
    }
  }
  const indices = new Map(), low = new Map(), active = new Set(), stack = [], cycles = [];
  function visit(name) {
    indices.set(name, indices.size); low.set(name, indices.get(name)); active.add(name); stack.push(name);
    for (const target of [...graph.get(name)].sort()) {
      if (!indices.has(target)) { visit(target); low.set(name, Math.min(low.get(name), low.get(target))); }
      else if (active.has(target)) low.set(name, Math.min(low.get(name), indices.get(target)));
    }
    if (low.get(name) === indices.get(name)) {
      const component = []; let target;
      do { target = stack.pop(); active.delete(target); component.push(target); } while (target !== name);
      if (component.length > 1 || graph.get(name).has(name)) cycles.push(component.sort());
    }
  }
  for (const name of names) if (!indices.has(name)) visit(name);
  cycles.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const edges = names.flatMap(name => [...graph.get(name)].sort().map(target => [name, target]));
  return { files: names, sourceHashes, edges, cycles, diagnostics: diagnostics.sort(), ok: cycles.length === 0 && diagnostics.length === 0 };
}

export function formatRuntimeCycleDiagnostics(result) {
  return [...result.diagnostics, ...result.cycles.map(component => `runtime import cycle group: ${component.join(', ')}`)].join('\n');
}
